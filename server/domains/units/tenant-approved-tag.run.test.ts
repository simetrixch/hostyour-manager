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
import type { AnyRunDefinition, StepCtx } from "../../executor/types.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetApprovedTagDef } from "./tenant-approved-tag.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";

// tenant-set-approved-tag driven through the real Executor: an approval recorded and awaited in the
// member's render, a cleared one removed, the abort that writes the previous approval back, and the
// plan's refusals.

const GUID = "zsjs023ctne0";
const CLUSTER = "s1.example";
const DEPLOY_REPO = "https://github.com/acme/acme-deploy.git";
const MEMBER_APP = `${GUID}-erp-prod`;
const BUILD = "acme-app";
const IMAGE = "acme/acme-app";
const TAG = "0.1.12-stable-20260925120000-abc1234";
const OLD = "0.1.11-stable-20260920120000-def5678";
type Approvals = Record<string, Record<string, string>>;

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

/** The erp member at `sync` and Healthy, every deploy-repo chart rendering `approved` as tenant.approvedTags. */
function rendering(approved: Approvals, sync: ArgoAppStatus["sync"] = "Synced"): ArgoAppStatus {
  const chart = (path: string) => ({ repoURL: DEPLOY_REPO, revision: "abc", path, valuesObject: { tenant: { approvedTags: approved } } });
  return {
    sync, health: "Healthy", syncRevision: null, targetRevision: null,
    syncSources: [chart("charts/example-engine"), chart("charts/example-ui")],
  };
}

describe("tenant-set-approved-tag through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { approvedTags?: Approvals; renders?: Approvals; sync?: ArgoAppStatus["sync"]; missing?: string[]; suspended?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-approvedtag-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const approvedTags = opts.approvedTags ?? {};
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(reg.branch, "charts/example-engine/pins-prod.yaml", `builds:\n  - name: ${BUILD}\n    image: ${IMAGE}\n    tag: ${OLD}\n`);
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
      members: ["auth", "jobs", "report", "erp"], identityProvider: "auth", approvedTags, suspended: opts.suspended ?? false, status: "active",
    }).run();
    await reg.commitTenant({
      stage: "prod", guid: GUID, runId: "run_crt",
      registration: {
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(["erp"]), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags,
        seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const registryProbe = new FakeRegistryProbe({ missing: opts.missing ?? [] });
    const argoReader = new FakeMasterArgoReader({ statuses: new Map([[MEMBER_APP, rendering(opts.renders ?? approvedTags, opts.sync)]]) });
    const def = makeTenantSetApprovedTagDef({
      registrations: reg,
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader, projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      catalogRepoUrl: DEPLOY_REPO, argoWatchTimeoutMs: 1000, registryProbe,
      resolveClusterValueFiles: async () => [{ path: "clusters/s1.yaml", content: "global:\n  endpoints:\n    registry:\n      host: zot.s1.example\n" }],
    } as unknown as TenantOnboardPorts);
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-approved-tag", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const rowTags = () => db.db.select({ t: tenants.approvedTags }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.t;
    const regTags = async () => (await reg.readTenant("prod", GUID))?.entry.approvedTags;
    return { db, def, executor, registryProbe, rowTags, regTags };
  }

  const params = (tag: string, previous = "", over: Record<string, string> = {}) => ({ tenantId: "tnt_1", app: "erp", build: BUILD, tag, previous, ...over });

  async function approve(h: Awaited<ReturnType<typeof make>>, tag: string, previous = ""): Promise<string> {
    const { runId } = await h.executor.plan("tenant-set-approved-tag", params(tag, previous));
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    return runId;
  }

  it("approves a tag: the registry is asked, the registration and the row carry it, the member renders it", async () => {
    const h = await make({ renders: { erp: { [BUILD]: TAG } } });
    const runId = await approve(h, TAG);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.registryProbe.probes).toEqual([`${IMAGE}:${TAG}`]);
    expect(h.rowTags()).toEqual({ erp: { [BUILD]: TAG } });
    expect(await h.regTags()).toEqual({ erp: { [BUILD]: TAG } });
  });

  it("clears an approval by removing its key, the app's key with it", async () => {
    const h = await make({ approvedTags: { erp: { [BUILD]: OLD } }, renders: {} });
    const runId = await approve(h, "", OLD);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.rowTags()).toEqual({});
    expect(await h.regTags()).toEqual({});
  });

  it("does not take Synced for the new tag: a render of the old approval fails the wait, and the abort writes it back", async () => {
    const h = await make({ approvedTags: { erp: { [BUILD]: OLD } } });
    const runId = await approve(h, TAG, OLD);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.rowTags()).toEqual({ erp: { [BUILD]: TAG } });
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.rowTags()).toEqual({ erp: { [BUILD]: OLD } });
    expect(await h.regTags()).toEqual({ erp: { [BUILD]: OLD } });
  });

  it("names the tenant whose member did not converge, as the other tenant runs do", async () => {
    const h = await make({ sync: "OutOfSync" });
    const watch = h.def.steps(params(TAG)).find((s) => s.name === "watch-member")!;
    const ctx = { db: h.db.db, signal: new AbortController().signal, log: () => undefined } as unknown as StepCtx;
    await expect(watch.run(ctx)).rejects.toThrow(new RegExp(`^tenant ${GUID} fan-out did not converge — .*${MEMBER_APP}`));
  });

  it("refuses what it cannot run", async () => {
    const h = await make({ approvedTags: { erp: { [BUILD]: OLD } }, missing: [`${IMAGE}:${TAG}`] });
    const plan = (p: ReturnType<typeof params>) => h.executor.plan("tenant-set-approved-tag", p);
    await expect(plan(params(TAG, ""))).rejects.toThrow(/carries 0\.1\.11.*not no approval/);
    await expect(plan(params(OLD, OLD))).rejects.toThrow(/already runs/);
    await expect(plan({ ...params(TAG, OLD), app: "crm", previous: "" })).rejects.toThrow(/no app or member "crm"/);
    await expect(plan({ ...params(TAG, OLD), build: "other", previous: "" })).rejects.toThrow(/pins a build "other".*name acme-app/);
    await expect(plan(params(TAG, OLD))).rejects.toThrow(/not in the registry/);
    await expect(plan(params("latest", OLD))).rejects.toThrow();
  });

  it("refuses a suspended tenant: its members render nothing to wait for", async () => {
    const h = await make({ suspended: true });
    await expect(h.executor.plan("tenant-set-approved-tag", params(TAG))).rejects.toThrow(/suspended/);
  });
});
