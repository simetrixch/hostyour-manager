import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import {
  clusterShortName, clusterMarkingPath, resolveClusterMarking, buildPlaneFqdnFromMarkings,
  projectClusterMarking, removeSlaveMarkingPart, setClusterRelease,
  readClusterReleases, clusterReleaseRead,
  CLUSTER_MARKING_FILE_KEYS,
} from "./cluster-marking.ts";

// cluster-marking: the one place a cluster's role, stage, short name and build plane come from.
// Its whole point is that the short name is DERIVED from the fqdn and stored nowhere, so the tests
// keep proving that a map without a name still resolves both ways.

const MASTER = "m1.example.com";
const SLAVE = "s1.example.com";

const masterMap = `stage: prod\nrole: master\n\nglobal:\n  domain: ${MASTER}\n  buildPlane: ${MASTER}\n`;
const slaveMap = `stage: prod\nrole: slave\n\nglobal:\n  domain: ${SLAVE}\n  buildPlane: ${MASTER}\n  master: ${MASTER}\n`;

function repoWith(maps: Record<string, string>): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  for (const [fqdn, text] of Object.entries(maps)) repo.seed(repo.booksBranch, clusterMarkingPath(fqdn), text);
  return repo;
}

describe("clusterShortName", () => {
  it("is the first label of the fqdn", () => {
    expect(clusterShortName(MASTER)).toBe("m1");
    expect(clusterShortName(SLAVE)).toBe("s1");
    expect(clusterShortName("s1")).toBe("s1"); // already a bare label
  });
});

describe("resolveClusterMarking", () => {
  it("resolves a cluster from its fqdn AND from its short name alone — the map stores no name", async () => {
    const repo = repoWith({ [MASTER]: masterMap, [SLAVE]: slaveMap });
    expect(repo.read(repo.booksBranch, clusterMarkingPath(SLAVE))).not.toContain("name:");

    const byName = await resolveClusterMarking(repo, "s1");
    expect(byName).toEqual({
      fqdn: SLAVE, name: "s1", role: "slave", stage: "prod",
      buildPlane: false, buildPlaneFqdn: MASTER, master: MASTER,
    });
    expect(await resolveClusterMarking(repo, SLAVE)).toEqual(byName);
  });

  it("reads buildPlane as the predicate `build-plane == own fqdn`, never as a stored boolean", async () => {
    const repo = repoWith({ [MASTER]: masterMap, [SLAVE]: slaveMap });
    expect((await resolveClusterMarking(repo, "m1")).buildPlane).toBe(true);
    expect((await resolveClusterMarking(repo, "s1")).buildPlane).toBe(false);
    // ...and a master that builds ELSEWHERE names that cluster in the same one field.
    const consumer = repoWith({ [MASTER]: `stage: prod\nrole: master\n\nglobal:\n  domain: ${MASTER}\n  buildPlane: build1.example.com\n` });
    const m = await resolveClusterMarking(consumer, "m1");
    expect([m.buildPlane, m.buildPlaneFqdn]).toEqual([false, "build1.example.com"]);
  });

  it("buildPlaneFqdnFromMarkings answers a cluster with the FQDN in its own build-plane field", async () => {
    const resolve = buildPlaneFqdnFromMarkings(repoWith({ [MASTER]: masterMap, [SLAVE]: slaveMap }));
    // A slave names the cluster that builds for it; the build plane names itself. Either spelling of the
    // cluster works, because the resolver goes through resolveClusterMarking.
    expect(await resolve(SLAVE)).toBe(MASTER);
    expect(await resolve("s1")).toBe(MASTER);
    expect(await resolve(MASTER)).toBe(MASTER);
  });

  it("buildPlaneFqdnFromMarkings throws on a cluster with no map — a caller must not guess a host", async () => {
    await expect(buildPlaneFqdnFromMarkings(repoWith({ [MASTER]: masterMap }))(SLAVE)).rejects.toThrow(/no cluster map for/);
  });

  it("carries the union role master+slave", async () => {
    const repo = repoWith({ [MASTER]: `stage: prod\nrole: master+slave\n\nglobal:\n  domain: ${MASTER}\n  buildPlane: ${MASTER}\n` });
    expect((await resolveClusterMarking(repo, "m1")).role).toBe("master+slave");
  });

  it("a missing map is a typed error naming the path — never a default role or stage", async () => {
    await expect(resolveClusterMarking(repoWith({ [MASTER]: masterMap }), "s1")).rejects.toThrow(
      /no cluster map for "s1".*clusters\/active\/s1\.yaml/s,
    );
  });

  it("a map missing build-plane is a typed error naming the file and the field", async () => {
    const repo = repoWith({ [SLAVE]: `stage: prod\nrole: slave\n\nglobal:\n  domain: ${SLAVE}\n` });
    await expect(resolveClusterMarking(repo, "s1")).rejects.toThrow(/clusters\/active\/s1\.example\.com\.yaml.*buildPlane/s);
  });

  it("refuses a map carrying a key it does not know, naming the file and the key", async () => {
    // The retired spelling of the apiserver address is the case that matters: zod's default would
    // STRIP it, and the next write would regenerate the file without any address at all. Refusing
    // out loud IS the migration instruction — rename the key in the map on master.
    const repo = repoWith({ [SLAVE]: `${slaveMap}lanHost: 10.1.1.11\napiPort: 16443\n` });
    await expect(resolveClusterMarking(repo, "s1")).rejects.toThrow(
      /clusters\/active\/s1\.example\.com\.yaml.*lanHost/s,
    );
  });

  // The key set today's map template writes unconditionally into every map, on top of the role
  // fields. The strict schema refuses any key it does not declare, and indexMarkings folds every
  // map on every read — so ONE map in the current format failing to parse kills resolution for
  // every cluster on a fresh installation, which is exactly what these two tests pin down.
  const installerTail = `  unitApex: example.com\n  platformDomain: example.com\n`;

  it("resolves a map exactly as today's writers leave it, carrying platform-domain", async () => {
    const installerSlave = `${slaveMap}${installerTail}  endpoints:\n    mail:\n      url: https://post.example.com\n  apiHost: 100.64.0.11\n  apiPort: 16443\n`;
    const repo = repoWith({ [MASTER]: `${masterMap}${installerTail}`, [SLAVE]: installerSlave });
    expect(await resolveClusterMarking(repo, "m1")).toMatchObject({ fqdn: MASTER, platformDomain: "example.com" });
    expect(await resolveClusterMarking(repo, "s1")).toMatchObject({
      fqdn: SLAVE, unitApex: "example.com", platformDomain: "example.com",
      postUrl: "https://post.example.com", apiHost: "100.64.0.11", apiPort: 16443,
    });
  });

  it("one map in the current format does not poison the read of a well-formed neighbour", async () => {
    const repo = repoWith({ [SLAVE]: slaveMap, [MASTER]: `${masterMap}${installerTail}` });
    expect((await resolveClusterMarking(repo, "s1")).fqdn).toBe(SLAVE);
  });

  it("two clusters sharing a first fqdn label are a typed error, not a last-one-wins silent pick", async () => {
    const other = "s1.example";
    const repo = repoWith({ [SLAVE]: slaveMap, [other]: `stage: dev\nrole: slave\n\nglobal:\n  domain: ${other}\n  buildPlane: ${MASTER}\n` });
    await expect(resolveClusterMarking(repo, "s1")).rejects.toThrow(/both derive the short name "s1"/);
  });
});

describe("projectClusterMarking", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "box-a", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "dev", domain: SLAVE, status: "active" }).run();
  });
  afterEach(() => { db.sqlite.close(); });

  it("moves servers.role + clusters.stage onto what the map says, and audits the move", async () => {
    const marking = await resolveClusterMarking(repoWith({ [SLAVE]: `stage: prod\nrole: master+slave\n\nglobal:\n  domain: ${SLAVE}\n  buildPlane: ${MASTER}\n` }), SLAVE);
    expect(projectClusterMarking(db.db, marking, { actor: "op_test", runId: "run_1" })).toEqual({
      stage: { from: "dev", to: "prod" },
      role: { from: "slave", to: "master+slave" },
    });
    expect(db.db.select().from(clusters).where(eq(clusters.id, "cls_1")).get()?.stage).toBe("prod");
    expect(db.db.select().from(servers).where(eq(servers.id, "srv_1")).get()?.role).toBe("master+slave");
    // The audit table has ONE writer (db/audit-writer.ts), so a test reads it as raw SQL.
    const entry = db.sqlite.prepare("SELECT action, target_id FROM audit ORDER BY ts DESC LIMIT 1").get() as { action: string; target_id: string } | undefined;
    expect(entry).toEqual({ action: "cluster.marking_projected", target_id: "cls_1" });
  });

  it("is a silent no-op — and writes NO audit row — when the two already agree", async () => {
    const marking = await resolveClusterMarking(repoWith({ [SLAVE]: `stage: dev\nrole: slave\n\nglobal:\n  domain: ${SLAVE}\n  buildPlane: ${MASTER}\n` }), SLAVE);
    expect(projectClusterMarking(db.db, marking, { actor: "op_test" })).toEqual({});
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM audit").get()).toEqual({ n: 0 });
  });

  it("refuses a cluster inventory does not know — reading a file never registers one", async () => {
    const marking = await resolveClusterMarking(repoWith({ [MASTER]: masterMap }), MASTER);
    expect(() => projectClusterMarking(db.db, marking, { actor: "op_test" })).toThrow(/no cluster registered for m1/);
  });
});

describe("removeSlaveMarkingPart", () => {
  const reachable = `${slaveMap}  apiHost: 100.64.0.11\n  apiPort: 16443\n`;

  it("drops ONLY the slave part — the cluster stays marked with its role, stage and build plane", async () => {
    const repo = repoWith({ [SLAVE]: reachable });
    expect((await resolveClusterMarking(repo, "s1")).apiHost).toBe("100.64.0.11");

    expect((await removeSlaveMarkingPart(repo, SLAVE, "run_1")).changed).toBe(true);
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]?.message).toContain("[run_1]");

    const left = await resolveClusterMarking(repo, "s1");
    expect(left).toMatchObject({ role: "slave", stage: "prod", buildPlaneFqdn: MASTER });
    expect(left.master).toBeUndefined();
    expect(left.apiHost).toBeUndefined();
    expect(left.apiPort).toBeUndefined();
  });

  it("is a no-op on an already-stripped map and on a cluster with no map at all", async () => {
    const repo = repoWith({ [SLAVE]: reachable });
    await removeSlaveMarkingPart(repo, SLAVE, "run_1");
    expect((await removeSlaveMarkingPart(repo, SLAVE, "run_2")).changed).toBe(false);
    expect((await removeSlaveMarkingPart(repo, "ghost.example.com", "run_2")).changed).toBe(false);
    expect(repo.commits).toHaveLength(1);
  });
});

describe("setClusterRelease", () => {
  const TAG = "1.2.0-stable-20260728120000";

  it("states the pin without disturbing anything else the map says", async () => {
    const repo = repoWith({ [SLAVE]: `${slaveMap}  apiHost: 100.64.0.11\n  apiPort: 16443\n` });
    expect((await resolveClusterMarking(repo, "s1")).release).toBeUndefined();

    const { marking, changed } = await setClusterRelease(repo, SLAVE, TAG, "run_1");
    expect(changed).toBe(true);
    expect(marking.release).toBe(TAG);
    expect(repo.commits[0]?.message).toContain(`pin s1 to ${TAG} [run_1]`);

    // Read back off the committed bytes: the pin stands, and role/stage/build plane/slave part all do.
    const after = await resolveClusterMarking(repo, "s1");
    expect(after).toMatchObject({ release: TAG, role: "slave", stage: "prod", buildPlaneFqdn: MASTER, apiHost: "100.64.0.11", apiPort: 16443 });
  });

  it("keeps the fields this module decides nothing with — a pin write must not delete them", async () => {
    // A pin regenerates the WHOLE file, so anything the schema does not carry is gone from git.
    // set-role.sh refuses to stamp a cluster whose map has no unit-apex, so losing it here would
    // break the very branch regeneration the pin exists to drive.
    const repo = repoWith({ [SLAVE]: `${slaveMap}  unitApex: example.com\n  platformDomain: example.com\n  endpoints:\n    mail:\n      url: https://post.example.com\n` });
    await setClusterRelease(repo, SLAVE, TAG, "run_1");

    const after = await resolveClusterMarking(repo, "s1");
    expect(after).toMatchObject({ release: TAG, unitApex: "example.com", platformDomain: "example.com", postUrl: "https://post.example.com" });
    const bytes = repo.read(repo.booksBranch, clusterMarkingPath(SLAVE));
    expect(bytes).toContain('unitApex: example.com');
    expect(bytes).toContain('platformDomain: example.com');
    expect(bytes).toContain('url: https://post.example.com');
  });

  it("re-pinning the SAME tag commits nothing — a resumed run reads its own pin back", async () => {
    const repo = repoWith({ [SLAVE]: slaveMap });
    await setClusterRelease(repo, SLAVE, TAG, "run_1");
    const second = await setClusterRelease(repo, SLAVE, TAG, "run_1");
    expect(second.changed).toBe(false);
    expect(second.marking.release).toBe(TAG);
    expect(repo.commits).toHaveLength(1);
  });

  it("refuses to read a map whose pin is not a release tag — the field IS the pin, so free text names nothing", async () => {
    const repo = repoWith({ [SLAVE]: `${slaveMap}release: latest\n` });
    await expect(resolveClusterMarking(repo, "s1")).rejects.toThrow(/must be a release tag/);
  });
});

describe("readClusterReleases + clusterReleaseRead — a version is reported ONLY where a map states one", () => {
  const TAG = "1.2.0-stable-20260728120000";

  it("reports the pinned tag for a cluster whose map carries one", async () => {
    const releases = await readClusterReleases(repoWith({ [MASTER]: `${masterMap}release: ${TAG}\n` }));
    expect(releases.ok).toBe(true);
    expect(clusterReleaseRead(MASTER, releases)).toEqual({ kind: "pinned", tag: TAG });
  });

  it("a map that carries NO release key reads unknown, and says that no release run has pinned it", async () => {
    // The counter-probe of this whole surface: `masterMap` has no release key, which is every
    // cluster between its install and its first release. Nothing here may substitute a version —
    // there is no second statement of a cluster's release to substitute FROM.
    const releases = await readClusterReleases(repoWith({ [MASTER]: masterMap }));
    const read = clusterReleaseRead(MASTER, releases);
    expect(read.kind).toBe("unknown");
    expect(read).not.toHaveProperty("tag");
    expect(JSON.stringify(read)).not.toContain(TAG);
    if (read.kind === "unknown") expect(read.reason).toMatch(/carries no release key.*no release run has pinned/);
  });

  it("does not lend one cluster's pin to another — two maps, one pinned, and the other stays unknown", async () => {
    const releases = await readClusterReleases(
      repoWith({ [MASTER]: `${masterMap}release: ${TAG}\n`, [SLAVE]: slaveMap }),
    );
    expect(clusterReleaseRead(MASTER, releases)).toEqual({ kind: "pinned", tag: TAG });
    expect(clusterReleaseRead(SLAVE, releases).kind).toBe("unknown");
    expect(JSON.stringify(clusterReleaseRead(SLAVE, releases))).not.toContain(TAG);
  });

  it("a cluster with no map at all reads unknown and names the file that would state it", () => {
    const read = clusterReleaseRead(SLAVE, { ok: true, byFqdn: new Map() });
    expect(read).toEqual({ kind: "unknown", reason: expect.stringContaining(clusterMarkingPath(SLAVE)) });
  });

  it("RETURNS the failure instead of throwing — one unreadable map must not blank a whole page", async () => {
    // resolveClusterMarking throws here (right for a run, wrong for a list). A map whose release is
    // free text is the case that reaches it, since the strict schema refuses the whole read.
    const releases = await readClusterReleases(repoWith({ [MASTER]: `${masterMap}release: latest\n` }));
    expect(releases.ok).toBe(false);
    const read = clusterReleaseRead(MASTER, releases);
    expect(read.kind).toBe("unknown");
    if (read.kind === "unknown") expect(read.reason).toMatch(/must be a release tag/);
  });

  it("names the missing configuration when there is no platform repo to read maps from", async () => {
    const releases = await readClusterReleases(undefined);
    expect(releases).toEqual({ ok: false, reason: expect.stringContaining("wire-onboarding.ts:204") });
  });
});

describe("map-writer contract", () => {
  // The deployment programs write a master's map from ONE template — digita-deploy
  // ansiwise/templates/cluster-map.tpl — and this module reads every map with a STRICT schema.
  // The two repos ship separately, so nothing forces them to agree — this test does. It parses
  // the actual template out of the sibling checkout (ci.sh runs the repos mounted side by side,
  // the same layout as a dev machine) and asserts every key the template emits is a key the
  // schema declares. Without it, a field the template gains is invisible here until a fresh
  // installation's map fails every read.
  const mapTpl = fileURLToPath(new URL("../../../../../digitaplatform/digita-deploy/ansiwise/templates/cluster-map.tpl", import.meta.url));

  it.skipIf(!existsSync(mapTpl))("every key the map template writes is declared in the schema", () => {
    const text = readFileSync(mapTpl, "utf8");

    // A template line is `key: <slot>` at column 0; comment lines start with '#' and never match.
    const keys = new Set<string>();
    for (const m of text.matchAll(/^([A-Za-z][A-Za-z0-9-]*):/gm)) keys.add(m[1] ?? "");
    keys.delete("");
    // `stage` and not `fqdn`: the template writes two blocks, and what this guard covers is the TOP
    // one — the surface the schema is strict about, because it is what the reconciler's generators
    // select on and a selector matching nothing produces no Applications and no error. Everything a
    // chart reads stands under `global`, which the schema lets through on purpose: refusing a key a
    // chart added would fail every map read on the release that adds one.
    expect([...keys], "the extraction found no map keys — the template moved or changed shape").toContain("stage");

    const undeclared = [...keys].filter((k) => !CLUSTER_MARKING_FILE_KEYS.includes(k));
    expect(
      undeclared,
      "the map template writes keys the strict ClusterMarkingFileSchema refuses — declare them, or every map a fresh install writes fails every read",
    ).toEqual([]);

    // COUNTER-PROBE: the extraction is coupled to the template's SHAPE — top-level `key:` lines. A
    // template rewritten in another style would yield an EMPTY key set, and an empty set trivially
    // satisfies the assertion above: the comparison would pass while checking nothing. So the same
    // extraction runs over a body that emits a key in a shape it does not know, and must not see it.
    const foreign = ["# a comment: not a key", "  indented-key: value", "{{ printf \"computed-key: value\" }}"].join("\n");
    const fKeys = new Set<string>();
    for (const m of foreign.matchAll(/^([A-Za-z][A-Za-z0-9-]*):/gm)) fKeys.add(m[1] ?? "");
    fKeys.delete("");
    expect(
      [...fKeys],
      "the extraction found a key in a shape it was never taught — this counter-probe exists to prove it CANNOT, so that the toContain(\"fqdn\") guard above is the only thing standing between a rewritten template and a silently empty comparison",
    ).toEqual([]);
  });
});
