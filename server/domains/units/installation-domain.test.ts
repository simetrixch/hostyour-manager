import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { findDnsWrite, listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { consumerUnitHost, tenantIssuerRecord, tenantMemberUrl, tenantZone } from "#unit/shared/unit-host.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import type { StepCtx } from "../../executor/types.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { applyInstallationDomain, readInstallationDomain, validateInstallationDomainRollback } from "./installation-domain.ts";
import { makeInstallationDomainDef, makeInstallationDomainRollbackDef } from "../runs/defs/installation-domain.ts";
import { createInstallationDomainIssuers } from "./installation-domain-issuers.ts";

const FROM = "old.example", TO = "new.example", OLD_HOST = `s1.${FROM}`, NEW_HOST = `s1.${TO}`, GUID = "zsjs023ctne0";
let db: DbHandle, cloud: FakePlatformRepo, deploy: FakePlatformRepo, dns: FakeDnsProvider, consumers: Registrations, tenantRegistrations: TenantRegistrations;
const mapPath = clusterMapPath(NEW_HOST);
const ports = () => ({ platformRepo: cloud, dns, consumers, tenantRegistrations });
function ctx(runId = "run_move"): StepCtx {
  return { runId, stepName: "move-unit-domains", db: db.db, params: {}, signal: new AbortController().signal,
    creds: {} as StepCtx["creds"], logger: {} as StepCtx["logger"], secrets: { get: () => undefined, wipe: () => undefined },
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")), closePasswordSession: () => undefined,
    attest: () => Promise.reject(new Error("no attest")), log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined };
}
function seed(stage: Stage, withOverride = false): void {
  const name = "post", consumer = ConsumerRegistrationSchema.parse({ name, repoURL: "https://github.com/acme/post.git", chartPath: "deploy/chart", cluster: "s1", host: name,
    databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") });
  cloud.seed(cloud.booksBranch, `registrations/${name}/${stage}.yaml`, JSON.stringify(consumer));
  const members = structuredClone(testMembers(["web"]));
  if (withOverride) members[0]!.sources[0]!.values = { cookieDomain: `.shop.${FROM}` };
  const tenant = { cluster: "s1", members, identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "", subdomain: "shop",
    apps: [{ name: "web", seedReference: false, seedDemo: false, selections: {}, needs: [], path: "/app/web" }], seedUsers: false, quota: seedQuota("small"), resetNonce: "keep-data", suspended: false, quiesced: false, appsImage: "", appsImageTag: "" };
  const write = tenantRegistrationWrite(stage, GUID, tenant);
  deploy.seed(deploy.booksBranch, write.path, write.content);
  const unitHost = consumerUnitHost(name, stage, FROM), tenantHost = tenantZone("shop", stage, FROM);
  const issuerName = tenantIssuerRecord("_idp", "auth", stage, "shop", FROM).name, issuer = tenantMemberUrl("auth", stage, "shop", FROM, "");
  for (const [host, kind, owner] of [[unitHost, "consumer", name], [tenantHost, "tenant", GUID]] as const) {
    dns.seed(host, "CNAME", OLD_HOST);
    recordDnsWrite(db.db, { name: host, type: "CNAME", content: OLD_HOST, act: "inserted", owner: { kind, name: owner, stage }, runId: "run_seed" });
  }
  dns.seed(issuerName, "TXT", issuer, "unrelated-TXT");
  recordDnsWrite(db.db, { name: issuerName, type: "TXT", content: issuer, act: "inserted", owner: { kind: "tenant", name: GUID, stage }, runId: "run_seed" });
}
beforeEach(() => {
  db = openDb(":memory:"); cloud = new FakePlatformRepo(); deploy = new FakePlatformRepo(); dns = new FakeDnsProvider(); consumers = new Registrations(cloud); tenantRegistrations = new TenantRegistrations(deploy);
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: NEW_HOST, sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: NEW_HOST, name: "s1", status: "active" }).run();
  cloud.seed(cloud.booksBranch, mapPath, `global:\n  domain: ${NEW_HOST}\n  clusterName: s1\n  unitApex: ${FROM}\n  unrelated: keep\n`);
});
afterEach(() => db.sqlite.close());

describe("installation domain unit phase", () => {
  it("censuses all stages without inventory rows, every DNS/book/IdP/cookie effect, and writes nothing", async () => {
    for (const stage of STAGE) seed(stage, stage === "test");
    const beforeBooks = listDnsWrites(db.db);
    const preview = await readInstallationDomain(db.db, ports(), FROM, TO);
    expect(preview.coverage).toMatchObject({ consumers: 3, tenants: 3, stages: [...STAGE] });
    expect(preview.records).toHaveLength(9);
    expect(preview.records.filter(r => r.type === "TXT")).toHaveLength(3);
    expect(preview.tenants.find(t => t.stage === "test")?.cookieOverrides[0]).toMatchObject({ before: `.shop.${FROM}`, after: `.shop.${TO}` });
    expect(preview.tenants.find(t => t.stage === "prod")?.cookieAfter).toBe(tenantZone("shop", "prod", TO));
    expect(preview.blockers.join("\n")).not.toContain("session");
    expect(preview.coverage.sessions).toMatch(/signs in once/);
    expect(preview.records.every(r => r.sourceBook?.runId === "run_seed" && r.targetBook === null)).toBe(true);
    expect(cloud.commits).toHaveLength(0); expect(deploy.commits).toHaveLength(0); expect(dns.upserts).toHaveLength(0); expect(dns.creates).toHaveLength(0); expect(dns.deletes).toHaveLength(0);
    expect(listDnsWrites(db.db)).toEqual(beforeBooks);
  });
  it("blocks a target record occupied by another type", async () => {
    seed("prod"); dns.seed(`post.${TO}`, "A", "192.0.2.9");
    const first = await readInstallationDomain(db.db, ports(), FROM, TO);
    expect(first.blockers.join("\n")).toContain("target has a A record");
  });
  it("moves the units ahead of the machines: the new records point at the machine where it stands", async () => {
    db.db.update(clusters).set({ domain: OLD_HOST }).where(eq(clusters.id, "cls_1")).run();
    const oldMap = clusterMapPath(OLD_HOST);
    cloud.seed(cloud.booksBranch, oldMap, `global:\n  domain: ${OLD_HOST}\n  clusterName: s1\n  unitApex: ${FROM}\n`);
    seed("prod");
    const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.records.filter(r => r.type === "CNAME").map(r => [r.targetName, r.after])).toEqual([[`post.${TO}`, OLD_HOST], [`shop.${TO}`, OLD_HOST]]);
    await applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move");
    expect(dns.record(`post.${TO}`, "CNAME")).toBe(OLD_HOST); expect(dns.record(`post.${FROM}`, "CNAME")).toBe(OLD_HOST);
    const map = parseDocument(cloud.read(cloud.booksBranch, oldMap)!);
    expect([map.getIn(["global", "domain"]), map.getIn(["global", "unitApex"])]).toEqual([OLD_HOST, TO]);
  });
  it("repoints the tenant's alias domains onto the new zone", async () => {
    seed("prod");
    const tenant = (await tenantRegistrations.readTenant("prod", GUID))!.entry, zone = tenantZone("shop", "prod", FROM);
    const write = tenantRegistrationWrite("prod", GUID, { ...tenant, ownDomain: "company.example", ownDomainRedirects: ["www.company.example"], ownDomainAliases: ["company-alias.example"] });
    deploy.seed(deploy.booksBranch, write.path, write.content);
    const hosts = ["company.example", "www.company.example", "company-alias.example", "www.company-alias.example"];
    for (const host of hosts) {
      dns.seed(host, "CNAME", zone);
      recordDnsWrite(db.db, { name: host, type: "CNAME", content: zone, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_seed" });
    }
    const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    for (const host of hosts) expect(snapshot.records.find(r => r.name === host), host).toMatchObject({ targetName: host, before: zone, after: tenantZone("shop", "prod", TO) });
    expect(snapshot.retainedBooks.filter(b => hosts.includes(b.name))).toEqual([]);
  });
  it("writes the previous apex beside the new one in the same commit, and the rollback removes it", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    await applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move");
    const moved = cloud.commits.filter(c => c.write?.some(w => w.path === mapPath));
    expect(moved).toHaveLength(1);
    const written = parseDocument(moved[0]!.write!.find(w => w.path === mapPath)!.content);
    expect([written.getIn(["global", "unitApex"]), written.getIn(["global", "previousUnitApex"])]).toEqual([TO, FROM]);
    await applyInstallationDomain(ctx("run_rollback"), ports(), snapshot, true, "run_move");
    const restored = parseDocument(cloud.read(cloud.booksBranch, mapPath)!);
    expect(restored.getIn(["global", "unitApex"])).toBe(FROM);
    expect(restored.hasIn(["global", "previousUnitApex"])).toBe(false);
    expect(restored.getIn(["global", "unrelated"])).toBe("keep");
  });
  it("refuses a standing unit whose label is a platform host at the new apex", async () => {
    seed("prod");
    const raw = JSON.parse(cloud.read(cloud.booksBranch, "registrations/post/prod.yaml")!) as Record<string, unknown>;
    cloud.seed(cloud.booksBranch, "registrations/mail/prod.yaml", JSON.stringify({ ...raw, name: "mail", host: "mail" }));
    await expect(readInstallationDomain(db.db, ports(), FROM, TO)).rejects.toThrow(/platform host cannot be a host label/);
  });
  it("permits TXT beside only a same-name book-owned CNAME with its recorded baseline", async () => {
    seed("prod"); const name = "company.example", before = `shop.${FROM}`;
    const tenant = (await tenantRegistrations.readTenant("prod", GUID))!.entry;
    const write = tenantRegistrationWrite("prod", GUID, { ...tenant, ownDomain: name });
    deploy.seed(deploy.booksBranch, write.path, write.content);
    dns.seed(name, "CNAME", before); dns.seed(name, "TXT", "keep-verification");
    expect((await readInstallationDomain(db.db, ports(), FROM, TO)).blockers).toContain(`${name}: target has a TXT record; no takeover is permitted`);
    recordDnsWrite(db.db, { name, type: "CNAME", content: before, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_seed" });
    const allowed = await readInstallationDomain(db.db, ports(), FROM, TO);
    expect(allowed.blockers.some(b => b.startsWith(`${name}:`))).toBe(false);
    expect(allowed.records.find(r => r.name === name)).toMatchObject({ targetName: name, before, after: `shop.${TO}` });
    dns.seed(`post.${TO}`, "TXT", "foreign-target"); dns.seed(name, "A", "192.0.2.9");
    const guarded = await readInstallationDomain(db.db, ports(), FROM, TO);
    expect(guarded.blockers).toContain(`post.${TO}: target has a TXT record; no takeover is permitted`);
    expect(guarded.blockers).toContain(`${name}: target has a A record; no takeover is permitted`);
    expect(await dns.listRecordContents({ name, type: "TXT" })).toEqual(["keep-verification"]);
    expect(dns.upserts).toHaveLength(0); expect(dns.deletes).toHaveLength(0);
  });
  it("refuses unreadable/uncovered registrations and foreign DNS book ownership", async () => {
    seed("prod"); cloud.seed(cloud.booksBranch, "registrations/broken/test.yaml", "not: [yaml");
    await expect(readInstallationDomain(db.db, ports(), FROM, TO)).rejects.toThrow();
    cloud.seed(cloud.booksBranch, "registrations/broken/test.yaml", "{}");
    await expect(readInstallationDomain(db.db, ports(), FROM, TO)).rejects.toThrow();
  });
  it("refuses a source book owned by somebody else", async () => {
    seed("prod"); recordDnsWrite(db.db, { name: `post.${FROM}`, type: "CNAME", content: OLD_HOST, act: "inserted", owner: { kind: "consumer", name: "other", stage: "prod" }, runId: "run_foreign" });
    await expect(readInstallationDomain(db.db, ports(), FROM, TO)).rejects.toThrow(/book entry disagrees/);
  });
  it("refuses an unrelated private TXT issuer without exposing its value", async () => {
    seed("prod"); const mark = tenantIssuerRecord("_idp", "auth", "prod", "shop", FROM).name;
    const content = "https://outside.example/auth?token=private-fixture";
    dns.seed(mark, "TXT", content);
    recordDnsWrite(db.db, { name: mark, type: "TXT", content, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_seed" });
    await expect(readInstallationDomain(db.db, ports(), FROM, TO)).rejects.toThrow(`${mark}: identity-provider mark is not a safe issuer URL`);
    expect(cloud.commits).toHaveLength(0); expect(dns.upserts).toHaveLength(0);
  });
  it("forward retry and rollback preserve old records, unrelated TXT, data/reset fields and later suspension edits", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    await applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move");
    await applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move");
    expect(dns.record(`post.${FROM}`, "CNAME")).toBe(OLD_HOST); expect(dns.record(`post.${TO}`, "CNAME")).toBe(NEW_HOST);
    expect(parseDocument(cloud.read(cloud.booksBranch, mapPath)!).getIn(["global", "unitApex"])).toBe(TO);
    await tenantRegistrations.setTenantSuspended("prod", GUID, true, "run_later");
    await applyInstallationDomain(ctx("run_rollback"), ports(), snapshot, true, "run_move");
    await applyInstallationDomain(ctx("run_rollback"), ports(), snapshot, true, "run_move");
    expect(dns.record(`post.${TO}`, "CNAME")).toBeUndefined(); expect(dns.record(`post.${FROM}`, "CNAME")).toBe(OLD_HOST);
    expect(await dns.listRecordContents({ name: tenantIssuerRecord("_idp", "auth", "prod", "shop", FROM).name, type: "TXT" })).toContain("unrelated-TXT");
    expect((await tenantRegistrations.readTenant("prod", GUID))?.entry).toMatchObject({ resetNonce: "keep-data", suspended: true });
    expect(parseDocument(cloud.read(cloud.booksBranch, mapPath)!).getIn(["global", "unrelated"])).toBe("keep");
    expect(findDnsWrite(db.db, { name: `post.${TO}`, type: "CNAME" })).toBeNull();
  });
  it("accepts old names already repointed by the completed machine phase", async () => {
    seed("prod");
    for (const name of [consumerUnitHost("post", "prod", FROM), tenantZone("shop", "prod", FROM)]) {
      dns.seed(name, "CNAME", NEW_HOST);
      const book = findDnsWrite(db.db, { name, type: "CNAME" })!;
      recordDnsWrite(db.db, { ...book, content: NEW_HOST, runId: "run_machine" });
    }
    const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    expect(snapshot.records.filter(r => r.type === "CNAME").every(r => r.before === NEW_HOST)).toBe(true);
    expect(snapshot.blockers.some(b => b.includes("recorded source value"))).toBe(false);
    await applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move");
    await applyInstallationDomain(ctx("run_rollback"), ports(), snapshot, true, "run_move");
    expect(dns.record(`post.${FROM}`, "CNAME")).toBe(NEW_HOST);
  });
  it("compensates an interrupted registration write without changing old names", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    const real = tenantRegistrations.compareDomainFields.bind(tenantRegistrations);
    tenantRegistrations.compareDomainFields = async (...args) => { if (!args[3]) throw new Error("registration unavailable"); await real(...args); };
    await expect(applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move")).rejects.toThrow(/registration unavailable/);
    await applyInstallationDomain(ctx(), ports(), snapshot, true, "run_move");
    expect(dns.record(`post.${TO}`, "CNAME")).toBeUndefined();
    expect(dns.record(`post.${FROM}`, "CNAME")).toBe(OLD_HOST);
    expect(parseDocument(cloud.read(cloud.booksBranch, mapPath)!).getIn(["global", "unitApex"])).toBe(FROM);
  });
  it("rollback refuses a newer writer instead of removing its record", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    await applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move");
    recordDnsWrite(db.db, { name: `post.${TO}`, type: "CNAME", content: NEW_HOST, act: "updated", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_newer" });
    await expect(applyInstallationDomain(ctx("run_rollback"), ports(), snapshot, true, "run_move")).rejects.toThrow(/newer book writer/);
    expect(dns.record(`post.${TO}`, "CNAME")).toBe(NEW_HOST);
    expect(parseDocument(cloud.read(cloud.booksBranch, mapPath)!).getIn(["global", "unitApex"])).toBe(TO);
  });
  it("does not overwrite a changed map identity", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    cloud.seed(cloud.booksBranch, mapPath, `global:\n  domain: foreign.example\n  clusterName: s1\n  unitApex: ${FROM}\n`);
    await expect(applyInstallationDomain(ctx(), ports(), snapshot, false, "run_move")).rejects.toThrow(/changed since planning/);
    expect(parseDocument(cloud.read(cloud.booksBranch, mapPath)!).getIn(["global", "domain"])).toBe("foreign.example");
  });
  it("ignores a caller-supplied snapshot and records the current census", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    const def = makeInstallationDomainDef({ read: async () => snapshot, validateRollback: async () => undefined, apply: async () => undefined, ...createInstallationDomainIssuers(undefined) });
    const result = await def.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: true, snapshot: { ...snapshot, records: [] } }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    expect(result.outcome).toBe("planned");
    if (result.outcome === "planned") expect(result.params.snapshot?.records).toHaveLength(3);
    if (result.outcome === "planned") expect(result.plan.warnings.join("\n")).toMatch(/everyone signs in once/i);
    const rollback = makeInstallationDomainRollbackDef(undefined);
    await expect(rollback.planStream!({ sourceRunId: "run_missing", dryRun: true }, { db: db.db, log: () => undefined, signal: new AbortController().signal })).rejects.toThrow(/stopped installation domain move/);
  });
  it("dry-run rollback validates without writes and refuses a source that restarted after planning", async () => {
    seed("prod"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    const original = { fromDomain: FROM, toDomain: TO, dryRun: false, snapshot };
    const actions = { ...createInstallationDomainIssuers(undefined), read: async () => snapshot, apply: async () => undefined, validateRollback: (context: StepCtx, recorded: typeof snapshot, sourceRunId: string) => validateInstallationDomainRollback(context, ports(), recorded, sourceRunId) };
    const move = makeInstallationDomainDef(actions);
    const movePlan = await move.planStream!(original, { db: db.db, log: () => undefined, signal: ctx().signal });
    if (movePlan.outcome !== "planned") throw new Error("expected plan");
    db.sqlite.prepare("INSERT INTO runs(id,kind,target_kind,target_id,params_json,plan_json,status,owner,modified_by) VALUES(?,?,?,?,?,?,?,?,?)").run("run_source", "installation-domain-move", "installation", cloud.booksBranch, JSON.stringify(original), JSON.stringify(movePlan.plan), "failed", "op_system", "op_system");
    const rollback = makeInstallationDomainRollbackDef(actions);
    const planned = await rollback.planStream!({ sourceRunId: "run_source", dryRun: true }, { db: db.db, log: () => undefined, signal: ctx().signal });
    if (planned.outcome !== "planned") throw new Error("expected rollback plan");
    await rollback.steps(planned.params)[0]!.run(ctx("run_rollback"));
    expect(cloud.commits).toHaveLength(0); expect(deploy.commits).toHaveLength(0); expect(dns.upserts).toHaveLength(0); expect(dns.creates).toHaveLength(0); expect(dns.deletes).toHaveLength(0);
    db.sqlite.prepare("UPDATE runs SET status='running' WHERE id='run_source'").run();
    await expect(rollback.steps(planned.params)[0]!.run(ctx("run_rollback"))).rejects.toThrow(/no longer stopped/);
  });
  it("dry-run step cannot reach the writer and apply approval refuses cutover blockers", async () => {
    seed("prod"); dns.seed(`post.${TO}`, "A", "192.0.2.9"); const snapshot = await readInstallationDomain(db.db, ports(), FROM, TO);
    let writes = 0;
    const def = makeInstallationDomainDef({ read: async () => snapshot, validateRollback: async () => undefined, apply: async () => { writes++; }, ...createInstallationDomainIssuers(undefined) });
    const params = { fromDomain: FROM, toDomain: TO, dryRun: true, snapshot };
    for (const step of def.steps(params)) await step.run(ctx());
    expect(writes).toBe(0); expect(def.steps(params)).toHaveLength(1);
    await expect(def.assertApprovable!({ ...params, dryRun: false }, {} as never)).rejects.toThrow(/cutover blockers/);
  });
});
