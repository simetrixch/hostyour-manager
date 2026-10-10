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
import { makeTenantSetDisplayNameDef, type TenantSetDisplayNamePorts } from "./tenant-display-name.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";

// tenant-set-display-name driven through the real Executor: the name recorded on the registration and
// the row and awaited in every member's render, a clear back to no name, the abort that writes the
// previous name back, and the plan's refusals.

const GUID = "zsjs023ctne0";
const CLUSTER = "s1.example";
const DEPLOY_REPO = "https://github.com/acme/acme-deploy.git";
const NAME = "Müller & O'Brien";
const MEMBERS = ["auth", "jobs", "report"];

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

/** Every member Synced + Healthy, each chart rendering `name` as tenant.displayName. */
function rendering(name: string): Map<string, ArgoAppStatus> {
  return new Map(MEMBERS.map((m) => [`${GUID}-${m}-prod`, {
    sync: "Synced", health: "Healthy", syncRevision: null, targetRevision: null,
    syncSources: [{ repoURL: DEPLOY_REPO, revision: "abc", path: `charts/example-${m}`, valuesObject: { tenant: { displayName: name } } }],
  } as ArgoAppStatus]));
}

describe("tenant-set-display-name through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { displayName?: string; renders?: string; suspended?: boolean; status?: "provisioning" | "active" | "offboarded" | "purged" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-displayname-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const displayName = opts.displayName ?? "";
    const reg = new TenantRegistrations(new FakePlatformRepo());
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
      members: MEMBERS, identityProvider: "auth", displayName, suspended: opts.suspended ?? false, status: opts.status ?? "active",
    }).run();
    await reg.commitTenant({
      stage: "prod", guid: GUID, runId: "run_crt",
      registration: {
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "",
        displayName, seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const def = makeTenantSetDisplayNameDef({
      registrations: reg,
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader({ statuses: rendering(opts.renders ?? displayName) }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      deployRepoUrl: DEPLOY_REPO, argoWatchTimeoutMs: 1000,
    } as unknown as TenantSetDisplayNamePorts);
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-display-name", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const row = () => db.db.select({ n: tenants.displayName }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.n;
    const registered = async () => (await reg.readTenant("prod", GUID))?.entry.displayName;
    return { db, executor, reg, row, registered };
  }

  async function set(h: Awaited<ReturnType<typeof make>>, displayName: string, previous = ""): Promise<string> {
    const { runId } = await h.executor.plan("tenant-set-display-name", { tenantId: "tnt_1", displayName, previous });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    return runId;
  }

  it("records the name on the registration and the row and waits until every member renders it", async () => {
    const h = await make({ renders: NAME });
    const runId = await set(h, NAME);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.row()).toBe(NAME);
    expect(await h.registered()).toBe(NAME);
  });

  it("clears the name back to none", async () => {
    const h = await make({ displayName: NAME, renders: "" });
    const runId = await set(h, "", NAME);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.row()).toBe("");
    expect(await h.registered()).toBe("");
  });

  it("does not take Synced for the new name: an old render fails the wait, and the abort writes the previous one back", async () => {
    const h = await make({ renders: "" });
    const runId = await set(h, NAME);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.row()).toBe(NAME);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.row()).toBe("");
    expect(await h.registered()).toBe("");
  });

  it("PLANTED DEFECT: an abort after the registration was written and the row update failed writes the previous name back to both", async () => {
    const h = await make();
    // The row update fails once the registration carries the new name: the process dying between the two acts.
    h.db.sqlite.exec("CREATE TRIGGER planted_row_failure BEFORE UPDATE OF display_name ON tenants BEGIN SELECT RAISE(ABORT, 'planted row failure'); END");
    const runId = await set(h, NAME);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect([await h.registered(), h.row()]).toEqual([NAME, ""]);
    h.db.sqlite.exec("DROP TRIGGER planted_row_failure");
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect([await h.registered(), h.row()]).toEqual(["", ""]);
  });

  it("PLANTED: refuses a name post cannot parse, naming the field", async () => {
    const h = await make();
    for (const name of ["A, B", "A <b>", 'A "B"', "x".repeat(65)]) {
      await expect(h.executor.plan("tenant-set-display-name", { tenantId: "tnt_1", displayName: name, previous: "" })).rejects.toThrow(/displayName/);
    }
  });

  it("PLANTED: an abort leaves a name another writer set since, on the registration and the row", async () => {
    // This run fails at its wait and stands with its name written.
    const h = await make({ renders: "" });
    const runId = await set(h, NAME);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    // Another writer names the tenant since.
    await h.reg.setDisplayName("prod", GUID, "Other", "run_other");
    h.db.db.update(tenants).set({ displayName: "Other" }).where(eq(tenants.id, "tnt_1")).run();
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(h.row()).toBe("Other");
    expect(await h.registered()).toBe("Other");
  });

  it("PLANTED: the write step refuses a row that carries neither the planned previous name nor the new one", async () => {
    const h = await make({ renders: NAME });
    const { runId } = await h.executor.plan("tenant-set-display-name", { tenantId: "tnt_1", displayName: NAME, previous: "" });
    h.db.db.update(tenants).set({ displayName: "Other" }).where(eq(tenants.id, "tnt_1")).run();
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.row()).toBe("Other");
    expect(await h.registered()).toBe("");
  });

  it("refuses a tenant still provisioning, and one offboarded or purged", async () => {
    const plan = (h: Awaited<ReturnType<typeof make>>) => h.executor.plan("tenant-set-display-name", { tenantId: "tnt_1", displayName: NAME, previous: "" });
    await expect(plan(await make({ status: "provisioning" }))).rejects.toThrow(/still provisioning/);
    await expect(plan(await make({ status: "offboarded" }))).rejects.toThrow(/is offboarded/);
    await expect(plan(await make({ status: "purged" }))).rejects.toThrow(/is purged/);
  });

  it("refuses a request whose previous name moved, and a suspended tenant", async () => {
    const h = await make({ displayName: "Other" });
    await expect(h.executor.plan("tenant-set-display-name", { tenantId: "tnt_1", displayName: NAME, previous: "" })).rejects.toThrow(/is named "Other", not no name/);
    const s = await make({ suspended: true });
    await expect(s.executor.plan("tenant-set-display-name", { tenantId: "tnt_1", displayName: NAME, previous: "" })).rejects.toThrow(/suspended/);
  });
});
