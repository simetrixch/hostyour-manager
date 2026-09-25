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
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetRoutingDef } from "./tenant-routing.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicProbe } from "../../adapters/http-probe/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import type { MemberRouting, TenantStatus } from "../../../shared/enums.ts";

// tenant-set-routing driven through the real Executor: the abort, the refusal of an abort, and a skip
// go through the paths an operator's buttons take, not through the run's own closures.

const GUID = "zsjs023ctne0";
const CLUSTER = "s1.example";
const ZONE = "acme.example.com";
const WILDCARD = `*.${ZONE}`;
const PATH_IDP = `https://${ZONE}/auth/`;

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

describe("tenant-set-routing through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { routing?: MemberRouting; status?: TenantStatus; answers?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-routing-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const routing = opts.routing ?? "host";
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const dns = new FakeDnsProvider();
    dns.seed(routing === "host" ? WILDCARD : ZONE, "CNAME", CLUSTER);
    const probe = new FakePublicProbe(opts.answers ? { [PATH_IDP]: { reachable: true, status: 200, detail: "HTTP 200" } } : {});
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
      members: ["auth", "jobs", "report"], identityProvider: "auth", routing, suspended: false, status: opts.status ?? "active",
    }).run();
    await reg.commitTenant({
      stage: "prod", guid: GUID, runId: "run_crt",
      registration: {
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", routing, ownDomain: "", ownDomainRedirects: [],
        seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const def = makeTenantSetRoutingDef({
      registrations: reg,
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      catalogRepoUrl: "https://github.com/acme/acme-catalog.git", argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com",
      dns, probe, routingWaitMs: 0, routingPollMs: 0,
    });
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-routing", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const rowRouting = (): string | undefined => db.db.select({ routing: tenants.routing }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.routing;
    return { db, reg, dns, executor, rowRouting };
  }

  async function failedMove(h: Awaited<ReturnType<typeof make>>): Promise<string> {
    const { runId } = await h.executor.plan("tenant-set-routing", { tenantId: "tnt_1", routing: "path", previous: "host" });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    return runId;
  }

  it("an abort after the failed wait records the previous routing again and removes the requested record", async () => {
    const h = await make();
    const runId = await failedMove(h);
    expect(h.rowRouting()).toBe("path");
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.rowRouting()).toBe("host");
    expect((await h.reg.readTenant("prod", GUID))?.entry.routing).toBe("host");
    expect(h.dns.record(ZONE, "CNAME")).toBeUndefined();
    expect(h.dns.record(WILDCARD, "CNAME")).toBe(CLUSTER);
  });

  it("REFUSES the abort once the previous routing's record is gone, and leaves the run as it was", async () => {
    const h = await make();
    const runId = await failedMove(h);
    await h.dns.deleteRecord({ name: WILDCARD, type: "CNAME" });

    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/is gone/);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("skipping the failed wait removes nothing: the wait and the removal are one step", async () => {
    const h = await make();
    const runId = await failedMove(h);

    await h.executor.skipStep(runId, "retire-previous-record", "test");
    await h.executor.settle(runId);

    expect(h.dns.record(WILDCARD, "CNAME")).toBe(CLUSTER);
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("REFUSES at plan time a tenant that moved since the request, and a settled one", async () => {
    const moved = await make({ routing: "path" });
    await expect(moved.executor.plan("tenant-set-routing", { tenantId: "tnt_1", routing: "path", previous: "host" })).rejects.toThrow(/moved since/);
    const settled = await make({ status: "offboarded" });
    await expect(settled.executor.plan("tenant-set-routing", { tenantId: "tnt_1", routing: "path", previous: "host" })).rejects.toThrow(/offboarded/);
  });
});
