import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { provisionDnsStep, deleteSmtpOpsGrantCleanup } from "./onboard-steps.ts";
import { OnboardParams, type OnboardPorts, type DeployableOnboardParams } from "./onboard.run.ts";
import { Registrations } from "./registrations.ts";
import { renderSmtpOpsGrant } from "./build-rbac.ts";
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
//     is <name>-<stage>.<unitApex>, and install.sh defaults a cluster's apex to its FQDN minus the first
//     label, so two clusters in one zone compose ONE host for a unit at one stage. Overwriting it would
//     take the standing record's address away — and upsertRecord reports that as "updated in place".
//   - the abort cleanup of provision-smtp-ops-grant takes THIS stage's grant and no other. The grant is
//     <name>-<stage>-smtp-ops, one pair per stage, so the other stage's pair is not this run's to touch.
// Both steps are built in isolation (the factories, not the whole chain), so the harness stays small.

const SHA = "a".repeat(40);
const REPO = "https://github.com/x/acme.git";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

/** acme onboarding to prod on s1.example, whose apex is example.com — so its host is
 *  acme-prod.example.com, the same host any other cluster under that apex would compose for prod. */
function params(over: Partial<OnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: REPO, owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme-prod", unitApex: "example.com",
    report: { contractVersion: "1.5", runnerVersion: "t", repoURL: REPO, requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  });
}

/** The same unit, claiming the one service the Manager still writes a grant for. */
function smtpOpsParams(): DeployableOnboardParams {
  return params({ services: ["smtp-ops"] }) as DeployableOnboardParams;
}

/** Commit acme at dev on s2 — the standing stage every test here onboards a second stage beside. */
async function seedDevStage(reg: Registrations): Promise<void> {
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: REPO, suspended: false, quiesced: false },
    builds: ["acme-api"],
    deploy: { stage: "dev", cluster: "s2", chartPath: "deploy/chart", databases: [], keyPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
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
    dns.seed("acme-prod.example.com", "A", "203.0.113.20"); // the same stage on another cluster, under the shared apex
    const step = provisionDnsStep({ dns } as unknown as OnboardPorts, params() as DeployableOnboardParams);
    await expect(step.run(ctx("provision-dns", []))).rejects.toThrow(/already answers with 203\.0\.113\.20/);
    expect(dns.record("acme-prod.example.com", "A")).toBe("203.0.113.20"); // untouched
  });

  it("provision-dns is idempotent over its OWN record — the same address is a re-run, not a takeover", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("s1.example", "A", "203.0.113.10");
    dns.seed("acme-prod.example.com", "A", "203.0.113.10"); // what a previous pass of this same step wrote
    const step = provisionDnsStep({ dns } as unknown as OnboardPorts, params() as DeployableOnboardParams);
    await expect(step.run(ctx("provision-dns", []))).resolves.toBeUndefined();
    expect(dns.record("acme-prod.example.com", "A")).toBe("203.0.113.10");
  });

  it("the abort cleanup takes THIS stage's mail-ops grant and leaves the other stage's standing", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await seedDevStage(reg);
    // Both stages' grants, as the two onboards left them: one pair per stage, each named for its stage.
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme", stage: "dev" }), renderSmtpOpsGrant({ name: "acme", stage: "prod" })]);
    const logs: string[] = [];
    const cleanup = deleteSmtpOpsGrantCleanup({ registrations: reg, resolver: resolver(), buildRbac } as unknown as OnboardPorts, smtpOpsParams());
    await cleanup.run(ctx("delete-smtp-ops-grant", logs));
    expect(buildRbac.get("Role", "postfix", "acme-prod-smtp-ops")).toBeUndefined();
    expect(buildRbac.get("Role", "postfix", "acme-dev-smtp-ops")).toBeTruthy();
    expect(buildRbac.get("RoleBinding", "postfix", "acme-dev-smtp-ops")).toBeTruthy();
    expect(logs.some((l) => l.includes("mail-ops grant for acme at prod deleted"))).toBe(true);
  });

  it("the abort cleanup is idempotent — an absent grant is reported, never an error", async () => {
    const reg = new Registrations(new FakePlatformRepo()); // an empty tree
    const buildRbac = new FakeBuildRbacWriter();
    const logs: string[] = [];
    const cleanup = deleteSmtpOpsGrantCleanup({ registrations: reg, resolver: resolver(), buildRbac } as unknown as OnboardPorts, smtpOpsParams());
    await cleanup.run(ctx("delete-smtp-ops-grant", logs));
    expect(buildRbac.keys()).toEqual([]);
    expect(logs.some((l) => l.includes("already absent"))).toBe(true);
  });

  // A unit that claims nothing never had one, and the cleanup says so instead of reading a tree.
  it("the abort cleanup writes nothing back for a unit that never claimed smtp-ops", async () => {
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme", stage: "prod" })]);
    const logs: string[] = [];
    const cleanup = deleteSmtpOpsGrantCleanup({ buildRbac } as unknown as OnboardPorts, params() as DeployableOnboardParams);
    await cleanup.run(ctx("delete-smtp-ops-grant", logs));
    expect(buildRbac.keys()).toHaveLength(2);
    expect(logs.some((l) => l.includes("claims no smtp-ops"))).toBe(true);
  });
});
