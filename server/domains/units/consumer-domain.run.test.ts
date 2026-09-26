import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { getRun } from "../../executor/read.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { servers, clusters, apps, tenants } from "../../db/schema/inventory.ts";
import { findDnsWrite } from "../../db/dns-writes.ts";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { makeConsumerSetDomainDef } from "./consumer-domain.run.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";

// consumer-set-domain driven through the real Executor: the new domain's record onto the platform host,
// the domain on the stage registration, a 2xx at the new domain, only then the previous domain's record
// gone; the abort; and the plan's refusals.

const CLUSTER = "s1.example";
const APEX = "example.com";
const HOST = `acme.${APEX}`;
const SHOP = "shop.customer.test";
const STORE = "store.customer.test";
const OK = { reachable: true, status: 200, detail: "HTTP 200" };

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

describe("consumer-set-domain through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { fqdn?: string; answers?: string[]; status?: "active" | "suspended" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-consumerdomain-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    seedUnitSizes(db.db);
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    repo.seed(repo.booksBranch, clusterMapPath(CLUSTER), `global:\n  unitApex: ${APEX}\n`);
    const dns = new FakeDnsProvider();
    const probe = new FakePublicProbe(Object.fromEntries((opts.answers ?? []).map((h) => [`https://${h}/`, OK])));
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: opts.status ?? "active" }).run();
    await reg.commitRegistration({
      unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
      builds: [],
      deploy: { stage: "prod", host: "acme", chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"), ...(opts.fqdn ? { fqdn: opts.fqdn } : {}) },
      runId: "run_onb",
    });
    const def = makeConsumerSetDomainDef({
      registrations: reg,
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      argoWatchTimeoutMs: 1000, dns, probe, domainWaitMs: 0, domainPollMs: 0,
    });
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["consumer-set-domain", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const domain = async (): Promise<string | undefined> => (await reg.readRegistration("prod", "acme"))?.entry.fqdn;
    return { db, dns, probe, executor, domain };
  }

  async function move(h: Awaited<ReturnType<typeof make>>, fqdn: string, previous: string): Promise<string> {
    const { runId } = await h.executor.plan("consumer-set-domain", { appId: "app_1", fqdn, previous });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    return runId;
  }

  it("sets a domain: its record onto the platform host, the domain on the registration, a 2xx at it", async () => {
    const h = await make({ answers: [SHOP] });
    const runId = await move(h, SHOP, "");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(SHOP, "CNAME")).toBe(HOST);
    expect(findDnsWrite(h.db.db, { name: SHOP, type: "CNAME" })?.owner).toEqual({ kind: "consumer", name: "acme", stage: "prod" });
    expect(await h.domain()).toBe(SHOP);
    expect(h.probe.probed).toContain(`https://${SHOP}/`);
  });

  it("switches: the previous domain's record goes only after the new domain answers", async () => {
    const h = await make({ answers: [SHOP] });
    expect(getRun(h.db.db, await move(h, SHOP, ""))?.status).toBe("succeeded");
    h.probe.set(`https://${STORE}/`, OK);
    const runId = await move(h, STORE, SHOP);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(STORE, "CNAME")).toBe(HOST);
    expect(h.dns.record(SHOP, "CNAME")).toBeUndefined();
    expect(await h.domain()).toBe(STORE);
  });

  it("an abort after the failed wait records the previous domain again and removes the new record", async () => {
    const h = await make();
    const runId = await move(h, SHOP, "");
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.dns.record(SHOP, "CNAME")).toBe(HOST);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(await h.domain()).toBeUndefined();
    expect(h.dns.record(SHOP, "CNAME")).toBeUndefined();
  });

  it("keeps a standing domain across a second registration of the stage", async () => {
    const h = await make({ fqdn: SHOP });
    expect(await h.domain()).toBe(SHOP);
  });

  it("refuses what it cannot run", async () => {
    const h = await make({ fqdn: SHOP });
    const plan = (fqdn: string, previous: string) => h.executor.plan("consumer-set-domain", { appId: "app_1", fqdn, previous });
    await expect(plan(STORE, "")).rejects.toThrow(/answers at shop\.customer\.test at prod, not at no domain/);
    await expect(plan(`x.${APEX}`, SHOP)).rejects.toThrow();
    await expect(plan(`api.${CLUSTER}`, SHOP)).rejects.toThrow();
    h.db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "beta", stage: "prod", members: ["auth"], identityProvider: "auth",
      routing: "path", ownDomain: `www.${STORE}`, ownDomainRedirects: [STORE], suspended: false, status: "active",
    }).run();
    await expect(plan(STORE, SHOP)).rejects.toThrow(/tenant beta/);
  });

  it("refuses a suspended consumer: its new domain could never answer", async () => {
    const h = await make({ status: "suspended" });
    await expect(h.executor.plan("consumer-set-domain", { appId: "app_1", fqdn: SHOP, previous: "" })).rejects.toThrow(/suspended/);
  });
});
