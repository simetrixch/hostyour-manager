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
import { getRun } from "../../executor/read.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetSenderDomainDef, type TenantSetSenderDomainPorts } from "./tenant-sender-domain.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
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

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

const manifest = (check: string | null): string => `apiVersion: hostyour.cloud/v1
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
${check ? `  senderDomainCheck: ${check}\n` : ""}`;

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

  async function make(opts: { senderDomain?: string; renders?: string; answer?: { status: number; body?: string }; check?: string | null; suspended?: boolean } = {}) {
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
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain,
        seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const probe = new FakePublicProbe();
    const answer = opts.answer ?? { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: true }) };
    probe.set(ASKED, { reachable: answer.status < 500 && answer.status !== 404, status: answer.status, detail: `HTTP ${answer.status}`, ...(answer.body !== undefined ? { body: answer.body } : {}) });
    const def = makeTenantSetSenderDomainDef({
      registrations: reg,
      repo: new FakeRepoReader({ resolvedSha: "a".repeat(40), files: { "deploy/platform.yaml": manifest(opts.check === undefined ? CHECK : opts.check) } }),
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader({ statuses: rendering(opts.renders ?? senderDomain) }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      deployRepoUrl: DEPLOY_REPO, argoWatchTimeoutMs: 1000, probe,
      resolveClusterValueFiles: async () => [{ path: "clusters/s1.yaml", content: "global:\n  unitApex: example.com\n" }],
    } as unknown as TenantSetSenderDomainPorts);
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-sender-domain", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const row = () => db.db.select({ d: tenants.senderDomain }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.d;
    const registered = async () => (await reg.readTenant("prod", GUID))?.entry.senderDomain;
    return { db, executor, probe, row, registered };
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
});
