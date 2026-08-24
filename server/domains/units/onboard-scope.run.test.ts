import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { provisionDnsStep, deleteBuildRbacCleanup } from "./onboard-steps.ts";
import { OnboardParams, type OnboardPorts, type DeployableOnboardParams } from "./onboard.run.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { renderBuildRbac } from "./build-rbac.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// The SCOPE half of onboard — what an onboard of a SECOND stage may and may not do to the stage that is
// already live. Split from onboard.run.test.ts, whose fixtures are all single-stage (the same split
// offboard-scope.run.test.ts makes). Two decisions live here, and both are read at the moment they are
// made rather than assumed:
//   - provision-dns refuses a host that already answers with another cluster's address. The unit's host
//     <name>.<unitApex> carries no stage, and install.sh defaults a cluster's apex to its FQDN minus the
//     first label, so two clusters in one zone compose ONE host for a unit. Overwriting it would take
//     the live stage's address away — and upsertRecord reports that as "updated in place".
//   - the abort cleanup of provision-build-rbac keeps the two `<name>-build` grants while another stage
//     stands. They are the UNIT's, one pair per unit, and the apply this cleanup inverts REPLACED the
//     pair the earlier stage created, so deleting them would leave that stage's EventListener unable to
//     create its release PipelineRun.
// Both steps are built in isolation (the factories, not the whole chain), so the harness stays small.

const SHA = "a".repeat(40);
const REPO = "https://github.com/x/acme.git";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

/** acme onboarding to prod on s1.example, whose apex is example.com — so its host is
 *  acme.example.com, the same host any other cluster under that apex would compose. */
function params(over: Partial<OnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: REPO, owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    report: { contractVersion: "1.3", runnerVersion: "t", repoURL: REPO, requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  });
}

/** s1 carries prod (the stage being onboarded), s2 carries dev (the stage that is already
 *  live) — a cluster carries exactly one stage, so a unit's two stages never share one. */
const twoStageClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: cluster === "s2" ? "dev" : "prod" });

/** Commit acme at dev on s2 — the standing stage every test here onboards a second stage beside. */
async function seedDevStage(reg: Registrations): Promise<void> {
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: REPO, suspended: false, quiesced: false },
    builds: ["acme-api"],
    deploy: { stage: "dev", cluster: "s2", chartPath: "deploy/chart", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb_dev",
  });
}

function resolver(): FakeClusterKubeResolver {
  return new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
    argoReader: new FakeMasterArgoReader(),
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: "argocd",
  });
}

function ctx(stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_onb", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("onboard scope — a second stage beside a live one", () => {
  it("provision-dns REFUSES a host another cluster already answers, and leaves that address alone", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("s1.example", "A", "203.0.113.10"); // this cluster's own address
    dns.seed("acme.example.com", "A", "203.0.113.20"); // the live stage's, under the shared apex
    const step = provisionDnsStep({ dns } as unknown as OnboardPorts, params() as DeployableOnboardParams);
    await expect(step.run(ctx("provision-dns", []))).rejects.toThrow(/already answers with 203\.0\.113\.20/);
    expect(dns.record("acme.example.com", "A")).toBe("203.0.113.20"); // untouched
  });

  it("provision-dns is idempotent over its OWN record — the same address is a re-run, not a takeover", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("s1.example", "A", "203.0.113.10");
    dns.seed("acme.example.com", "A", "203.0.113.10"); // what a previous pass of this same step wrote
    const step = provisionDnsStep({ dns } as unknown as OnboardPorts, params() as DeployableOnboardParams);
    await expect(step.run(ctx("provision-dns", []))).resolves.toBeUndefined();
    expect(dns.record("acme.example.com", "A")).toBe("203.0.113.10");
  });

  it("the abort cleanup keeps the unit's build-namespace grants while another stage stands, and takes only this stage's argo-sync", async () => {
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedDevStage(reg);
    // The grants as dev's onboard left them; this run's provision-build-rbac REPLACED the acme-build
    // pair rather than creating it, so those two objects are not this run's to take back.
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac(renderBuildRbac({ name: "acme", argoNamespace: "argocd" }));
    const logs: string[] = [];
    const cleanup = deleteBuildRbacCleanup({ registrations: reg, resolver: resolver(), buildRbac } as unknown as OnboardPorts, params());
    await cleanup.run(ctx("delete-build-rbac", logs));
    expect(buildRbac.get("Role", "acme-build", "acme-build-eventlistener")).toBeTruthy();
    expect(buildRbac.get("RoleBinding", "acme-build", "acme-build-manager-read")).toBeTruthy();
    expect(buildRbac.get("Role", "argocd", "acme-argo-sync")).toBeUndefined(); // this stage's own
    expect(logs.some((l) => l.includes("the build-namespace grants for acme kept") && l.includes("dev"))).toBe(true);
  });

  it("the abort cleanup takes ALL of the grants when the unit stands at no other stage", async () => {
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage); // an empty tree
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac(renderBuildRbac({ name: "acme", argoNamespace: "argocd" }));
    const cleanup = deleteBuildRbacCleanup({ registrations: reg, resolver: resolver(), buildRbac } as unknown as OnboardPorts, params());
    await cleanup.run(ctx("delete-build-rbac", []));
    expect(buildRbac.get("Role", "acme-build", "acme-build-eventlistener")).toBeUndefined();
    expect(buildRbac.get("Role", "argocd", "acme-argo-sync")).toBeUndefined();
  });
});
