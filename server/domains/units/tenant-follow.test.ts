import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { errIllegalTransition, errResourceBusy } from "../../kernel/errors.ts";
import pino from "pino";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { followedVersions, followTenant, makeTenantFollower, type TenantFollowDeps } from "./tenant-follow.ts";
import { MEMBERS_CHANGED } from "./tenant-refresh-members.run.ts";
import type { RunStatus } from "../../../shared/enums.ts";
import type { TenantVersionPart } from "./tenant-versions.ts";

// A tenant that follows releases is moved by the Manager when a release run of a part it renders
// succeeds at its stage: through the Versions run, to the version the stage pins.

const GUID = "zsjs023ctne0";
const NEW = "0.1.12-stable-20260925120000-abc1234";
const OLD = "0.1.11-stable-20260920120000-def5678";

const pinsFile = (builds: Record<string, string>): string =>
  `builds:\n${Object.entries(builds).map(([name, tag]) => `  - { name: ${name}, image: ${name}, tag: "${tag}" }`).join("\n")}\n`;

/** The books: one tenant at prod whose erp member holds `engine`, and the engine pinned at NEW. */
function books(engine: string): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(["erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"),
    approvedTags: { erp: { "example-engine": engine } }, ...TEST_BUNDLE,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  repo.seed(repo.booksBranch, "charts/example-auth/pins-prod.yaml", pinsFile({ "example-auth": NEW }));
  repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile({ "example-engine": NEW }));
  return new TenantRegistrations(repo);
}

/** An executor that records what the follower asks of it. A plan it settles as failed refuses the
 *  approve, as the executor refuses a failed run; its first approve is refused as busy where
 *  `busyHolder` names the run holding the lock. */
function fakeExecutor(opts: { planStatus?: "planned" | "failed"; busyHolder?: string; approveError?: Error; endings?: Array<{ status: RunStatus; error: string | null }> } = {}) {
  const asked: string[] = [];
  const planned: unknown[] = [];
  let refused = false;
  return {
    asked,
    planned,
    planStreamed: async (_kind: string, params: unknown): Promise<{ runId: string }> => {
      planned.push(params);
      const runId = `run_${planned.length}`;
      asked.push(`plan ${runId}`);
      return { runId };
    },
    settle: async (runId: string): Promise<void> => { asked.push(`settle ${runId}`); },
    /** How each planned run ended, in planning order; a run with none given succeeded. */
    runEnding: (runId: string) => opts.endings?.[Number(runId.slice(4)) - 1] ?? { status: "succeeded" as const, error: null },
    discard: async (runId: string): Promise<void> => { asked.push(`discard ${runId}`); },
    approve: async (runId: string): Promise<void> => {
      asked.push(`approve ${runId}`);
      if (opts.planStatus === "failed") throw errIllegalTransition("run status failed → approved");
      if (opts.approveError) throw opts.approveError;
      if (opts.busyHolder && !refused) {
        refused = true;
        throw errResourceBusy("Resource busy", { resource: "git-branch", key: "deploy@books", holderRunId: opts.busyHolder });
      }
    },
  };
}

let h: DbHandle;
beforeEach(() => {
  h = openDb(":memory:");
  h.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  h.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report", "erp"], identityProvider: "auth", status: "active", followReleases: true }).run();
});
afterEach(() => { h.sqlite.close(); });

function deps(executor: ReturnType<typeof fakeExecutor>, engine = OLD): TenantFollowDeps {
  return {
    db: h.db,
    executor,
    runEnding: executor.runEnding,
    ports: { registrations: books(engine), attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: "example-auth", build: "example-auth" }] },
    logger: pino({ level: "silent" }),
  };
}

const part = (name: string, pins: string[], running: string[]): TenantVersionPart =>
  ({ name, builds: pins.map((pin, i) => ({ name: `${name}-${i}`, image: `${name}-${i}`, pin, released: [pin] })), running });

describe("followedVersions — what a following tenant moves", () => {
  it("moves a part a member runs at another version than its stage pin, and only that part", () => {
    expect(followedVersions([part("engine", [NEW], [OLD]), part("auth", [NEW], [NEW]), part("jobs", [NEW], [NEW, OLD])])).toEqual({ engine: NEW, jobs: NEW });
  });

  it("PLANTED DEFECT: leaves a part alone whose builds' pins disagree: its release is still being pinned", () => {
    expect(followedVersions([part("engine", [NEW, OLD], [OLD])])).toEqual({});
  });
});

describe("followTenant — one check of one tenant", () => {
  it("moves a following tenant that lags its stage pin through the Versions run, planned and approved", async () => {
    const executor = fakeExecutor();
    expect(await followTenant(deps(executor), "tnt_1")).toBe(`tenant acme at prod: the Versions run run_1 moved example-platform to ${NEW}`);
    expect(executor.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-platform": NEW } }]);
    expect(executor.asked).toEqual(["plan run_1", "settle run_1", "approve run_1", "settle run_1"]);
  });

  it("PLANTED DEFECT: plans the refresh once more when another run changed the members while it waited, and that one moves the stage", async () => {
    const executor = fakeExecutor({ endings: [{ status: "failed", error: `tenant ${GUID}'s ${MEMBERS_CHANGED} — plan it again` }] });
    expect(await followTenant(deps(executor), "tnt_1")).toBe(`tenant acme at prod: the Versions run run_2 moved example-platform to ${NEW}`);
    expect(executor.asked).toEqual(["plan run_1", "settle run_1", "approve run_1", "settle run_1", "plan run_2", "settle run_2", "approve run_2", "settle run_2"]);
  });

  it("PLANTED DEFECT: says a refresh that failed did not move the stage, with its run and its error, at warn", async () => {
    const executor = fakeExecutor({ endings: [{ status: "failed", error: "the push was refused" }] });
    const warn = vi.fn();
    const logger = { ...pino({ level: "silent" }), warn } as unknown as TenantFollowDeps["logger"];
    expect(await followTenant({ ...deps(executor), logger }, "tnt_1")).toBe(`tenant acme at prod: the Versions run run_1 did not move example-platform to ${NEW}: it ended failed — the push was refused`);
    expect(warn).toHaveBeenCalledWith({ tenantId: "tnt_1", runId: "run_1", status: "failed" }, expect.stringContaining("did not move"));
    expect(executor.planned).toHaveLength(1);
  });

  it("says a run whose record is gone left it unknown whether the stage moved, and claims no status", async () => {
    const executor = fakeExecutor();
    const said = await followTenant({ ...deps(executor), runEnding: () => undefined }, "tnt_1");
    expect(said).toBe(`tenant acme at prod: the Versions run run_1 has no record, so whether it moved example-platform to ${NEW} is unknown`);
  });

  it("plans once more only: a second stale plan is reported as not moved", async () => {
    const stale = { status: "failed" as const, error: `tenant ${GUID}'s ${MEMBERS_CHANGED} — plan it again` };
    const executor = fakeExecutor({ endings: [stale, stale] });
    expect(await followTenant(deps(executor), "tnt_1")).toContain("the Versions run run_2 did not move");
    expect(executor.planned).toHaveLength(2);
  });

  it("PLANTED DEFECT: plans nothing for a tenant whose switch is off, or one that runs every part at its stage pin", async () => {
    const executor = fakeExecutor();
    expect(await followTenant(deps(executor, NEW), "tnt_1")).toBe("tenant acme at prod runs every part at its stage pin");
    h.db.update(tenants).set({ followReleases: false }).where(eq(tenants.id, "tnt_1")).run();
    expect(await followTenant(deps(executor), "tnt_1")).toBe("tenant tnt_1 does not follow releases");
    expect(executor.planned).toEqual([]);
  });

  it("waits for the run that holds the books branch to end, then approves", async () => {
    const executor = fakeExecutor({ busyHolder: "run_9" });
    const said: string[] = [];
    const logger = { ...pino({ level: "silent" }), info: (_o: unknown, m: string) => { said.push(m); } } as unknown as TenantFollowDeps["logger"];
    await followTenant({ ...deps(executor), logger }, "tnt_1");
    expect(executor.asked).toEqual(["plan run_1", "settle run_1", "approve run_1", "settle run_9", "approve run_1", "settle run_1"]);
    expect(said).toContain("the Versions run run_1 waits for run run_9, which holds the tenant, before it is approved");
  });

  it("PLANTED DEFECT: discards a planned run it cannot approve for another reason, and reports that reason", async () => {
    const executor = fakeExecutor({ approveError: new Error("the run needs a secret the Manager cannot give") });
    await expect(followTenant(deps(executor), "tnt_1")).rejects.toThrow("the run needs a secret the Manager cannot give");
    expect(executor.asked).toEqual(["plan run_1", "settle run_1", "approve run_1", "discard run_1"]);
  });

  it("says in the log when a check has waited 30 minutes for a run, since every later check waits behind it", async () => {
    vi.useFakeTimers();
    try {
      const warned: string[] = [];
      const executor = { ...fakeExecutor(), settle: () => new Promise<void>(() => undefined) }; // a run that never settles
      const logger = { warn: (_o: unknown, m: string) => { warned.push(m); }, info: () => undefined, error: () => undefined };
      void followTenant({ ...deps(executor), logger } as unknown as TenantFollowDeps, "tnt_1");
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(warned).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(warned).toEqual(["a check of the tenants that follow releases has waited 30 minutes for run run_1, and every later check waits behind it"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("approves no Versions run whose plan was refused, and says where the reason stands", async () => {
    const executor = fakeExecutor({ planStatus: "failed" });
    expect(await followTenant(deps(executor), "tnt_1")).toBe(`tenant acme at prod: the Versions run run_1 moving example-platform to ${NEW} was not approved: its plan was refused or the run was cancelled, and its record says which`);
    expect(executor.asked).toEqual(["plan run_1", "settle run_1", "approve run_1"]);
  });
});

describe("the follower — which tenants an event checks", () => {
  it("checks the following tenants at the stage the release was pinned at, and none at another", async () => {
    const executor = fakeExecutor();
    const follower = makeTenantFollower(deps(executor));
    await follower.releaseSucceeded({ unit: "example-platform", stage: "test", runName: "r-1", releaseTag: "0.1.12-stable-20260925120000" });
    expect(executor.planned).toEqual([]);
    await follower.releaseSucceeded({ unit: "example-platform", stage: "prod", runName: "r-2", releaseTag: "0.1.12-stable-20260925120000" });
    expect(executor.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-platform": NEW } }]);
  });

  it("PLANTED DEFECT: keeps checking after a check that could not read the tenants", async () => {
    const executor = fakeExecutor();
    const follower = makeTenantFollower(deps(executor));
    h.sqlite.exec("ALTER TABLE tenants RENAME TO tenants_away");
    await follower.checkAll(); // the read throws; the link logs it
    h.sqlite.exec("ALTER TABLE tenants_away RENAME TO tenants");
    await follower.checkAll();
    expect(executor.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-platform": NEW } }]);
  });
});
