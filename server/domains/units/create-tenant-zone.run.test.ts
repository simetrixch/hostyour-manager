// The ZONE under a tenant's wildcard, judged at the PLAN: gate G27 over `*.<subdomain>.<stage apex>`
// (validate-tenant.ts), the same reading provision-dns takes at its own step (unit-dns.ts
// readStandingHost). A collision with another cluster of this installation used to surface at
// provision-dns — after seed-tenant-crypto had written the Vault entry, made the bucket and minted a
// live key — and nothing took those back. Here it refuses the plan, before any write.
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { validateTenant, type ValidateTenantRequest, type ValidateTenantDeps } from "./validate-tenant.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeObjectStore } from "../../adapters/object-store/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import { testMembers, APP_OVERLAYS, TEST_CHANNEL_STAGES } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { TEST_QUOTA } from "./tenant-members.fixture.ts";

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const SUB = "acme";
/** The wildcard the plan judges and provision-dns writes: `*.<subdomain>.<stage apex>`, prod being the apex. */
const WILDCARD = `*.${SUB}.example.com`;

const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: deploy
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;
const CHAIN = [{ path: clusterMapPath("m1.example"), content: "global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: zot.m1.example\n" }];
const CLEAN_DOCS: RenderedDoc[] = [
  { apiVersion: "v1", kind: "Namespace", name: "ns", namespace: "", raw: { kind: "Namespace" } },
  { apiVersion: "apps/v1", kind: "Deployment", name: "d", namespace: GUID, raw: { kind: "Deployment" } },
];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** Both clusters of one installation — the names readStandingHost judges a wildcard's CNAME against. */
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
}

function seeder(): VaultSeeder {
  const no = () => Promise.reject(new Error("not in this test"));
  return { seed: no, patchApp: no, seedPostgres: no, seedMongodb: no, seedRedis: no, seedMariadb: no, seedBuildRepoPat: no, refreshBuildRepoPat: no, deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {}, deleteRedis: async () => {}, deleteMariadb: async () => {}, seedTenantCrypto: async () => ({ created: true }), seedTenantAppKey: async () => ({ created: true }), deleteTenantAppKeys: async () => ({ deleted: [] }), deleteTenantCrypto: async () => {} };
}

function ports(dns: FakeDnsProvider | undefined, store = new FakeObjectStore()): TenantOnboardPorts {
  return {
    seeder: seeder(), objectStore: store,
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({ clusterReader: new FakeClusterReader({}), argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }),
    deployRepoUrl: "https://github.com/acme/acme-deploy.git", platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git", argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com", resolveClusterValueFiles: async () => CHAIN,
    registryProbe: new FakeRegistryProbe(), buildRbac: new FakeBuildRbacWriter(),
    channelStages: async () => TEST_CHANNEL_STAGES,
    attestedBuilds: async () => [], consumerHostLabels: async () => [],
    ...(dns ? { dns } : {}),
  };
}

const REQUEST = { clusterId: "cls_1", stage: "prod", subdomain: SUB, owner: "team-acme", size: "small", apps: [] };

function planCtx(logs: string[]): PlanStreamCtx {
  return { db: db.db, log: (l) => logs.push(l), signal: new AbortController().signal };
}

function ctx(p: CreateTenantParams, logs: string[]): StepCtx {
  return {
    runId: "run_tnt", stepName: "provision-dns", db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("G27 over the tenant's wildcard — validateTenant reads the zone where the plan will write it", () => {
  const req = (over: Partial<ValidateTenantRequest> = {}): ValidateTenantRequest => ({
    repoURL: "https://github.com/acme/acme-deploy.git", ref: "master", stage: "prod", apps: [], probeGuid: GUID, subdomain: SUB, clusterValueFiles: CHAIN, clusterFqdn: "s1.example", quota: TEST_QUOTA, ...over,
  });
  const deps = (over: Partial<ValidateTenantDeps> = {}): ValidateTenantDeps => ({
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }), log: () => {}, signal: new AbortController().signal, ...over,
  });

  it("a leftover of a gone installation passes, names the address it will replace, and asks about the WILDCARD", async () => {
    const asked: string[] = [];
    const outcome = await validateTenant(req(), deps({ standingHost: async (host, fqdn) => { asked.push(`${host} on ${fqdn}`); return { kind: "leftover", type: "A", content: "157.90.201.150" }; } }));
    expect(asked).toEqual([`${WILDCARD} on s1.example`]);
    const g27 = outcome.report.gates.find((g) => g.id === "G27");
    expect(g27?.status).toBe("pass");
    expect(g27?.evidence).toEqual([{ source: "manager", name: WILDCARD, fieldPath: "standing", value: "A 157.90.201.150" }]);
    expect(outcome.verdict).toBe("pass");
  });

  it("a collision with another cluster of this installation fails the verdict, naming that cluster", async () => {
    const outcome = await validateTenant(req(), deps({ standingHost: async () => ({ kind: "collision", cluster: "s2.example" }) }));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "G27")?.found).toContain("s2.example");
  });

  it("a Manager with no DNS provider fails the plan here, not at provision-dns after the writes", async () => {
    const outcome = await validateTenant(req(), deps());
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "G27")?.found).toContain("no DNS provider");
  });

  it("does not run for a caller that writes no record (no clusterFqdn: add-app, the post-build re-render)", async () => {
    const { clusterFqdn: _drop, ...noZone } = req();
    const outcome = await validateTenant(noZone, deps({ standingHost: async () => ({ kind: "collision", cluster: "s2.example" }) }));
    expect(outcome.verdict).toBe("pass");
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "G9"]);
  });
});

describe("create-tenant plans the zone before the first write", () => {
  it("REFUSES a tenant whose wildcard stands at another cluster of this installation — no bucket, no key, no entry", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    dns.seed(WILDCARD, "CNAME", "s2.example"); // the same subdomain already served by s2
    const store = new FakeObjectStore();
    const logs: string[] = [];
    const result = await makeCreateTenantDef(ports(dns, store)).planStream!(REQUEST, planCtx(logs));
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toContain("G27");
    expect(logs.some((l) => l.startsWith("G27 fail"))).toBe(true);
    expect((result.planJson as TenantValidationReport).gates.find((g) => g.id === "G27")?.found).toContain("s2.example");
    expect([...store.buckets]).toEqual([]);
    expect(store.mints).toEqual([]);
  });

  it("a replace whose old tenant serves the wildcard from another cluster is refused by G27, its registration untouched", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    dns.seed(WILDCARD, "CNAME", "s2.example"); // the old tenant's wildcard, provisioned at s2
    const prt = ports(dns);
    await prt.registrations.commitTenant({ stage: "prod", guid: "e2e8ymj86dk8", runId: "run_old", registration: { cluster: "s2", subdomain: SUB, members: testMembers([]), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "", apps: [], seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "" } });
    const result = await makeCreateTenantDef(prt).planStream!(REQUEST, planCtx([]));
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toContain("G27");
    expect(await prt.registrations.readTenant("prod", "e2e8ymj86dk8")).not.toBeNull();
  });

  it("plans over a leftover and the plan stream carries the G27 line with the record provision-dns will replace", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    dns.seed(WILDCARD, "A", "157.90.201.150"); // an address no cluster of this installation has
    const logs: string[] = [];
    const result = await makeCreateTenantDef(ports(dns)).planStream!(REQUEST, planCtx(logs));
    expect(result.outcome).toBe("planned");
    expect(logs.some((l) => l.startsWith("G27 pass") && l.includes("leftover"))).toBe(true);
    if (result.outcome !== "planned") return;
    expect(result.params.report.gates.find((g) => g.id === "G27")?.evidence?.[0]?.value).toBe("A 157.90.201.150");
  });

  it("carries the deploy trunk into the books branch BEFORE it reads it, and says so in the plan stream", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    const logs: string[] = [];
    const prt = { ...ports(dns), carryTrunkToBooksBranch: async () => { logs.push("carried"); } };
    const result = await makeCreateTenantDef(prt).planStream!(REQUEST, planCtx(logs));
    expect(result.outcome).toBe("planned");
    expect(logs[0]).toBe("carried");
    expect(logs.findIndex((l) => l.startsWith("deploy trunk carried"))).toBeLessThan(logs.findIndex((l) => l.startsWith("G27")));
  });

  it("a carry that fails is logged with its reason and the plan goes on over the branch as it stands", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    const logs: string[] = [];
    const prt = { ...ports(dns), carryTrunkToBooksBranch: async () => { throw new Error("origin refused the push"); } };
    const result = await makeCreateTenantDef(prt).planStream!(REQUEST, planCtx(logs));
    expect(result.outcome).toBe("planned");
    expect(logs.some((l) => l.includes("could not be carried") && l.includes("origin refused the push"))).toBe(true);
  });

  it("provision-dns writes the ONE wildcard as a CNAME onto the cluster, replacing a leftover and saying what stood there", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    dns.seed(WILDCARD, "A", "157.90.201.150");
    const prt = ports(dns);
    const p = CreateTenantParams.parse({
      guid: GUID, subdomain: SUB, stage: "prod", clusterId: "cls_1", domain: "s1.example", cluster: "s1", chartsRef: SHA, registryHost: "zot.m1.example",
      members: testMembers([]), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "", owner: "team-acme", size: "small", expectedApps: [], deployRepoUrl: prt.deployRepoUrl,
      report: composeTenantReport({ resolvedSha: SHA, probeGuid: GUID, appsValidated: [], resolvedMembers: [], startedAt: 1, finishedAt: 2, manifest: null, gates: [] }),
    });
    const logs: string[] = [];
    await makeCreateTenantDef(prt).steps(p).find((s) => s.name === "provision-dns")!.run(ctx(p, logs));
    // ONE wildcard covers every member host `<member>.<subdomain>.<stage apex>` — members added later
    // included — and it names the cluster, never an address.
    expect(dns.record(WILDCARD, "CNAME")).toBe("s1.example");
    expect(dns.record(WILDCARD, "A")).toBeUndefined();
    expect(logs.some((l) => l.includes("stood as A 157.90.201.150") && l.includes("replaced with a CNAME onto s1.example"))).toBe(true);
    expect(logs.some((l) => l.includes("a move is a content update of exactly this record"))).toBe(true);
  });
});

describe("create-tenant marks the identity provider in DNS where the product declares the label", () => {
  const MARK_NAME = `_digita-idp.auth.${SUB}.example.com`;
  const createParams = (prt: TenantOnboardPorts, over: Record<string, unknown> = {}) => CreateTenantParams.parse({
    guid: GUID, subdomain: SUB, stage: "prod", clusterId: "cls_1", domain: "s1.example", cluster: "s1", chartsRef: SHA, registryHost: "zot.m1.example",
    members: testMembers([]), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "", owner: "team-acme", size: "small", expectedApps: [], deployRepoUrl: prt.deployRepoUrl,
    report: composeTenantReport({ resolvedSha: SHA, probeGuid: GUID, appsValidated: [], resolvedMembers: [], startedAt: 1, finishedAt: 2, manifest: null, gates: [] }),
    ...over,
  });

  it("provision-dns publishes the mark beside the zone record, booked for the tenant at its stage", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    const prt = ports(dns);
    const p = createParams(prt, { issuerRecordLabel: "_digita-idp" });
    await makeCreateTenantDef(prt).steps(p).find((s) => s.name === "provision-dns")!.run(ctx(p, []));
    expect(await dns.listRecordContents({ name: MARK_NAME, type: "TXT" })).toEqual([`https://auth.${SUB}.example.com`]);
    expect(listDnsWrites(db.db).find((w) => w.name === MARK_NAME)?.owner).toEqual({ kind: "tenant", name: GUID, stage: "prod" });
  });

  it("PLANTED INNOCENT: a product that declares no label gets no mark, and the log says so", async () => {
    const dns = new FakeDnsProvider();
    seedClusters();
    const prt = ports(dns);
    const p = createParams(prt);
    const logs: string[] = [];
    await makeCreateTenantDef(prt).steps(p).find((s) => s.name === "provision-dns")!.run(ctx(p, logs));
    expect(await dns.listRecordContents({ name: MARK_NAME, type: "TXT" })).toEqual([]);
    expect(logs).toContain("the product's tenant spec declares no issuerRecordLabel, so no DNS mark of the identity provider is published");
  });

  it("the plan freezes the product's label into the run and says the first invite waits for the mark", async () => {
    seedClusters();
    const prt = ports(new FakeDnsProvider());
    prt.repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("tenant:\n  members:", "tenant:\n  issuerRecordLabel: _digita-idp\n  members:"), ...APP_OVERLAYS } });
    const result = await makeCreateTenantDef(prt).planStream!(REQUEST, planCtx([]));
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    expect(result.params.issuerRecordLabel).toBe("_digita-idp");
    expect(result.plan.summary).toContain("Its identity provider is marked in DNS under _digita-idp beside its zone record, and the first invite waits until the mark resolves.");
    const plain = await makeCreateTenantDef(ports(new FakeDnsProvider())).planStream!({ ...REQUEST, subdomain: "plain" }, planCtx([]));
    if (plain.outcome !== "planned") throw new Error(`rejected: ${plain.summary}`);
    expect(plain.plan.summary).toContain("The product's tenant spec declares no issuerRecordLabel, so no DNS mark of the identity provider is published.");
  });
});
