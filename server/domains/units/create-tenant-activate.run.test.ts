import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import { EPHEMERAL_STREAM, type RunOutputStream } from "../../../shared/enums.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";


// The final `activate` step of create-tenant (impl: create-tenant-activate.ts) — the tenant analogue
// of the consumer's post-onboard invite, and a file of its own because it is a step of its own: the
// consumer journey's assertions cover onboard-activate.ts and say nothing about this one.
//
// The step reads the crypto-seeded bootstrap token from hostyour-app-secrets in the auth member's
// namespace and calls the tenant's OWN example-auth first-admin bootstrap, but ONLY when the operator
// supplied an admin email. auth FQDN for the fixtures = auth.<subdomain>.<unitApex>, and the ports
// fixture's apex ("example.com") is deliberately NOT the cluster domain ("s1.example").

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0"; // a live-shaped throwaway guid
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const REGISTRY_HOST = "zot.m1.example";
const APPS = [{ name: "erp" }];
const EXPECTED = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");

const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
const CLEAN_DOCS = [doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }), doc("Deployment")];
const GREEN: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["base", "auth", "erp-engine", "erp-front"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}

type FakeKube = { cluster?: FakeClusterReader };

function ports(over: Partial<TenantOnboardPorts> & FakeKube = {}): TenantOnboardPorts {
  const { cluster, ...portOver } = over;
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  const statuses = new Map<string, ArgoAppStatus>(EXPECTED.map((n) => [n, GREEN]));
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE),
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({}),
      argoReader: new FakeMasterArgoReader({ statuses, status: GREEN }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    dns,
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [],
    consumerNames: async () => [],
    ...portOver,
  };
}

function params(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1", domain: "s1.example",
    members: testMembers(APPS),
    identityProvider: "auth",
    cluster: "s1", chartsRef: SHA, registryHost: REGISTRY_HOST,
    apps: APPS, seedUsers: false, quota: seedQuota("small"), owner: "team-acme",
    report: passReport(), expectedApps: EXPECTED, catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}

/** `lines` carries the STREAM each log line went out on, which is what decides whether it becomes an
 *  append-only `events` row: executor/context.ts persists every stream except the ephemeral one. */
function ctx(p: CreateTenantParams, lines: { stream: RunOutputStream; text: string }[] = []): StepCtx {
  return {
    runId: "run_tnt", stepName: "activate", db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (stream, text) => lines.push({ stream, text }),
    checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const texts = (lines: { text: string }[]): string => lines.map((l) => l.text).join("\n");

function seedSlave(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

describe("create-tenant first-admin invite (activate step)", () => {
  const TOKEN_PATH = `${memberNamespace(GUID, "auth")}/hostyour-app-secrets/AUTH_BOOTSTRAP_TOKEN`;
  const AUTH_URL = "https://auth.acme.example.example.com/api/v1/bootstrap/invite-admin";

  const activateStep = (prt: TenantOnboardPorts, p: CreateTenantParams) =>
    makeCreateTenantDef(prt).steps(p).find((s) => s.name === "activate")!;
  /** The target slave with the auth member's crypto-seeded bootstrap token in place — the state a green
   *  smoke leaves behind, and the precondition of every case except the absent-token one. */
  const withToken = (): FakeClusterReader => new FakeClusterReader({ secretValues: { [TOKEN_PATH]: "boot_tok_abc" } });

  it("is appended LAST, right after record-inventory", () => {
    const names = makeCreateTenantDef(ports()).steps(params()).map((s) => s.name);
    expect(names.at(-1)).toBe("activate");
    expect(names.indexOf("activate")).toBe(names.indexOf("record-inventory") + 1);
  });

  // The apex is the target cluster's own (global.unitApex off its values chain) — the same value
  // provision-dns composes the tenant's wildcard `*.<subdomain>.<unitApex>` from, and the same three
  // parts the auth member's chart renders. Composing from `p.domain` instead posts the bootstrap token
  // at a host that resolves nowhere on every cluster that is not itself the apex, which install.sh
  // makes the normal case: it defaults `unit-apex` to the cluster FQDN minus its first label.
  it("addresses the tenant's auth at <subdomain>.<unitApex> — NOT at the cluster domain", async () => {
    const activator = new FakeActivator();
    const p = params({ adminEmail: "admin@acme.test" });
    await activateStep(ports({ activator, cluster: withToken(), resolveUnitApex: async () => "zone.example" }), p).run(ctx(p));
    expect(activator.calls[0]?.url).toBe("https://auth.acme.example.zone.example/api/v1/bootstrap/invite-admin");
    expect(activator.calls[0]?.url).not.toContain("s1.example"); // the cluster is reached there; the tenant does not serve there
  });

  it("with an admin email: reads the bootstrap token and calls the tenant's own example-auth", async () => {
    const activator = new FakeActivator();
    const p = params({ adminEmail: "admin@acme.test" });
    await activateStep(ports({ activator, cluster: withToken() }), p).run(ctx(p));

    expect(activator.calls).toHaveLength(1);
    const call = activator.calls[0]!;
    expect(call.url).toBe(AUTH_URL);
    expect(call.method).toBe("POST");
    expect(call.tokenHeader).toBe("X-Bootstrap-Token");
    expect(call.token).toBe("boot_tok_abc"); // read straight from the k8s Secret on the target slave
    expect(call.body).toEqual({ email: "admin@acme.test" });
    // Neither the bootstrap token nor the returned url enters the frozen params (adminEmail does).
    expect(JSON.stringify(p)).not.toContain("boot_tok_abc");
    expect(JSON.stringify(p)).not.toContain("activate?token=inv_test");
  });

  it("surfaces the activate_url on the EPHEMERAL stream ALONE — every other stream is an events row", async () => {
    // The activate_url is a root-admin credential for the tenant that has just come up. Every stream
    // but the ephemeral one is written into the append-only `events` table, which by design has no
    // deleter — a line on "meta" would keep that credential for good, readable by anyone who can open
    // the run. So: exactly one marked line, on the ephemeral stream, and nothing that IS kept carries
    // the url. The success of the invite still has to be visible in the kept log.
    const activator = new FakeActivator();
    const p = params({ adminEmail: "admin@acme.test" });
    const lines: { stream: RunOutputStream; text: string }[] = [];
    await activateStep(ports({ activator, cluster: withToken() }), p).run(ctx(p, lines));

    const marked = lines.filter((l) => l.text.includes(ACTIVATION_RESULT_MARKER));
    expect(marked.map((l) => l.stream)).toEqual([EPHEMERAL_STREAM]);
    expect(marked[0]!.text).toContain("activate?token=inv_test");
    const kept = texts(lines.filter((l) => l.stream !== EPHEMERAL_STREAM));
    expect(kept).not.toContain("activate?token=inv_test");
    expect(kept).toContain("first-admin invite succeeded");
  });

  it("tolerates 409 admin_exists (single-shot) and SUCCEEDS — an idempotent re-run", async () => {
    const activator = new FakeActivator({ response: { status: 409, ok: false, json: { error: "admin_exists" }, bodyText: '{"error":"admin_exists"}' } });
    const p = params({ adminEmail: "admin@acme.test" });
    const lines: { stream: RunOutputStream; text: string }[] = [];
    await activateStep(ports({ activator, cluster: withToken() }), p).run(ctx(p, lines)); // does not throw
    expect(texts(lines)).toMatch(/already exists[\s\S]*single-shot|single-shot[\s\S]*already exists/);
  });

  it("fails LOUD on any other non-2xx (e.g. 404 wrong/absent token)", async () => {
    const activator = new FakeActivator({ response: { status: 404, ok: false, json: null, bodyText: "not found" } });
    const p = params({ adminEmail: "admin@acme.test" });
    await expect(activateStep(ports({ activator, cluster: withToken() }), p).run(ctx(p))).rejects.toThrow(/HTTP 404/);
  });

  it("fails loud when the bootstrap token is absent (the crypto secret must exist by now)", async () => {
    const activator = new FakeActivator();
    const p = params({ adminEmail: "admin@acme.test" });
    // no secretValues -> readSecretValue resolves null
    await expect(activateStep(ports({ activator, cluster: new FakeClusterReader({}) }), p).run(ctx(p))).rejects.toThrow(/AUTH_BOOTSTRAP_TOKEN.*absent/);
    expect(activator.calls).toHaveLength(0);
  });

  it("skips entirely (no token read, no invite) when no admin email was supplied", async () => {
    const activator = new FakeActivator();
    const p = params(); // no adminEmail — a tenant onboards exactly as before
    const lines: { stream: RunOutputStream; text: string }[] = [];
    await activateStep(ports({ activator }), p).run(ctx(p, lines));
    expect(activator.calls).toHaveLength(0);
    expect(texts(lines)).toContain("no admin email supplied");
  });

  it("planStream threads an optional adminEmail into params", async () => {
    seedSlave();
    const planCtx: PlanStreamCtx = { db: db.db, log: () => undefined, signal: new AbortController().signal };
    const result = await makeCreateTenantDef(ports()).planStream!(
      { clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS, adminEmail: "admin@acme.test" },
      planCtx,
    );
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.adminEmail).toBe("admin@acme.test");
  });
});
