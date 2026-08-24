import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { makeOnboardDef, OnboardParams, DeployableOnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { VaultSeeder } from "./vault-seeder.ts";

// The check step's DRIFT BELT (onboard-check.ts): the gates re-run at the current default-branch
// head, and the facts the approval froze — builds, databases, services, fqdn, secret specs,
// activation — must still be what the head declares, or the run would commit facts nobody approved:
// the registration fields, the create-only Vault seed (cas=0, permanent), and the endpoint the
// seed-minted bootstrap token is sent to. Each case here approves ONE set of facts and scripts the
// runner to answer with a moved manifest. The fqdn leg's test lives with its feature
// (onboard-fqdn.run.test.ts); this file follows the same dedicated-sibling pattern so
// onboard.run.test.ts stays within the file-size doctrine.

const SHA = "a".repeat(40);

const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
const CHART_PINS = 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0"\n';

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function passReport(manifest: ConsumerManifest = MANIFEST): GateReport {
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** The platform repo with the target's values chain — check re-reads it so the chart is held against
 *  what the Application will actually layer at sync. */
function platformRepo(): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed("s1.example", "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed("s1.example", `platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  repo.seed("s1.example", "installation/profile.yaml", "global:\n  unitApex: example.com\n");
  return repo;
}

/** Only the ports the check step reaches: the gates (repo/runner/registrations). Nothing else is wired —
 *  the step mutates nothing. */
function ports(over: Partial<OnboardPorts> = {}): OnboardPorts {
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registrations: new Registrations(platformRepo(), prodClusterStage),
    seeder: {} as unknown as VaultSeeder,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    platformRepoURL: "https://github.com/x/hostyour-cloud.git",
    tenantSubdomains: async () => [],
    attestListening: true,
    argoWatchTimeoutMs: 1000,
    releaseWorkflowTimeoutMs: 200,
    releaseBuildTimeoutMs: 200,
    resolveBuildPlaneFqdn: async () => "s1.example",
    ...over,
  };
}

function params(over: Partial<DeployableOnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    repoCredentialId: "cred_pat", version: "1.0.0", channel: "stable", resolvedSha: SHA,
    builds: ["acme-api"], form: "deployable", stage: "prod", domain: "s1.example",
    clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    chartPath: "deploy/chart", argoAppName: "acme-prod", report: passReport(),
    ...over,
  });
}

function ctx(p: OnboardParams): StepCtx {
  return {
    runId: "run_chk", stepName: "check", db: db.db, params: p,
    creds: { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const checkStep = (prt: OnboardPorts, p: OnboardParams) => makeOnboardDef(prt).steps(p).find((s) => s.name === "check")!;

describe("onboard check step — the drift belt against the current head", () => {
  it("refuses the run when the repo's builds changed since the approval froze them", async () => {
    // The gates themselves pass at the current head (the repo still declares + pins acme-api), but
    // the APPROVED facts named a different build — the registration would commit facts nobody
    // approved, so the check refuses instead of writing them.
    const p = params({ builds: ["acme-worker"] });
    await expect(checkStep(ports(), p).run(ctx(p))).rejects.toThrow(/changed since this plan was approved/);
  });

  it("refuses the run when the repo's declared secrets changed since the approval froze them", async () => {
    // seed-secrets writes ONE create-only Vault entry from the FROZEN specs. A key the manifest
    // gained between approve and execute would otherwise be silently absent from that permanent
    // entry: the chart rendered from the current head waits on an ExternalSecret that never goes
    // Ready, and every later onboard finds the entry present and fails identically.
    const head: ConsumerManifest = { ...MANIFEST, secrets: [{ key: "APP_KEY", required: true, generate: "hex32" }] };
    const prt = ports({ runner: new FakeGateRunner({ report: passReport(head) }) });
    const p = params(); // approved with NO secret specs
    await expect(checkStep(prt, p).run(ctx(p))).rejects.toThrow(/secrets changed since approval/);
  });

  it("refuses the run when the repo gained an activation block since the approval", async () => {
    // The activate step sends the seed-minted bootstrap token to the manifest-declared endpoint. A
    // block added after approval would hand that token to a call nobody saw in the plan — and would
    // do it silently, since the frozen params carry no activate step to make the change visible.
    const secrets = [{ key: "AUTH_BOOTSTRAP_TOKEN", required: true, generate: "hex32" as const }];
    const head: ConsumerManifest = {
      ...MANIFEST,
      secrets,
      activation: { path: "/api/v1/bootstrap/invite-admin", method: "POST", tokenSecret: "AUTH_BOOTSTRAP_TOKEN", tokenHeader: "X-Bootstrap-Token", prompt: [] },
    };
    const prt = ports({ runner: new FakeGateRunner({ report: passReport(head) }) });
    const p = params({ secretSpecs: secrets }); // the secrets match — only the activation moved
    const err = await checkStep(prt, p).run(ctx(p)).then(() => null, (e: unknown) => String(e));
    expect(err).toMatch(/activation changed since approval/);
    expect(err).not.toMatch(/secrets changed/);
  });
});
