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
  CLUSTER_MARKING_FILE_KEYS,
} from "./cluster-marking.ts";

// cluster-marking: the one place a cluster's role, stage, short name and build plane come from.
// Its whole point is that the short name is DERIVED from the fqdn and stored nowhere, so the tests
// keep proving that a map without a name still resolves both ways.

const MASTER = "m1.example.com";
const SLAVE = "s1.example.com";

const masterMap = `fqdn: ${MASTER}\nstage: prod\nrole: master\nbuild-plane: ${MASTER}\n`;
const slaveMap = `fqdn: ${SLAVE}\nstage: prod\nrole: slave\nbuild-plane: ${MASTER}\nmaster: ${MASTER}\n`;

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
    const consumer = repoWith({ [MASTER]: `fqdn: ${MASTER}\nstage: prod\nrole: master\nbuild-plane: build1.example.com\n` });
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
    const repo = repoWith({ [MASTER]: `fqdn: ${MASTER}\nstage: prod\nrole: master+slave\nbuild-plane: ${MASTER}\n` });
    expect((await resolveClusterMarking(repo, "m1")).role).toBe("master+slave");
  });

  it("a missing map is a typed error naming the path — never a default role or stage", async () => {
    await expect(resolveClusterMarking(repoWith({ [MASTER]: masterMap }), "s1")).rejects.toThrow(
      /no cluster map for "s1".*clusters\/active\/s1\.yaml/s,
    );
  });

  it("a map missing build-plane is a typed error naming the file and the field", async () => {
    const repo = repoWith({ [SLAVE]: `fqdn: ${SLAVE}\nstage: prod\nrole: slave\n` });
    await expect(resolveClusterMarking(repo, "s1")).rejects.toThrow(/clusters\/active\/s1\.example\.com\.yaml.*build-plane/s);
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
  const installerTail = `unit-apex: example.com\nplatform-domain: example.com\n`;

  it("resolves a map exactly as today's writers leave it, carrying platform-domain", async () => {
    const installerSlave = `${slaveMap}${installerTail}post-url: https://post.example.com\napiHost: 100.64.0.11\napiPort: 16443\n`;
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
    const repo = repoWith({ [SLAVE]: slaveMap, [other]: `fqdn: ${other}\nstage: dev\nrole: slave\nbuild-plane: ${MASTER}\n` });
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
    const marking = await resolveClusterMarking(repoWith({ [SLAVE]: `fqdn: ${SLAVE}\nstage: prod\nrole: master+slave\nbuild-plane: ${MASTER}\n` }), SLAVE);
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
    const marking = await resolveClusterMarking(repoWith({ [SLAVE]: `fqdn: ${SLAVE}\nstage: dev\nrole: slave\nbuild-plane: ${MASTER}\n` }), SLAVE);
    expect(projectClusterMarking(db.db, marking, { actor: "op_test" })).toEqual({});
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM audit").get()).toEqual({ n: 0 });
  });

  it("refuses a cluster inventory does not know — reading a file never registers one", async () => {
    const marking = await resolveClusterMarking(repoWith({ [MASTER]: masterMap }), MASTER);
    expect(() => projectClusterMarking(db.db, marking, { actor: "op_test" })).toThrow(/no cluster registered for m1/);
  });
});

describe("removeSlaveMarkingPart", () => {
  const reachable = `${slaveMap}apiHost: 100.64.0.11\napiPort: 16443\n`;

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
    const repo = repoWith({ [SLAVE]: `${slaveMap}apiHost: 100.64.0.11\napiPort: 16443\n` });
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
    const repo = repoWith({ [SLAVE]: `${slaveMap}unit-apex: example.com\nplatform-domain: example.com\npost-url: https://post.example.com\n` });
    await setClusterRelease(repo, SLAVE, TAG, "run_1");

    const after = await resolveClusterMarking(repo, "s1");
    expect(after).toMatchObject({ release: TAG, unitApex: "example.com", platformDomain: "example.com", postUrl: "https://post.example.com" });
    const bytes = repo.read(repo.booksBranch, clusterMarkingPath(SLAVE));
    expect(bytes).toContain('unit-apex: example.com');
    expect(bytes).toContain('platform-domain: example.com');
    expect(bytes).toContain('post-url: https://post.example.com');
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
    expect([...keys], "the extraction found no map keys — the template moved or changed shape").toContain("fqdn");

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
