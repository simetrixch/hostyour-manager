import { afterEach } from "vitest";
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
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetOwnDomainDef } from "./tenant-own-domain.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicDns } from "../../adapters/dns/testing/fake-public-dns.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import type { Stage } from "../../../shared/enums.ts";


// The tenant-set-own-domain run driven through the real Executor: a tenant with its registration, its
// DNS and probe fakes, and the plan, approve and settle a test drives it with.

export const GUID = "zsjs023ctne0";
export const CLUSTER = "s1.example";
export const ZONE = "acme.example.com";
export const OWN = "www.customer.test";
export const OTHER = "shop.customer.test";
export const BARE = "customer.test";
/** The address the own-domain run waits on: the health of the tenant's identity provider, `auth`, at the host. */
export const healthAt = (host: string): string => `https://${host}/auth/health`;
export const OK = { reachable: true, status: 200, detail: "HTTP 200" };
const REDIRECTS = { reachable: true, status: 307, detail: "HTTP 307" };

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));


/** A harness per describe: each tenant it makes gets its own database, closed after each test. */
export function useOwnDomainHarness() {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { ownDomain?: string; ownDomainRedirects?: string[]; answers?: string[]; redirecting?: string[]; unmanaged?: string[]; stage?: Stage } = {}) {
    const stage = opts.stage ?? "prod";
    const dir = mkdtempSync(join(tmpdir(), "mgr-owndomain-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const ownDomain = opts.ownDomain ?? "";
    const ownDomainRedirects = opts.ownDomainRedirects ?? [];
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const dns = new FakeDnsProvider();
    const publicDns = new FakePublicDns();
    dns.unmanaged = opts.unmanaged ?? [];
    dns.seed(ZONE, "CNAME", CLUSTER);
    const probe = new FakePublicProbe(Object.fromEntries([
      ...(opts.answers ?? []).map((host) => [healthAt(host), OK]),
      ...(opts.redirecting ?? []).map((host) => [`https://${host}/`, REDIRECTS]),
    ]));
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage, domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage,
      members: ["auth", "jobs", "report"], identityProvider: "auth", identityProviderPath: "/auth", ownDomain, ownDomainRedirects, suspended: false, status: "active",
    }).run();
    await reg.commitTenant({
      stage, guid: GUID, runId: "run_crt",
      registration: {
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", ownDomain, ownDomainRedirects, approvedTags: {}, senderDomain: "", displayName: "",
        seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const def = makeTenantSetOwnDomainDef({
      registrations: reg,
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage, writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      deployRepoUrl: "https://github.com/acme/acme-deploy.git", argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com",
      dns, publicDns, probe, answerWaitMs: 0, answerPollMs: 0,
    });
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-own-domain", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")),
    });
    const rowDomain = (): string | undefined => db.db.select({ d: tenants.ownDomain }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.d;
    const regDomain = async (): Promise<string | undefined> => (await reg.readTenant(stage, GUID))?.entry.ownDomain;
    const rowRedirects = (): string[] | undefined => db.db.select({ r: tenants.ownDomainRedirects }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.r;
    const regRedirects = async (): Promise<string[] | undefined> => (await reg.readTenant(stage, GUID))?.entry.ownDomainRedirects;
    const rowAliases = (): string[] | undefined => db.db.select({ a: tenants.ownDomainAliases }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.a;
    const regAliases = async (): Promise<string[]> => (await reg.readTenant(stage, GUID))?.entry.ownDomainAliases ?? [];
    return { db, reg, dns, publicDns, probe, executor, rowDomain, regDomain, rowRedirects, regRedirects, rowAliases, regAliases };
  }

  /** The streamed plan the route starts, settled: its run, status and summary, and its log, which says
   *  why a refused plan was refused. */
  async function plan(h: Awaited<ReturnType<typeof make>>, request: Record<string, unknown>): Promise<{ runId: string; status: string | undefined; summary: string; error: string }> {
    const { runId } = await h.executor.planStreamed("tenant-set-own-domain", { tenantId: "tnt_1", ...request });
    await h.executor.settle(runId);
    const run = getRun(h.db.db, runId);
    return { runId, status: run?.status, summary: run?.summary ?? "", error: readEvents(h.db.db, runId).map((e) => e.text).join("\n") };
  }

  async function move(h: Awaited<ReturnType<typeof make>>, ownDomain: string, previous: string, redirects: { ownDomainRedirects?: string[]; previousRedirects?: string[]; ownDomainAliases?: string[]; previousAliases?: string[] } = {}): Promise<string> {
    const { runId } = await plan(h, { ownDomain, previous, ...redirects });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    return runId;
  }
  return { make, plan, move };
}
