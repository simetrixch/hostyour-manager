import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { errIllegalTransition } from "../../kernel/errors.ts";
import pino from "pino";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { APPS_MANIFEST_PATH } from "../../../shared/apps-manifest.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { followedVersions, followTenant, makeTenantFollower, movesInsideLine, type TenantFollowDeps } from "./tenant-follow.ts";
import { MEMBERS_CHANGED } from "./tenant-refresh-members.run.ts";
import type { RunStatus } from "../../../shared/enums.ts";
import type { QueuedRunView } from "../../../shared/api-types.ts";
import type { TenantVersionPart } from "./tenant-versions.ts";

// A tenant that follows releases is moved by the Manager when a release run of a part it renders
// succeeds at its stage: through the Versions run, to the version the stage pins.

const GUID = "zsjs023ctne0";
const GUID2 = "q7mx4ke9ta21";
const NEW = "0.1.12-stable-20260925120000-abc1234";
const OLD = "0.1.11-stable-20260920120000-def5678";
/** A release of the next engine line: the bundle the tenants run is written for line 0.1. */
const NEXT_LINE = "0.2.0-stable-20261010120000-0a1b2c3";

const pinsFile = (builds: Record<string, string>): string =>
  `builds:\n${Object.entries(builds).map(([name, tag]) => `  - { name: ${name}, image: ${name}, tag: "${tag}" }`).join("\n")}\n`;

/** The books: two tenants at prod whose erp member holds `engine` and whose auth member holds `auth`
 *  where one is given, the engine pinned at `enginePin` and auth at NEW. */
function books(engine: string, enginePin = NEW, auth?: string): TenantRegistrations {
  const repo = new FakePlatformRepo();
  for (const [guid, subdomain] of [[GUID, "acme"], [GUID2, "beta"]] as const) {
    const registration = TenantRegistrationSchema.parse({
      cluster: "s1", subdomain, members: testMembers(["erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"),
      approvedTags: { erp: { "example-engine": engine }, ...(auth ? { auth: { "example-auth": auth } } : {}) }, ...TEST_BUNDLE,
    });
    const w = tenantRegistrationWrite("prod", guid, registration);
    repo.seed(repo.booksBranch, w.path, w.content);
  }
  repo.seed(repo.booksBranch, "charts/example-auth/pins-prod.yaml", pinsFile({ "example-auth": NEW }));
  repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile({ "example-engine": enginePin }));
  return new TenantRegistrations(repo);
}

/** An executor that records what the follower asks of it. A plan it settles as failed refuses the
 *  approve, as the executor refuses a failed run; the approve of a run of a tenant in `queuedFor`
 *  answers as a run that waits in the queue, and settling it waits until `endQueued` ends it. */
function fakeExecutor(opts: { planStatus?: "planned" | "failed"; queuedFor?: string[]; approveError?: Error; endings?: Array<{ status: RunStatus; error: string | null }> } = {}) {
  const asked: string[] = [];
  const planned: Array<{ tenantId: string }> = [];
  const queue: QueuedRunView[] = [];
  const ends = new Map<string, () => void>();
  return {
    asked,
    planned,
    endQueued: (runId: string): void => {
      queue.splice(queue.findIndex((q) => q.runId === runId), 1);
      ends.get(runId)?.();
    },
    listQueue: (): QueuedRunView[] => queue.map((q, i) => ({ ...q, place: i + 1 })),
    planStreamed: async (_kind: string, params: unknown): Promise<{ runId: string }> => {
      planned.push(params as { tenantId: string });
      const runId = `run_${planned.length}`;
      asked.push(`plan ${runId}`);
      return { runId };
    },
    settle: async (runId: string): Promise<void> => {
      asked.push(`settle ${runId}`);
      if (queue.some((q) => q.runId === runId)) await new Promise<void>((resolve) => ends.set(runId, resolve));
    },
    /** How each planned run ended, in planning order; a run with none given succeeded. */
    runEnding: (runId: string) => opts.endings?.[Number(runId.slice(4)) - 1] ?? { status: "succeeded" as const, error: null },
    discard: async (runId: string): Promise<void> => { asked.push(`discard ${runId}`); },
    approve: async (runId: string): Promise<{ status: "approved" | "queued" }> => {
      asked.push(`approve ${runId}`);
      if (opts.planStatus === "failed") throw errIllegalTransition("run status failed → approved");
      if (opts.approveError) throw opts.approveError;
      const { tenantId } = planned[Number(runId.slice(4)) - 1]!;
      if (!opts.queuedFor?.includes(tenantId)) return { status: "approved" };
      queue.push({ runId, kind: "tenant-refresh-members", targetKind: "tenant", targetId: tenantId, place: 0, approvedAt: 0, needsSecrets: false, waitsFor: [] });
      return { status: "queued" };
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

/** The tenants' own repository: the bundle they run is written for example-engine on line 0.1. */
function bundleRepository(): FakeRepoReader {
  const repo = new FakeRepoReader();
  repo.scriptFor(TEST_BUNDLE.appsRepo, { files: { [APPS_MANIFEST_PATH]: 'apps: []\nengine:\n  build: example-engine\n  line: "0.1"\n' } });
  return repo;
}

function deps(executor: ReturnType<typeof fakeExecutor>, engine = OLD, enginePin = NEW, auth?: string, repo = bundleRepository()): TenantFollowDeps {
  return {
    db: h.db,
    executor,
    runEnding: executor.runEnding,
    ports: { registrations: books(engine, enginePin, auth), attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: "example-auth", build: "example-auth" }], repo },
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

describe("movesInsideLine — a following tenant stays on its engine line", () => {
  const engineOf = (lines: Record<string, string>) => vi.fn(async (tag: string) => (lines[tag] ? { build: "engine-0", line: lines[tag] } : undefined));
  const BUNDLE_NOW = "0.1.0-stable-20260101000000-abc1234";
  const BUNDLE_NEXT = "0.1.1-stable-20261010000000-abc5678";

  it("PLANTED DEFECT: leaves out a bundle pin whose release declares another line, and keeps the engine move inside the line", async () => {
    const parts = [part("engine", [NEW], [OLD]), part("bundle", [BUNDLE_NEXT], [BUNDLE_NOW])];
    const read = engineOf({ [BUNDLE_NOW]: "0.1", [BUNDLE_NEXT]: "0.2" });
    expect(await movesInsideLine({ engine: NEW, bundle: BUNDLE_NEXT }, parts, { part: "bundle", tag: BUNDLE_NOW }, read))
      .toEqual({ versions: { engine: NEW }, leftOut: [`bundle pin ${BUNDLE_NEXT} is on line 0.2 and the bundle runs line 0.1, so Move to line moves it`] });
  });

  it("PLANTED INNOCENT: keeps a bundle pin on the line, and reads no bundle where no move can leave the line", async () => {
    const parts = [part("engine", [NEW], [OLD]), part("bundle", [BUNDLE_NEXT], [BUNDLE_NOW])];
    expect((await movesInsideLine({ engine: NEW, bundle: BUNDLE_NEXT }, parts, { part: "bundle", tag: BUNDLE_NOW }, engineOf({ [BUNDLE_NOW]: "0.1", [BUNDLE_NEXT]: "0.1" }))).versions).toEqual({ engine: NEW, bundle: BUNDLE_NEXT });
    const unread = engineOf({});
    expect(await movesInsideLine({ engine: NEW }, parts, { part: "bundle", tag: BUNDLE_NOW }, unread)).toEqual({ versions: { engine: NEW }, leftOut: [] });
    expect(unread).not.toHaveBeenCalled();
  });

  it("keeps every move where the tenant runs no bundle, or its bundle declares no engine", async () => {
    const parts = [part("engine", [NEXT_LINE], [OLD])];
    expect((await movesInsideLine({ engine: NEXT_LINE }, parts, undefined, engineOf({}))).versions).toEqual({ engine: NEXT_LINE });
    expect((await movesInsideLine({ engine: NEXT_LINE }, parts, { part: "bundle", tag: "0.1.0-stable-20260101000000-abc1234" }, engineOf({}))).versions).toEqual({ engine: NEXT_LINE });
  });
});

describe("followTenant — one check of one tenant", () => {
  it("PLANTED DEFECT: moves auth and leaves out the engine pin on the next line, which the bundle's line refuses", async () => {
    const executor = fakeExecutor();
    const info = vi.fn();
    const logger = { ...pino({ level: "silent" }), info } as unknown as TenantFollowDeps["logger"];
    expect(await followTenant({ ...deps(executor, OLD, NEXT_LINE, OLD), logger }, "tnt_1")).toBe(`tenant acme at prod: the Versions run run_1 moved example-auth to ${NEW}`);
    expect(executor.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-auth": NEW } }]);
    expect(info).toHaveBeenCalledWith({ tenantId: "tnt_1" }, `tenant acme at prod follows inside its engine line only: example-platform pin ${NEXT_LINE} is on line 0.2 and the bundle runs line 0.1, so Move to line moves it`);
  });

  it("PLANTED DEFECT: plans no run where the only move leaves the engine line, and says why", async () => {
    const executor = fakeExecutor();
    expect(await followTenant(deps(executor, OLD, NEXT_LINE), "tnt_1")).toBe(`tenant acme at prod moves no part inside its engine line: example-platform pin ${NEXT_LINE} is on line 0.2 and the bundle runs line 0.1, so Move to line moves it`);
    expect(executor.planned).toEqual([]);
  });

  it("PLANTED INNOCENT: moves the engine and auth inside the line together, without reading the tenant's repository", async () => {
    const executor = fakeExecutor();
    const repo = bundleRepository();
    expect(await followTenant(deps(executor, OLD, NEW, OLD, repo), "tnt_1")).toBe(`tenant acme at prod: the Versions run run_1 moved example-auth to ${NEW}, example-platform to ${NEW}`);
    expect(executor.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-auth": NEW, "example-platform": NEW } }]);
    expect(repo.clones).toEqual([]);
  });


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

  it("PLANTED DEFECT: does not wait for a Versions run that waits in the queue, and says the tenant is checked again", async () => {
    const executor = fakeExecutor({ queuedFor: ["tnt_1"] });
    expect(await followTenant(deps(executor), "tnt_1")).toBe(`tenant acme at prod: the Versions run run_1 moving example-platform to ${NEW} waits in the queue for the run that holds the tenant, and the tenant is checked again once it ends`);
    expect(executor.asked).toEqual(["plan run_1", "settle run_1", "approve run_1"]);
  });

  it("PLANTED DEFECT: plans no second Versions run while one of the tenant waits in the queue", async () => {
    const executor = fakeExecutor({ queuedFor: ["tnt_1"] });
    await followTenant(deps(executor), "tnt_1");
    expect(await followTenant(deps(executor), "tnt_1")).toBe("tenant acme: the Versions run run_1 waits in the queue at place 1, and the tenant is checked again once it ends");
    expect(executor.planned).toHaveLength(1);
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

  it("PLANTED DEFECT: a tenant whose lock is held waits in the queue, the other tenant still follows, and the first is checked again once its run ends", async () => {
    h.db.insert(tenants).values({ id: "tnt_2", clusterId: "cls_1", guid: GUID2, subdomain: "beta", stage: "prod", members: ["auth", "jobs", "report", "erp"], identityProvider: "auth", status: "active", followReleases: true }).run();
    const executor = fakeExecutor({ queuedFor: ["tnt_1"] });
    const follower = makeTenantFollower(deps(executor));
    await follower.releaseSucceeded({ unit: "example-platform", stage: "prod", runName: "r-1", releaseTag: "0.1.12-stable-20260925120000" });
    expect(executor.planned.map((p) => p.tenantId)).toEqual(["tnt_1", "tnt_2"]);
    executor.endQueued("run_1");
    await vi.waitFor(() => { expect(executor.planned.map((p) => p.tenantId)).toEqual(["tnt_1", "tnt_2", "tnt_1"]); });
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
