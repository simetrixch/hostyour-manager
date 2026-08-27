import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
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
import { clusterMapPath } from "../../../shared/cluster-values.ts";

// The declare-and-attest path of the manifest's extra FQDN at RUN level: planStream freezes the
// G19-checked declaration into params (and rejects a name the platform already serves),
// write-registration commits the ATTEST into the stage file, apply-admission-policy admits the
// attested value beside the platform address, and check refuses a declaration that moved after the
// approval. The gate's own unit checks live in gates/compose.test.ts; this file follows the
// onboard-activate.run.test.ts pattern (a dedicated file per step concern) so onboard.run.test.ts
// stays within the file-size doctrine.

const SHA = "a".repeat(40);
const FQDN = "shop.example.org";

const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
  fqdn: FQDN,
};
const CHART_PINS = 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0"\n';

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-registration resolves the unit's ceiling against it. Seeding here is
// what a running Manager has done long before an onboard reaches it; without it the run fails at
// exactly that step, which is the correct behaviour and not what these tests are about.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(manifest: ConsumerManifest = MANIFEST): GateReport {
  return {
    contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** The platform repo with the target's values chain — its profile states the unitApex G19 holds a
 *  declared fqdn's suffix against, and planStream composes the platform address from. */
function platformRepo(): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed("s1.example", "clusters/platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed("s1.example", `clusters/platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  repo.seed("s1.example", clusterMapPath("s1.example"), "global:\n  unitApex: example.com\n");
  return repo;
}

/** Only the ports the steps under test reach: the gates (repo/runner/registrations), the registration
 *  writer (registrations) and the admission-policy apply (resolver). The release-cycle ports stay unwired
 *  — none of these steps touches them. */
function ports(over: Partial<OnboardPorts> & { cluster?: FakeClusterReader } = {}): OnboardPorts {
  const { cluster, ...portOver } = over;
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registrations: new Registrations(platformRepo(), prodClusterStage),
    seeder: {} as unknown as VaultSeeder, // none of the steps under test seeds
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader(),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    platformRepoURL: "https://github.com/x/hostyour-cloud.git",
    tenantSubdomains: async () => [],
    declareListening: true,
    argoWatchTimeoutMs: 1000,
    releaseWorkflowTimeoutMs: 200,
    releaseBuildTimeoutMs: 200,
    resolveBuildPlaneFqdn: async () => "s1.example",
    ...portOver,
  };
}

function params(over: Partial<DeployableOnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    repoCredentialId: "cred_pat", version: "1.0.0", channel: "stable", resolvedSha: SHA,
    builds: ["acme-api"], form: "deployable", stage: "prod", domain: "s1.example",
    clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    chartPath: "deploy/chart", argoAppName: "acme-prod", report: passReport(), fqdn: FQDN,
    ...over,
  });
}

function ctx(p: OnboardParams, stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_fqdn", stepName, db: db.db, params: p,
    creds: { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

const planReq = {
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable",
  clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat",
} as const;
const streamCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

describe("onboard with a manifest-declared fqdn", () => {
  it("planStream freezes the G19-checked fqdn into params, and the plan the operator approves names the grant", async () => {
    seedCluster();
    const res = await makeOnboardDef(ports()).planStream!(planReq, streamCtx());
    expect(res.outcome).toBe("planned");
    if (res.outcome !== "planned") return;
    if (res.params.form !== "deployable") return;
    expect(res.params.fqdn).toBe(FQDN);
    // approving IS the grant, so the plan says what is being attested and beside which address
    expect(res.plan.summary).toContain(FQDN);
    expect(res.plan.summary).toContain("acme.example.com");
  });

  it("planStream REJECTS a fqdn another unit has attested — G19 through the real registration tree", async () => {
    seedCluster();
    const prt = ports();
    await prt.registrations.commitRegistration({
      unit: { name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false },
      builds: [],
      deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"), fqdn: FQDN },
      runId: "run_0",
    });
    const res = await makeOnboardDef(prt).planStream!(planReq, streamCtx());
    expect(res).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("G19") });
  });

  it("write-registration ATTESTS the fqdn into the stage file, and apply-admission-policy admits it beside the platform address", async () => {
    seedCluster();
    const cluster = new FakeClusterReader();
    const prt = ports({ cluster });
    const p = params();
    const steps = makeOnboardDef(prt).steps(p);
    await steps.find((s) => s.name === "write-registration")!.run(ctx(p, "write-registration", []));
    expect((await prt.registrations.readRegistration("prod", "acme"))?.entry.fqdn).toBe(FQDN);

    const logs: string[] = [];
    await steps.find((s) => s.name === "apply-admission-policy")!.run(ctx(p, "apply-admission-policy", logs));
    const expr = cluster.admissionPolicies.get("consumer-acme")!.policy.spec.validations[0]!.expression;
    expect(expr).toContain(`r.host == 'acme.example.com' || r.host == '${FQDN}'`);
    expect(logs.some((l) => l.includes(`acme.example.com and ${FQDN}`))).toBe(true);
  });

  it("check refuses the run when the declared fqdn changed since the approval froze it", async () => {
    // The gates pass at the current head (the manifest's fqdn collides with nothing), but the
    // APPROVED params attested no fqdn — committing the manifest's would grant a name nobody saw.
    const p = params({ fqdn: undefined });
    const check = makeOnboardDef(ports()).steps(p).find((s) => s.name === "check")!;
    await expect(check.run(ctx(p, "check", []))).rejects.toThrow(/fqdn changed since approval/);
  });
});
