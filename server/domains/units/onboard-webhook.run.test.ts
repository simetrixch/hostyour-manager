import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { setupWebhookStep, removeWebhookCleanup, removeConsumerWebhook } from "./onboard-webhook.ts";
import { OnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { seedClusterMaps, BUILD_HOOK_URL } from "./cluster-map.fixture.ts";
import { Registrations } from "./registrations.ts";
import { buildPlaneFqdnFromMarkings } from "../inventory/cluster-marking.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// Focused tests for the onboard `setup-webhook` step + the removal it shares with offboard/purge (impl:
// onboard-webhook.ts). Kept apart from onboard.run.test.ts so each file stays within the per-file line
// budget (the onboard-activate pattern). The step is built in isolation (setupWebhookStep) — it only
// touches ports.github/webhookSecret/webhookSubdomain/resolveBuildPlaneFqdn + the sealed PAT, never the
// kube/vault clients, so the harness stays tiny. The removal takes fewer of those still: it matches the
// EventListener path and therefore names no host.
//
// The fixture is the case the platform allows and the old composition got wrong: the unit is onboarded
// to s1.example, whose map names a DIFFERENT cluster as its build plane (cluster-map.fixture.ts).
// The EventListener stands only on that other cluster, so every address below is the build plane's,
// never the unit's own target cluster's.
const SHA = "a".repeat(40);
const TARGET = BUILD_HOOK_URL;

const resolveBuildPlaneFqdn = seedClusterMaps(new FakePlatformRepo(), { "s1.example": "prod" });

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function params(over: Partial<OnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    // owner is the HUMAN/team owner "team-acme" — the step must use the GitHub org "x" from repoURL instead.
    form: "deployable", consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    report: { contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git", requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  });
}

/** A registration tree with NOTHING in it — the unit stands at no other stage, so the abort cleanup
 *  takes the unit's ONE hook. A test that needs the opposite commits a second stage into its own. */
const emptyRegistrations = new Registrations(new FakePlatformRepo(), () => Promise.resolve({ name: "s1", stage: "prod" }));

/** Build the step in isolation with only the webhook-relevant ports (the rest are never read). Each
 *  test passes exactly the keys it wants present (exactOptionalPropertyTypes forbids explicit
 *  `undefined`, so a "missing secret / unwired adapter" case omits the key rather than nulling it).
 *  The build-plane resolver is folded in by default and overridable by name, because every path that
 *  reaches the create needs an address; so is the registrations, which the abort cleanup reads. */
function step(ports: Record<string, unknown>): Step {
  return setupWebhookStep({ resolveBuildPlaneFqdn, registrations: emptyRegistrations, ...ports } as unknown as OnboardPorts, params());
}

function fixedCreds(bufOut?: (b: Buffer) => void): CredentialStore {
  return { open: () => { const b = Buffer.from("github_pat_secret", "utf8"); bufOut?.(b); return Promise.resolve(b); } } as unknown as CredentialStore;
}

function ctx(logs: string[], creds: CredentialStore = fixedCreds()): StepCtx {
  return {
    runId: "run_onb", stepName: "setup-webhook", db: db.db, creds, params: params(),
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("onboard setup-webhook step", () => {
  it("creates the push-hook on the GitHub org/repo (x/acme, NOT the human owner) at the BUILD PLANE, not the target cluster", async () => {
    const github = new FakeGitHubConsumer();
    const logs: string[] = [];
    await step({ github, webhookSecret: "hmac_test", webhookSubdomain: "build" }).run(ctx(logs));
    expect(github.created).toHaveLength(1);
    expect(github.created[0]).toMatchObject({
      owner: "x", repo: "acme", token: "github_pat_secret", targetUrl: TARGET,
      secret: "hmac_test", events: ["push"], contentType: "json",
    });
    // The unit deploys on s1.example, and its host appears nowhere: that cluster runs no
    // EventListener, so a hook there is delivered to something that creates no PipelineRun.
    expect(github.created[0]?.targetUrl).not.toContain("s1");
    expect(logs.some((l) => l.includes("build webhook created on x/acme") && l.includes(TARGET))).toBe(true);
  });

  it("reads the host out of the cluster map: another build-plane field, another address", async () => {
    const github = new FakeGitHubConsumer();
    const elsewhere = seedClusterMaps(new FakePlatformRepo(), { "s1.example": "prod" }, "build9.example");
    await setupWebhookStep({ github, webhookSecret: "hmac_test", webhookSubdomain: "build", resolveBuildPlaneFqdn: elsewhere } as unknown as OnboardPorts, params()).run(ctx([]));
    expect(github.created[0]?.targetUrl).toBe("https://build.build9.example/github");
  });

  it("FAILS LOUD when the target cluster has no map — the host cannot be named, and a guess is the silent no-build", async () => {
    const github = new FakeGitHubConsumer();
    const ports = { github, webhookSecret: "hmac_test", webhookSubdomain: "build", resolveBuildPlaneFqdn: buildPlaneFqdnFromMarkings(new FakePlatformRepo()) };
    await expect(setupWebhookStep(ports as unknown as OnboardPorts, params()).run(ctx([]))).rejects.toThrow(/no cluster map for "s1.example"/);
    expect(github.created).toHaveLength(0);
  });

  it("REPLACES a hook left at the target cluster by an earlier onboard instead of adding a second one", async () => {
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", "https://build.s1.example/github"); // the address before the host was read from the map
    const logs: string[] = [];
    await step({ github, webhookSecret: "hmac_test", webhookSubdomain: "build" }).run(ctx(logs));
    // ensureHook deletes every hook on the EventListener path whose host is not the current one, so a
    // repo carrying the old address ends with exactly ONE hook, at the build plane.
    expect(github.hooksFor("x", "acme").map((h) => h.targetUrl)).toEqual([TARGET]);
    expect(logs.some((l) => l.includes("1 stale EventListener hook(s) on old entry points removed"))).toBe(true);
  });

  it("is idempotent — an existing hook at the target URL is left as-is (created:false, no new create)", async () => {
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", TARGET); // a hook already there (e.g. a re-onboard)
    const logs: string[] = [];
    await step({ github, webhookSecret: "hmac_test", webhookSubdomain: "build" }).run(ctx(logs));
    expect(github.created).toHaveLength(0); // nothing NEW created
    expect(github.hooksFor("x", "acme")).toHaveLength(1); // still exactly one
    expect(logs.some((l) => l.includes("already present") && l.includes("idempotent"))).toBe(true);
  });

  it("FAILS LOUD when the consumer PAT lacks admin:repo_hook (WebhookScopeError → a clear ask)", async () => {
    const github = new FakeGitHubConsumer();
    github.scopeError = true;
    const ports = { github, webhookSecret: "hmac_test", webhookSubdomain: "build" };
    await expect(step(ports).run(ctx([]))).rejects.toThrow(/admin:repo_hook/);
    // no hook, no build: the message states it plainly
    await expect(step(ports).run(ctx([]))).rejects.toThrow(/no hook, no build/);
  });

  it("FAILS LOUD when GITHUB_WEBHOOK_SECRET is not configured (a hook with no matching secret never builds)", async () => {
    const github = new FakeGitHubConsumer();
    // The secret key is OMITTED (not set to undefined) — that is the "not configured" case.
    await expect(step({ github, webhookSubdomain: "build" }).run(ctx([]))).rejects.toThrow(/GITHUB_WEBHOOK_SECRET is not configured/);
    expect(github.created).toHaveLength(0); // never reached the create
  });

  it("FAILS LOUD when no webhook adapter is wired (never a silent skip — activation precedent)", async () => {
    // The webhook key is OMITTED — the unwired-adapter case.
    await expect(step({ webhookSecret: "hmac_test", webhookSubdomain: "build" }).run(ctx([]))).rejects.toThrow(/no hook . no build|webhook adapter but none is wired/);
  });

  it("never logs the PAT or the HMAC secret, and zeroes the PAT buffer after use", async () => {
    const github = new FakeGitHubConsumer();
    let patBuf: Buffer | undefined;
    const logs: string[] = [];
    await step({ github, webhookSecret: "hmac_test", webhookSubdomain: "build" }).run(ctx(logs, fixedCreds((b) => { patBuf = b; })));
    expect(patBuf && [...patBuf].every((byte) => byte === 0)).toBe(true); // zeroed after the call
    for (const l of logs) {
      expect(l).not.toContain("github_pat_secret");
      expect(l).not.toContain("hmac_test");
    }
    // The token + secret DID flow to the adapter (recorded there) — proving they were used, not logged.
    expect(github.created[0]?.secret).toBe("hmac_test");
    expect(github.created[0]?.token).toBe("github_pat_secret");
  });

  it("the abort cleanup removes the hook the step created — no orphan on a not-fully-onboarded consumer", async () => {
    // The inverse no longer rides on this step: write-registration arms the WHOLE ordered rollback
    // (onboard-abort.ts), removeWebhookCleanup included, so an abort at ANY later step removes the
    // hook. Here the pair is exercised directly: the step creates, the cleanup deletes.
    const github = new FakeGitHubConsumer();
    const prt = { github, webhookSecret: "hmac_test", webhookSubdomain: "build", resolveBuildPlaneFqdn, registrations: emptyRegistrations } as unknown as OnboardPorts;
    await setupWebhookStep(prt, params()).run(ctx([]));
    expect(github.hooksFor("x", "acme")).toHaveLength(1); // the hook was created
    await removeWebhookCleanup(prt, params()).run(ctx([]));
    expect(github.hooksFor("x", "acme")).toHaveLength(0);
    expect(github.deletedCalls).toHaveLength(1);
  });

  it("the abort cleanup KEEPS the hook while the unit stands at another stage — the repo carries only one", async () => {
    // acme is live at dev; this run onboards prod and is aborted. The hook is the UNIT's, and dev
    // releases through it, so the abort must leave it exactly where it is.
    const registrations = new Registrations(new FakePlatformRepo(), () => Promise.resolve({ name: "s2", stage: "dev" }));
    await registrations.commitRegistration({
      unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
      builds: ["acme"],
      deploy: { stage: "dev", cluster: "s2", chartPath: "deploy/chart", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
      runId: "run_onb_dev",
    });
    const github = new FakeGitHubConsumer();
    const logs: string[] = [];
    const prt = { github, webhookSecret: "hmac_test", webhookSubdomain: "build", resolveBuildPlaneFqdn, registrations } as unknown as OnboardPorts;
    await setupWebhookStep(prt, params()).run(ctx(logs));
    await removeWebhookCleanup(prt, params()).run(ctx(logs));
    expect(github.deletedCalls).toEqual([]);
    expect(github.hooksFor("x", "acme")).toHaveLength(1);
    expect(logs.some((l) => l.includes("the build webhook for acme kept") && l.includes("dev"))).toBe(true);
  });
});

/** The removal offboard and purge share. It composes no address at all: the hook is matched on the
 *  EventListener path, so a hook created while another cluster carried the build plane goes too. */
describe("removeConsumerWebhook (the offboard/purge inverse)", () => {
  const forUnit = (over: Record<string, unknown> = {}): Parameters<typeof removeConsumerWebhook>[1] => ({
    github: new FakeGitHubConsumer(), consumerName: "acme",
    repoURL: "https://github.com/x/acme.git", repoCredentialId: "cred_pat",
    ...over,
  }) as Parameters<typeof removeConsumerWebhook>[1];

  it("deletes the hook the create put at the build plane", async () => {
    const github = new FakeGitHubConsumer();
    await step({ github, webhookSecret: "hmac_test", webhookSubdomain: "build" }).run(ctx([]));
    const logs: string[] = [];
    await removeConsumerWebhook(ctx(logs), forUnit({ github }));
    expect(github.deletedCalls).toEqual([{ owner: "x", repo: "acme", token: "github_pat_secret", ids: [1] }]);
    expect(github.hooksFor("x", "acme")).toEqual([]);
    expect(logs.some((l) => l.includes("build webhook removed on x/acme") && l.includes(TARGET))).toBe(true);
  });

  it("deletes a hook standing at ANOTHER host — the build plane may have moved since it was created", async () => {
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", "https://build.old.example/github"); // an address nothing composes today
    github.seedHook("x", "acme", "https://ci.example/notify"); // not the platform's — must survive
    const logs: string[] = [];
    await removeConsumerWebhook(ctx(logs), forUnit({ github }));
    expect(github.hooksFor("x", "acme").map((h) => h.targetUrl)).toEqual(["https://ci.example/notify"]);
    expect(logs.some((l) => l.includes("build webhook removed on x/acme") && l.includes("https://build.old.example/github"))).toBe(true);
  });
});
