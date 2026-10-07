import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetSenderDomainDef, type TenantSetSenderDomainPorts } from "./tenant-sender-domain.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { FakeUnitCall, type UnitCallRequest } from "#unit/server/adapters/unit-call/testing/fake.ts";
import { keepUnitCallKey } from "#unit/server/unit-call-key.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";

// tenant-set-sender-domain driven through the real Executor: the product's check asked before anything
// is written, the domain recorded and awaited in every member's render, a clear that asks nothing, the
// abort that writes the previous domain back, and the plan's refusals.

const GUID = "zsjs023ctne0";
const CLUSTER = "s1.example";
const DEPLOY_REPO = "https://github.com/acme/acme-deploy.git";
const DOMAIN = "customer.test";
const CHECK = "https://post.{stageApex}/api/public/sender-domains/{domain}";
const ASKED = `https://post.example.com/api/public/sender-domains/${DOMAIN}`;
const MEMBERS = ["auth", "jobs", "report"];
const ISSUERS_ROUTE = "https://post.{stageApex}/api/internal/sender-domains/{domain}/issuers";
const BOUND_AT = (domain: string) => `https://post.example.com/api/internal/sender-domains/${domain}/issuers`;
/** The prod stage's service issuer: the identity provider on the tenant's zone, host routing. */
const ISSUER = "https://auth.acme.example.com";
const OTHER_ISSUER = "https://shop.example.org/auth";
const KEPT = "k".repeat(64);

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

const manifest = (check: string | null, issuers: boolean): string => `apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme-deploy
owner: platform
envs: [prod]
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
  buildRepos: []
${check ? `  senderDomainCheck: ${check}\n` : ""}${issuers ? `  senderDomainIssuers: { url: "${ISSUERS_ROUTE}", unit: post }\n` : ""}`;

/** post's issuer lists per sender domain, answering the Manager's route as post does: only with the
 *  kept key, one issuer added or removed, the others kept; `status` forces one answer instead. */
function fakePost(lists: Record<string, string[]>, status?: number[]): FakeUnitCall {
  return new FakeUnitCall((req: UnitCallRequest) => {
    const forced = status?.shift();
    if (forced !== undefined) return { status: forced, detail: `HTTP ${forced}` };
    if (req.key !== KEPT) return { status: 401, detail: "HTTP 401" };
    const domain = decodeURIComponent(req.url.split("/sender-domains/")[1]!.split("/")[0]!);
    const issuer = (req.body as { issuer: string }).issuer;
    const list = lists[domain] ?? [];
    const had = list.includes(issuer);
    lists[domain] = req.method === "PUT" ? (had ? list : [...list, issuer]) : list.filter((i) => i !== issuer);
    return { status: 200, detail: "HTTP 200", body: req.method === "PUT" ? { added: !had } : { removed: had } };
  });
}

/** Every member Synced + Healthy, each chart rendering `domain` as tenant.senderDomain. */
function rendering(domain: string): Map<string, ArgoAppStatus> {
  return new Map(MEMBERS.map((m) => [`${GUID}-${m}-prod`, {
    sync: "Synced", health: "Healthy", syncRevision: null, targetRevision: null,
    syncSources: [{ repoURL: DEPLOY_REPO, revision: "abc", path: `charts/example-${m}`, valuesObject: { tenant: { senderDomain: domain } } }],
  } as ArgoAppStatus]));
}

describe("tenant-set-sender-domain through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { senderDomain?: string; renders?: string; answer?: { status: number; body?: string }; check?: string | null; suspended?: boolean; issuers?: boolean; kept?: boolean; post?: FakeUnitCall } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-senderdomain-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const senderDomain = opts.senderDomain ?? "";
    const reg = new TenantRegistrations(new FakePlatformRepo());
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
      members: MEMBERS, identityProvider: "auth", senderDomain, suspended: opts.suspended ?? false, status: "active",
    }).run();
    await reg.commitTenant({
      stage: "prod", guid: GUID, runId: "run_crt",
      registration: {
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain, displayName: "",
        seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const creds = new CredentialStore({ db: db.db, logger });
    if (opts.kept ?? opts.issuers) await keepUnitCallKey(creds, { unit: "post", stage: "prod", key: "POST_MANAGER_KEY", value: KEPT });
    const post = opts.post ?? fakePost({});
    const probe = new FakePublicProbe();
    const answer = opts.answer ?? { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: true }) };
    probe.set(ASKED, { reachable: answer.status < 500 && answer.status !== 404, status: answer.status, detail: `HTTP ${answer.status}`, ...(answer.body !== undefined ? { body: answer.body } : {}) });
    const def = makeTenantSetSenderDomainDef({
      registrations: reg,
      repo: new FakeRepoReader({ resolvedSha: "a".repeat(40), files: { "deploy/platform.yaml": manifest(opts.check === undefined ? CHECK : opts.check, opts.issuers ?? false) } }),
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader({ statuses: rendering(opts.renders ?? senderDomain) }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      deployRepoUrl: DEPLOY_REPO, argoWatchTimeoutMs: 1000, probe, unitCall: post, store: creds,
      resolveClusterValueFiles: async () => [{ path: "clusters/s1.yaml", content: "global:\n  unitApex: example.com\n" }],
    } as unknown as TenantSetSenderDomainPorts);
    const executor = new Executor({
      db: db.db, creds, bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-sender-domain", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const row = () => db.db.select({ d: tenants.senderDomain }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.d;
    const registered = async () => (await reg.readTenant("prod", GUID))?.entry.senderDomain;
    return { db, executor, probe, row, registered, reg, post };
  }

  async function set(h: Awaited<ReturnType<typeof make>>, senderDomain: string, previous = ""): Promise<string> {
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain, previous });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    return runId;
  }

  it("asks the product's check at the tenant's stage apex, then records the domain and waits for every member", async () => {
    const h = await make({ renders: DOMAIN });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.probe.probed).toEqual([ASKED]);
    expect(h.row()).toBe(DOMAIN);
    expect(await h.registered()).toBe(DOMAIN);
  });

  it("clears the domain without asking anything", async () => {
    const h = await make({ senderDomain: DOMAIN, renders: "" });
    const runId = await set(h, "", DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.probe.probed).toEqual([]);
    expect(h.row()).toBe("");
  });

  it("does not take Synced for the new domain: an old render fails the wait, and the abort writes the previous one back", async () => {
    const h = await make({ renders: "" });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.row()).toBe(DOMAIN);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.row()).toBe("");
    expect(await h.registered()).toBe("");
  });

  it("PLANTED DEFECT: an abort after the registration was written and the row update failed writes the previous domain back to both", async () => {
    const h = await make();
    // The row update fails once the registration carries the new domain: the process dying between the two acts.
    h.db.sqlite.exec("CREATE TRIGGER planted_row_failure BEFORE UPDATE OF sender_domain ON tenants BEGIN SELECT RAISE(ABORT, 'planted row failure'); END");
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect([await h.registered(), h.row()]).toEqual([DOMAIN, ""]);
    h.db.sqlite.exec("DROP TRIGGER planted_row_failure");
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect([await h.registered(), h.row()]).toEqual(["", ""]);
  });

  it("PLANTED INNOCENT: an abort leaves a domain another writer registered since as it is", async () => {
    const h = await make({ renders: "" });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    await h.reg.setSenderDomain("prod", GUID, "other.test", "run_other");
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(await h.registered()).toBe("other.test");
  });

  describe("the stage's service issuer at the product's mail service", () => {
    it("binds it beside the issuers already there before the registration is written, with the kept key", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [OTHER_ISSUER] };
      const h = await make({ issuers: true, renders: DOMAIN, post: fakePost(lists) });
      const runId = await set(h, DOMAIN);
      expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
      expect(h.post.calls).toEqual([{ method: "PUT", url: BOUND_AT(DOMAIN), key: KEPT, body: { issuer: ISSUER } }]);
      expect(lists[DOMAIN]).toEqual([OTHER_ISSUER, ISSUER]);
      expect(getRun(h.db.db, runId)?.steps.map((st) => st.name)).toEqual(["attest-target", "bind-issuer", "write-sender-domain", "watch-members", "unbind-previous-issuer"]);
    });

    it("an abort takes back only the issuer this run added", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [OTHER_ISSUER] };
      const h = await make({ issuers: true, renders: "", post: fakePost(lists) });
      const runId = await set(h, DOMAIN);
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      await h.executor.abortWithCleanup(runId);
      await h.executor.settle(runId);
      expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
      expect(lists[DOMAIN]).toEqual([OTHER_ISSUER]);
      expect(await h.registered()).toBe("");
    });

    it("PLANTED INNOCENT: an abort leaves an issuer the domain already named before the run", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [ISSUER] };
      const h = await make({ issuers: true, renders: "", post: fakePost(lists) });
      const runId = await set(h, DOMAIN);
      await h.executor.abortWithCleanup(runId);
      await h.executor.settle(runId);
      expect(lists[DOMAIN]).toEqual([ISSUER]);
    });

    it("moving to another domain binds it there and, once every member renders it, takes it from the previous one", async () => {
      const lists: Record<string, string[]> = { "old.test": [ISSUER, OTHER_ISSUER], [DOMAIN]: [] };
      const h = await make({ issuers: true, senderDomain: "old.test", renders: DOMAIN, post: fakePost(lists) });
      const runId = await set(h, DOMAIN, "old.test");
      expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
      expect(h.post.calls.map((c) => [c.method, c.url])).toEqual([["PUT", BOUND_AT(DOMAIN)], ["DELETE", BOUND_AT("old.test")]]);
      expect(lists).toEqual({ "old.test": [OTHER_ISSUER], [DOMAIN]: [ISSUER] });
    });

    it("clearing the domain binds nothing and takes the issuer from the former domain; a product without the route is never called", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [ISSUER] };
      const h = await make({ issuers: true, senderDomain: DOMAIN, renders: "", post: fakePost(lists) });
      expect(getRun(h.db.db, await set(h, "", DOMAIN))?.status).toBe("succeeded");
      expect(h.post.calls.map((c) => c.method)).toEqual(["DELETE"]);
      expect(lists[DOMAIN]).toEqual([]);
      const plain = await make({ renders: DOMAIN });
      expect(getRun(plain.db.db, await set(plain, DOMAIN))?.status).toBe("succeeded");
      expect(plain.post.calls).toEqual([]);
    });

    it("asks once more after a race inside the product (409)", async () => {
      const lists: Record<string, string[]> = {};
      const h = await make({ issuers: true, renders: DOMAIN, post: fakePost(lists, [409]) });
      expect(getRun(h.db.db, await set(h, DOMAIN))?.status).toBe("succeeded");
      expect(h.post.calls).toHaveLength(2);
      expect(lists[DOMAIN]).toEqual([ISSUER]);
    });

    it("refuses at the plan without a kept key, and fails naming the repair when the product refuses the key or holds none", async () => {
      await expect(set(await make({ issuers: true, kept: false }), DOMAIN)).rejects.toThrow(/keeps no key for post \(prod\).*"Secrets…" on post \(prod\)/);
      const clearing = await make({ issuers: true, senderDomain: DOMAIN, kept: false });
      await expect(set(clearing, "", DOMAIN)).rejects.toThrow(/keeps no key for post \(prod\)/);
      expect([await clearing.registered(), clearing.row()]).toEqual([DOMAIN, DOMAIN]);
      for (const [status, says] of [[401, /refused the key the Manager keeps for it \(401\)/], [503, /holds no Manager key yet \(503\)/], [404, /does not know customer\.test as a sender domain/], [200, /answered 200 without "added"/]] as const) {
        const h = await make({ issuers: true, renders: DOMAIN, post: fakePost({}, [status]) });
        const runId = await set(h, DOMAIN);
        expect(getRun(h.db.db, runId)?.status).toBe("failed");
        expect(readEvents(h.db.db, runId).map((e) => e.text).join("\n")).toMatch(says);
        expect(await h.registered()).toBe("");
      }
    });
  });

  it("refuses a domain whose mail is not signed, one the product does not know, and a product that declares no check", async () => {
    const plan = (h: Awaited<ReturnType<typeof make>>) => h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    await expect(plan(await make({ answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) } }))).rejects.toThrow(/is not signed yet/);
    await expect(plan(await make({ answer: { status: 404 } }))).rejects.toThrow(/does not know customer\.test/);
    await expect(plan(await make({ answer: { status: 200, body: "<html>" } }))).rejects.toThrow(/answered no JSON/);
    await expect(plan(await make({ check: null }))).rejects.toThrow(/declares no senderDomainCheck/);
  });

  it("refuses a request whose previous domain moved, and a suspended tenant", async () => {
    const h = await make({ senderDomain: "other.test" });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" })).rejects.toThrow(/sends as other\.test/);
    const s = await make({ suspended: true });
    await expect(s.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" })).rejects.toThrow(/suspended/);
  });

  it("refuses a sender domain another tenant of the same stage sends from, naming it", async () => {
    const h = await make();
    const otherGuid = "e2e8ymj86dk8";
    await h.reg.commitTenant({
      stage: "prod",
      guid: otherGuid,
      runId: "run_other",
      registration: {
        cluster: "s1",
        subdomain: "other",
        apps: [],
        members: testMembers(),
        identityProvider: "auth",
        routing: "host",
        ownDomain: "",
        ownDomainRedirects: [],
        approvedTags: {},
        senderDomain: DOMAIN,
        displayName: "",
        seedUsers: false,
        quota: TEST_QUOTA,
        resetNonce: "1",
        suspended: false,
        quiesced: false,
        appsImage: "",
        appsImageTag: "",
      },
    });
    await expect(
      h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }),
    ).rejects.toThrow("tenant acme cannot send as customer.test — tenant other of prod already sends from it; a stage's tenants send from different domains");
  });

  it("plans a sender domain that another tenant sends from at another stage", async () => {
    const h = await make();
    const otherGuid = "e2e8ymj86dk8";
    await h.reg.commitTenant({
      stage: "test",
      guid: otherGuid,
      runId: "run_other_test",
      registration: {
        cluster: "s1",
        subdomain: "other",
        apps: [],
        members: testMembers(),
        identityProvider: "auth",
        routing: "host",
        ownDomain: "",
        ownDomainRedirects: [],
        approvedTags: {},
        senderDomain: DOMAIN,
        displayName: "",
        seedUsers: false,
        quota: TEST_QUOTA,
        resetNonce: "1",
        suspended: false,
        quiesced: false,
        appsImage: "",
        appsImageTag: "",
      },
    });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    expect(runId).toMatch(/^run_/);
  });

  it("plans clearing the sender domain to empty", async () => {
    const h = await make({ senderDomain: DOMAIN });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: "", previous: DOMAIN });
    expect(runId).toMatch(/^run_/);
  });
});
