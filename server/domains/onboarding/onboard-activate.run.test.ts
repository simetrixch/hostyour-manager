import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, DeployableOnboardParams, type OnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import type { ConsumerActivation } from "../../../shared/consumer.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome } from "./vault-seeder.ts";

// Focused tests for the post-onboard `activate` step (impl: onboard-activate.ts). Kept apart from
// onboard.run.test.ts so each file stays within the per-file line budget; the harness below is a
// trimmed mirror of that file's.
const SHA = "a".repeat(40);

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// A example-auth-shaped activation: the seeded bootstrap token gates POST /api/v1/bootstrap/invite-admin
// over the consumer's own ingress; the operator supplies the admin email.
const AUTH_ACTIVATION: ConsumerActivation = {
  path: "/api/v1/bootstrap/invite-admin", method: "POST",
  tokenSecret: "AUTH_BOOTSTRAP_TOKEN", tokenHeader: "X-Bootstrap-Token",
  prompt: [{ field: "email", label: "First administrator email" }],
};
const BOOTSTRAP_SPEC = { key: "AUTH_BOOTSTRAP_TOKEN", required: true as const, generate: "hex32" as const };

// Every fixture onboards to the prod stage, so a fixed resolver answers every cluster with "prod" —
// the stage boundary Registry.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** A FakePlatformRepo whose cluster values chain carries `global.unitApex` — onboard's planStream
 *  resolves OnboardParams.unitApex from exactly this chain (admission-policy.ts unitApexFromChain),
 *  and the fake's own default chain does not state it. Seeded directly (not via fetchResetBranch) so
 *  the fake's lazy default-chain seed never overwrites it. */
function platformRepo(domain: string): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed(domain, "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed(domain, `platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  repo.seed(domain, "installation/profile.yaml", `global:\n  unitApex: example.com\n  endpoints:\n    vault:\n      url: https://vault.${domain}:8200\n`);
  return repo;
}

/** The chart's per-stage pin gate G18's chart half reads — the builds[] entry whose `image` is the
 *  build name, i.e. the key the release pipeline's bump task writes the tag into. */
const CHART_PINS = 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0-placeholder"\n';
/** One declared build, so gate G18's manifest half holds for every fixture. */
const BUILDS = [{ name: "acme-api", containerfile: "Containerfile" }];

function passReport(): GateReport {
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null,
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

// Records the seeded entry so a test can read the minted token; `created` toggles the create-only re-run.
class FakeSeeder implements VaultSeeder {
  seeded: VaultSeedInput[] = [];
  created = true;
  async seed(i: VaultSeedInput): Promise<VaultSeedOutcome> { this.seeded.push(i); return { created: this.created }; }
  async seedPostgres(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedMongodb(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteBuildRepoPat(): Promise<void> {}
  async deleteApp(): Promise<void> {}
  async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

function ports(over: Partial<OnboardPorts> = {}): OnboardPorts {
  const platform = platformRepo("s1.example");
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registry: new Registry(platform, prodClusterStage),
    resolveBuildPlaneFqdn: seedClusterMaps(platform, { "s1.example": "prod" }),
    seeder: new FakeSeeder(),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme-web", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    platformRepoURL: "https://github.com/x/hostyour-cloud.git",
    tenantSubdomains: async () => [],
    attestListening: true,
    argoWatchTimeoutMs: 1000,
    releaseWorkflowTimeoutMs: 100,
    releaseBuildTimeoutMs: 100,
    releasePollIntervalMs: 1,
    activator: new FakeActivator(),
    ...over,
  };
}

function params(over: Partial<DeployableOnboardParams> = {}): DeployableOnboardParams {
  return DeployableOnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", unitApex: "example.com",
    namespace: "acme",
    report: passReport(), argoAppName: "acme-prod", ...over,
  });
}

const fakeCreds: CredentialStore = { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore;

function ctx(p: OnboardParams, stepName: string, logs: string[], runSecrets: Record<string, string> = {}): StepCtx {
  return {
    runId: "run_onb", stepName, db: db.db, creds: fakeCreds, params: p,
    secrets: { get: (n: string) => (runSecrets[n] === undefined ? undefined : Buffer.from(runSecrets[n]!, "utf8")), wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

describe("onboard post-onboard activation step", () => {
  it("appends the `activate` step LAST only when the manifest declares activation (backward-compat)", () => {
    const plain = makeOnboardDef(ports()).steps(params()).map((s) => s.name);
    expect(plain).not.toContain("activate");
    expect(plain.at(-1)).toBe("record-inventory");
    const withAct = makeOnboardDef(ports()).steps(params({ activation: AUTH_ACTIVATION, secretSpecs: [BOOTSTRAP_SPEC] })).map((s) => s.name);
    expect(withAct.at(-1)).toBe("activate");
    expect(withAct.slice(0, -1)).toEqual(plain); // every earlier step is byte-for-byte the classic onboard
  });

  it("calls the declared endpoint with the seed-minted token + operator email and surfaces (never persists) the activate_url", async () => {
    const seeder = new FakeSeeder();
    const activator = new FakeActivator();
    const p = params({ activation: AUTH_ACTIVATION, secretSpecs: [BOOTSTRAP_SPEC] });
    // seed-secrets + activate MUST come from the SAME steps() array — they share the in-run token closure.
    const steps = makeOnboardDef(ports({ seeder, activator })).steps(p);
    const logs: string[] = [];
    await steps.find((s) => s.name === "seed-secrets")!.run(ctx(p, "seed-secrets", logs));
    await steps.find((s) => s.name === "activate")!.run(ctx(p, "activate", logs, { "activation-input:email": "admin@acme.test" }));

    expect(activator.calls).toHaveLength(1);
    const call = activator.calls[0]!;
    // The unit's ONE host, <name>.<unitApex> — the same composition the admission policy pins.
    expect(call.url).toBe("https://acme.example.com/api/v1/bootstrap/invite-admin");
    expect(call.method).toBe("POST");
    expect(call.tokenHeader).toBe("X-Bootstrap-Token");
    expect(call.body).toEqual({ email: "admin@acme.test" });
    // The token carried is EXACTLY the value seed-secrets minted + wrote to Vault this run.
    const mintedToken = seeder.seeded[0]!.data["AUTH_BOOTSTRAP_TOKEN"]!;
    expect(mintedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(call.token).toBe(mintedToken);
    // Surfaced in ONE operator-facing line, marked shown-once/not-stored.
    const resultLine = logs.find((l) => l.includes(ACTIVATION_RESULT_MARKER));
    expect(resultLine).toContain("https://example-auth.s1.example/activate?token=inv_test");
    // NEVER persisted: neither the token nor the activate_url is in params (frozen params_json); no log leaks the token.
    expect(JSON.stringify(p)).not.toContain(mintedToken);
    expect(JSON.stringify(p)).not.toContain("activate?token=inv_test");
    for (const l of logs) expect(l).not.toContain(mintedToken);
  });

  // The endpoint MAY return an optional `mail` object next to activate_url reporting
  // whether the invite mail was delivered. The step surfaces it in one plain run-log line, right next
  // to the activate_url — sent/failed/skipped — and stays fully backward-compatible when it is absent.
  async function activateWithResponse(json: unknown): Promise<string[]> {
    const activator = new FakeActivator({ response: { status: 201, ok: true, json, bodyText: JSON.stringify(json) } });
    const p = params({ activation: AUTH_ACTIVATION, secretSpecs: [BOOTSTRAP_SPEC] });
    const steps = makeOnboardDef(ports({ seeder: new FakeSeeder(), activator })).steps(p);
    const logs: string[] = [];
    await steps.find((s) => s.name === "seed-secrets")!.run(ctx(p, "seed-secrets", logs));
    await steps.find((s) => s.name === "activate")!.run(ctx(p, "activate", logs, { "activation-input:email": "admin@acme.test" }));
    return logs;
  }

  it("surfaces mail status=sent as a plain line next to the activate_url", async () => {
    const logs = await activateWithResponse({ activate_url: "https://example-auth.s1.example/activate?token=inv_test", mail: { status: "sent", transport: "smtp" } });
    expect(logs.some((l) => l.includes(ACTIVATION_RESULT_MARKER))).toBe(true);
    expect(logs).toContain("Invite mail: sent via smtp");
  });

  it("surfaces mail status=failed with the short reason", async () => {
    const logs = await activateWithResponse({ activate_url: "https://example-auth.s1.example/activate?token=inv_test", mail: { status: "failed", transport: "ses", detail: "SES throttled: rate exceeded" } });
    expect(logs).toContain("Invite mail: FAILED — SES throttled: rate exceeded");
  });

  it("surfaces mail status=failed without a detail using a stable fallback", async () => {
    const logs = await activateWithResponse({ activate_url: "https://x/y", mail: { status: "failed", transport: "smtp" } });
    expect(logs).toContain("Invite mail: FAILED — no detail reported");
  });

  it("surfaces mail status=skipped (no transport configured)", async () => {
    const logs = await activateWithResponse({ activate_url: "https://x/y", mail: { status: "skipped", transport: "log-stub" } });
    expect(logs).toContain("Invite mail: not sent (no mail transport configured)");
  });

  it("is backward-compatible: a response WITHOUT a mail field surfaces no mail line", async () => {
    const logs = await activateWithResponse({ ok: true, activate_url: "https://example-auth.s1.example/activate?token=inv_test" });
    expect(logs.some((l) => l.includes(ACTIVATION_RESULT_MARKER))).toBe(true); // activate_url still surfaced
    expect(logs.some((l) => l.startsWith("Invite mail:"))).toBe(false); // no mail line at all
  });

  it("ignores a malformed mail object (unknown status) — treated exactly like an absent field", async () => {
    const logs = await activateWithResponse({ activate_url: "https://x/y", mail: { status: "bogus", transport: "smtp" } });
    expect(logs.some((l) => l.startsWith("Invite mail:"))).toBe(false);
  });

  it("fails LOUD on a non-2xx, surfacing the status + body", async () => {
    const activator = new FakeActivator({ response: { status: 409, ok: false, json: { error: "admin_exists" }, bodyText: '{"error":"admin_exists"}' } });
    const p = params({ activation: AUTH_ACTIVATION, secretSpecs: [BOOTSTRAP_SPEC] });
    const steps = makeOnboardDef(ports({ seeder: new FakeSeeder(), activator })).steps(p);
    await steps.find((s) => s.name === "seed-secrets")!.run(ctx(p, "seed-secrets", []));
    await expect(
      steps.find((s) => s.name === "activate")!.run(ctx(p, "activate", [], { "activation-input:email": "admin@acme.test" })),
    ).rejects.toThrow(/HTTP 409.*admin_exists/s);
  });

  it("is an idempotent SKIP on a create-only re-run (the token was not minted this run)", async () => {
    const seeder = new FakeSeeder();
    seeder.created = false; // the entry already exists (cas=0 refused) ⇒ no live token in memory
    const activator = new FakeActivator();
    const p = params({ activation: AUTH_ACTIVATION, secretSpecs: [BOOTSTRAP_SPEC] });
    const steps = makeOnboardDef(ports({ seeder, activator })).steps(p);
    const logs: string[] = [];
    await steps.find((s) => s.name === "seed-secrets")!.run(ctx(p, "seed-secrets", logs));
    await steps.find((s) => s.name === "activate")!.run(ctx(p, "activate", logs, { "activation-input:email": "admin@acme.test" }));
    expect(activator.calls).toHaveLength(0); // nothing to activate with
    expect(logs.some((l) => l.includes("skipped") && l.includes("one-time"))).toBe(true);
  });

  it("fails loud when a required operator input is missing at approve", async () => {
    const p = params({ activation: AUTH_ACTIVATION, secretSpecs: [BOOTSTRAP_SPEC] });
    const steps = makeOnboardDef(ports({ seeder: new FakeSeeder() })).steps(p);
    await steps.find((s) => s.name === "seed-secrets")!.run(ctx(p, "seed-secrets", []));
    await expect(steps.find((s) => s.name === "activate")!.run(ctx(p, "activate", []))).rejects.toThrow(/operator input "email"/);
  });

  it("planStream freezes the activation into params, appends the activate step, and surfaces requiredInputs (NOT requiredSecrets)", async () => {
    seedClusters();
    const manifest = { mongodb: "shared" as const,
      apiVersion: "hostyour.cloud/v1" as const, kind: "ConsumerManifest" as const,
      name: "acme", owner: "team-acme", envs: ["prod" as const], chart: { path: "deploy/chart" }, services: [], databases: [], builds: BUILDS,
      secrets: [{ key: "AUTH_BOOTSTRAP_TOKEN", required: true, generate: "hex32" as const }], activation: AUTH_ACTIVATION,
    };
    const prt = ports({ runner: new FakeGateRunner({ report: { ...passReport(), manifest } }) });
    const res = await makeOnboardDef(prt).planStream!(
      { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat" },
      { db: db.db, log: () => undefined, signal: new AbortController().signal },
    );
    expect(res.outcome).toBe("planned");
    if (res.outcome !== "planned") return;
    if (res.params.form !== "deployable") return;
    expect(res.params.activation).toEqual(AUTH_ACTIVATION); // the SHAPE is frozen (no token/inputs)
    expect(res.plan.steps.at(-1)?.name).toBe("activate");
    expect(res.plan.requiredInputs).toEqual([{ field: "email", label: "First administrator email" }]);
    expect(res.plan.requiredSecrets).toEqual([]); // the bootstrap token is minted, so no operator secret
  });
});
