import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import {
  clusterShortName,
  resolveClusterMarking,
  buildPlaneFqdnFromMarkings,
  projectClusterMarking,
  removeSlaveMarkingPart,
  writeClusterMarkingOnBranch,
  CLUSTER_MARKING_FILE_KEYS,
} from "./cluster-marking.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

// cluster-marking: the one place a cluster's role, stage, short name and build plane come from.
// Its whole point is that the short name is DERIVED from the fqdn and stored nowhere, so the tests
// keep proving that a map without a name still resolves both ways.

const MASTER = "m1.example.com";
const SLAVE = "s1.example.com";

const masterMap = `stage: prod\nrole: master\n\nglobal:\n  domain: ${MASTER}\n  buildPlane: ${MASTER}\n`;
const slaveMap = `stage: prod\nrole: slave\n\nglobal:\n  domain: ${SLAVE}\n  buildPlane: ${MASTER}\n  master: ${MASTER}\n`;

function repoWith(maps: Record<string, string>): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  for (const [fqdn, text] of Object.entries(maps)) repo.seed(repo.booksBranch, clusterMapPath(fqdn), text);
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
    expect(repo.read(repo.booksBranch, clusterMapPath(SLAVE))).not.toContain("name:");

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
    const installerSlave = `${slaveMap}${installerTail}  endpoints:\n    mail:\n      url: https://mail.example.com\n  apiHost: 100.64.0.11\n  apiPort: 16443\n`;
    const repo = repoWith({ [MASTER]: `${masterMap}${installerTail}`, [SLAVE]: installerSlave });
    expect(await resolveClusterMarking(repo, "m1")).toMatchObject({ fqdn: MASTER, platformDomain: "example.com" });
    expect(await resolveClusterMarking(repo, "s1")).toMatchObject({
      fqdn: SLAVE, unitApex: "example.com", platformDomain: "example.com",
      mailUrl: "https://mail.example.com", apiHost: "100.64.0.11", apiPort: 16443,
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

describe("map rewrite — a writer keeps every value the map carried", () => {
  const TAG = "1.2.0-stable-20260728120000";

  // THE MAP AS THE TEMPLATE ACTUALLY WRITES IT (digita-deploy ansiwise/templates/cluster-map.tpl),
  // not the four fields this module happens to name. The schema lets `global` through on purpose,
  // so a chart can add a value without failing every map read — but a writer that emits only what
  // it understands turns that permission into DATA LOSS the moment anything rewrites the file, and
  // mark-slave rewrites a map on every deploy. Driven through writeClusterMarkingOnBranch, the
  // rewrite every deploy makes onto the cluster's own branch — the same serializeMarking every
  // writer of this file goes through.
  const FULL_MAP = [
    "stage: prod", "role: master", "booksCluster: m1.example.com", `release: ${TAG}`, "",
    "global:",
    "  domain: m1.example.com",
    "  clusterName: m1",
    "  booksCluster: m1.example.com",
    "  buildPlane: m1.example.com",
    "  unitApex: example.com",
    "  platformDomain: example.com",
    "  alertRecipients: ['ops@example.com']",
    "  catalogUrl: https://github.com/acme/acme-catalog.git",
    // THE SAME REPOSITORY AS owner/name, which is a different thing to read: every argocd file of
    // the platform stamps the bare owner/name into a URL of its own, so the map states both and a
    // writer that dropped this one would leave the next slave's branch cut with nothing to stamp.
    "  catalogRepo: acme/acme-catalog",
    "  letsencryptEmail: ops@example.com",
    "  letsencryptServer: https://acme-v02.api.letsencrypt.org/directory",
    "  nodeCidrs: [203.0.113.7/32]",
    "  vaultKubernetesAuthPath: kubernetes-m1",
    "  registryPullUser: acme-pull",
    "  registryPushUser: acme-push",
    "  endpoints:",
    "    registry:",
    "      host: zot.m1.example.com",
    "    mail: {url: 'https://post.example.com'}",
    "    vault: {url: 'https://vault.m1.example.com'}",
    "    idp: {url: 'https://idp.m1.example.com'}",
    "    tailnet: {url: 'https://tale.m1.example.com'}",
    "  servicesLocal:",
    "    registry: true",
    "    vault: true",
    "    observability: true",
  ].join("\n") + "\n";

  it("keeps every value the map carried, including the ones this module does not name", async () => {
    const repo = repoWith({ [MASTER]: FULL_MAP });
    const marking = await resolveClusterMarking(repo, MASTER);
    await writeClusterMarkingOnBranch(repo, marking, MASTER, "run_1");
    const after = repo.read(MASTER, clusterMapPath(MASTER)) ?? "";

    // Each of these is read by a chart. A rewrite that drops one leaves an installation whose charts
    // render against a value that is simply gone, and nothing between here and the render says so.
    for (const kept of [
      "clusterName: m1", "vaultKubernetesAuthPath: kubernetes-m1",
      "registryPullUser: acme-pull", "registryPushUser: acme-push",
      "host: zot.m1.example.com", "vault.m1.example.com", "idp.m1.example.com",
      "tale.m1.example.com", "servicesLocal",
      // FULL_MAP above states every key the map template writes, so this list can name every one
      // of them — which is the whole point of the case. Two were lost in exactly this way before
      // anybody thought to look: letsencryptEmail and letsencryptServer were read and never
      // written, and alertRecipients was written in the wrong shape.
      "catalogRepo: acme/acme-catalog",
      "letsencryptEmail: ops@example.com",
      "letsencryptServer: https://acme-v02.api.letsencrypt.org/directory",
      "nodeCidrs:", "203.0.113.7/32",
      "post.example.com",
      // The release pin is a key this manager never writes, so a rewrite that lost it would erase
      // the only statement of which platform release the cluster stands on.
      `release: ${TAG}`,
    ]) expect(after, `the rewrite dropped ${kept}`).toContain(kept);
    // THE ONE THAT GOT AWAY. It was joined on a comma while reading and written back as a plain
    // scalar, so a rewrite turned ['ops@example.com'] into `alertRecipients: ops@example.com` — and
    // the alert route ranges over that value, which is why the whole observability application then
    // stopped rendering at `range can't iterate over ops@example.com`. It stood outside the list
    // above, so the case that exists to catch exactly this could not see it.
    expect(after, "the recipients stay a list").toContain("alertRecipients: ['ops@example.com']");
  });

  it("keeps SEVERAL mailboxes as several, which one comma-joined scalar cannot say", async () => {
    // The shape is not cosmetic: a list of two written back as `a@x,b@x` is one mailbox whose name
    // contains a comma, and nothing downstream can tell it from a mailbox that really is called
    // that. The map template writes the flow list, and this writer puts the same value down the
    // same way.
    const two = FULL_MAP.replace("['ops@example.com']", "['ops@example.com', 'oncall@example.com']");
    const repo = repoWith({ [MASTER]: two });
    const marking = await resolveClusterMarking(repo, MASTER);
    await writeClusterMarkingOnBranch(repo, marking, MASTER, "run_1");

    const after = repo.read(MASTER, clusterMapPath(MASTER)) ?? "";
    expect(after).toContain("alertRecipients: ['ops@example.com', 'oncall@example.com']");
    expect(after, "and never as one joined word").not.toContain("ops@example.com,oncall@example.com");
  });

  it("refuses to read a map whose release is not a release tag — the field IS a pin, so free text names nothing", async () => {
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
