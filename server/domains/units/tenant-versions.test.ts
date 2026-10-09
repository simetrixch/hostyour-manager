import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, TEST_BUNDLE, TEST_CHANNEL_STAGES } from "./tenant-members.fixture.ts";
import { readTenantVersions, sameApprovals, stagePinsAndNamesOf, stagePinsOf, withChosenVersions, withMissingPins, type Approvals, type StagePins } from "./tenant-versions.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

// The versions a tenant runs: the stage pins it starts on, and the comparison that makes a current
// tenant a run with nothing to do.

const GUID = "zsjs023ctne0";
const NEW = "0.1.12-stable-20260925120000-abc1234";
const OLD = "0.1.11-stable-20260920120000-def5678";
const OLDEST = "0.1.10-stable-20260910120000-0a1b2c3";
/** Released after NEW; the stage was put back on NEW since. */
const NEWER = "0.1.13-stable-20260926120000-1234567";
const BETA = "0.1.12-beta-20260924120000-7654321";

const pinsFile = (builds: Record<string, string>): string =>
  `builds:\n${Object.entries(builds).map(([name, tag]) => `  - { name: ${name}, image: ${name}, tag: "${tag}" }`).join("\n")}\n`;

/** The stage pins of members whose pin files name `named`; a named build absent from `tags` stands at its placeholder. */
const stagePinsNaming = (tags: Approvals, named: Record<string, string[]>): StagePins => ({ tags, named: Object.fromEntries(Object.entries(named).map(([m, names]) => [m, new Set(names)])) });

/** One tenant at prod holding `approvedTags`, and the stage pins of two of its charts: by default the
 *  engine's second build still carries its placeholder, which names no released image. `enginePins` is
 *  the engine chart's pin file as releases wrote it, oldest first; the last one stands. */
function books(approvedTags: Approvals, enginePins: Record<string, string>[] = [{ "example-engine": NEW, "example-migrate": "" }]): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(["erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), approvedTags, ...TEST_BUNDLE,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  repo.seed(repo.booksBranch, "charts/example-auth/pins-prod.yaml", pinsFile({ "example-auth": NEW }));
  for (const pins of enginePins) repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile(pins));
  return new TenantRegistrations(repo);
}

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

describe("tenant versions", () => {
  it("takes the stage pin of every build a member's charts pin, and leaves a placeholder out", async () => {
    const registrations = books({});
    const pins = await stagePinsOf((chart) => registrations.listPinnedBuilds("prod", chart), testMembers(["erp"]));
    expect(pins).toEqual({ auth: { "example-auth": NEW }, erp: { "example-engine": NEW } });
  });

  it("adds only the builds a tenant does not hold yet, and compares approvals in any order", () => {
    const current = { erp: { "example-engine": OLD } };
    const next = withMissingPins(current, { auth: { "example-auth": NEW }, erp: { "example-engine": NEW } });
    expect(next).toEqual({ erp: { "example-engine": OLD }, auth: { "example-auth": NEW } });
    expect(current).toEqual({ erp: { "example-engine": OLD } });
    expect(sameApprovals(next, { auth: { "example-auth": NEW }, erp: { "example-engine": OLD } })).toBe(true);
    expect(sameApprovals(next, { auth: { "example-auth": NEW }, erp: { "example-engine": NEW } })).toBe(false);
  });

  it("a choice moves every build it names, a build the tenant lacks starts at its pin, and any other keeps what it holds", () => {
    const current = { erp: { "example-engine": NEW, "example-kept": OLD } };
    const pins = stagePinsNaming({ erp: { "example-engine": NEW }, auth: { "example-auth": NEW } }, { erp: ["example-engine", "example-kept"], auth: ["example-auth"] });
    expect(withChosenVersions(current, pins, { "example-engine": OLD }))
      .toEqual({ erp: { "example-engine": OLD, "example-kept": OLD }, auth: { "example-auth": NEW } });
    expect(current.erp["example-engine"]).toBe(NEW);
  });

  it("a build no choice names keeps what it holds when its stage pin moved on: a release makes a version available and moves no tenant", () => {
    expect(withChosenVersions({ erp: { "example-engine": OLD } }, stagePinsNaming({ erp: { "example-engine": NEW } }, { erp: ["example-engine"] }), {})).toEqual({ erp: { "example-engine": OLD } });
  });

  describe("a held build the pin files of its member stop naming", () => {
    const jobs = testMembers().filter((m) => m.name === "jobs");
    /** The pin files by chart, as listPinnedBuilds answers them; a chart without one answers []. */
    const filesOf = (files: Record<string, { name: string; tag: string }[]>) => async (chart: string) => files[chart] ?? [];
    const held = { jobs: { "example-jobs": OLD, "example-jobs-frontend": OLDEST } };

    it("leaves the versions with the next write, and the build still named stays where it is", async () => {
      const pins = await stagePinsAndNamesOf(filesOf({ "charts/example-jobs": [{ name: "example-jobs", tag: NEW }] }), jobs);
      expect(withChosenVersions(held, pins, {})).toEqual({ jobs: { "example-jobs": OLD } });
      expect(held.jobs["example-jobs-frontend"]).toBe(OLDEST);
    });

    it("stays when a pin file still names it at its placeholder, which stagePinsOf leaves out", async () => {
      const files = filesOf({ "charts/example-jobs": [{ name: "example-jobs", tag: NEW }, { name: "example-jobs-frontend", tag: "0.0.0-placeholder" }] });
      expect(await stagePinsOf(files, jobs)).toEqual({ jobs: { "example-jobs": NEW } });
      expect(withChosenVersions(held, await stagePinsAndNamesOf(files, jobs), {})).toEqual(held);
    });

    it("stays where the member's chart has no pin file, as listPinnedBuilds answers a missing file", async () => {
      const registrations = books({});
      expect(await registrations.listPinnedBuilds("prod", "charts/example-jobs")).toEqual([]);
      const pins = await stagePinsAndNamesOf((chart) => registrations.listPinnedBuilds("prod", chart), jobs);
      expect(withChosenVersions(held, pins, {})).toEqual(held);
    });

    it("stays where one of the member's charts has no pin file, since the build may belong to that chart", async () => {
      const web = testMembers(["web"]).filter((m) => m.name === "web");
      const heldWeb = { web: { "example-engine": OLD, "example-web": OLDEST } };
      const pins = await stagePinsAndNamesOf(filesOf({ "charts/example-engine": [{ name: "example-engine", tag: NEW }] }), web);
      expect(withChosenVersions(heldWeb, pins, {})).toEqual(heldWeb);
    });

    it("is judged against every chart of its member: one the other chart names stays, one no chart names goes", async () => {
      const web = testMembers(["web"]).filter((m) => m.name === "web");
      const heldWeb = { web: { "example-engine": OLD, "example-web": OLDEST, "example-gone": OLDEST } };
      const pins = await stagePinsAndNamesOf(filesOf({
        "charts/example-engine": [{ name: "example-engine", tag: NEW }],
        "charts/example-web": [{ name: "example-web", tag: NEW }],
      }), web);
      expect(withChosenVersions(heldWeb, pins, {})).toEqual({ web: { "example-engine": OLD, "example-web": OLDEST } });
    });

    it("stays where the pin file names no build, since an empty read never empties a tenant", async () => {
      const pins = await stagePinsAndNamesOf(filesOf({ "charts/example-jobs": [] }), jobs);
      expect(withChosenVersions(held, pins, {})).toEqual(held);
    });

    it("fails where a pin file cannot be read, as before", async () => {
      await expect(stagePinsAndNamesOf(async () => { throw new Error("books branch unreadable"); }, jobs)).rejects.toThrow("books branch unreadable");
    });
  });

  it("offers per part the versions a stage pin named that every image of it stands at in the registry, newest first, one put back on the stage included, and none on a channel the stage does not take", async () => {
    // The releases pinned OLD, then NEWER, and then put NEW back on the stage: NEWER stays available.
    const registrations = books(
      { erp: { "example-engine": NEW, "example-worker": NEW }, auth: { "example-auth": NEW } },
      [{ "example-engine": OLD, "example-worker": OLD }, { "example-engine": NEWER, "example-worker": NEWER }, { "example-engine": NEW, "example-worker": NEW }],
    );
    const ports = {
      registrations,
      attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: "example-platform", build: "example-worker" }],
      resolveClusterValueFiles: async () => [{ path: clusterMapPath("s1.example"), content: "global:\n  endpoints:\n    registry:\n      host: zot.s1.example\n" }],
      registryProbe: new FakeRegistryProbe({
        tags: {
          "example-engine": [OLDEST, OLD, NEW, NEWER, BETA, "latest"],
          "example-worker": [OLD, NEW, NEWER, BETA],
          "example-auth": [NEW],
        },
      }),
      channelStages: async () => TEST_CHANNEL_STAGES,
    } as unknown as TenantOnboardPorts;
    expect(await readTenantVersions(ports, db.db, "tnt_1")).toEqual({
      stage: "prod",
      parts: [
        { name: "example-auth", builds: ["example-auth"], running: [NEW], versions: [{ tag: NEW, older: false }] },
        { name: "example-platform", builds: ["example-engine", "example-worker"], running: [NEW], versions: [{ tag: NEWER, older: false }, { tag: NEW, older: false }, { tag: OLD, older: true }] },
      ],
    });
  });
});
