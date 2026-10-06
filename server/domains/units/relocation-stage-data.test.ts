import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbHandle } from "../../db/client.ts";
import type { Stage } from "../../../shared/enums.ts";
import { makeMigrateDef } from "./migrate.run.ts";
import { repointStep } from "#unit/server/relocation-migrate.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import { consumerRestoreJobs } from "./relocation-jobs-consumer.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedConsumerRegistration, makeFakes, consumerPorts, stepCtx, CONSUMER, SOURCE, TARGET,
} from "./relocation.fixture.ts";

// A consumer's move and restore across the stage boundary of the shared MongoDB. The provisioner
// serves a non-prod stage there as <name>_<stage>, so the relocation must dump, list, restore and drop
// those names, and must not land a unit on a cluster where another registration is served the same
// database or holds the same Redis keys or channels.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });

async function worldAt(stage: Stage) {
  seedClusters(db);
  seedConsumerRow(db, "active", stage);
  const f = makeFakes();
  const ports = consumerPorts(f);
  await seedConsumerRegistration(ports.registrations, { stage });
  return { f, ports, world: await consumerWorld(ports, "app_1")(stepCtx(db, "dump", {}, [])) };
}

const scripts = (jobs: readonly { spec: { name: string; script: string } }[], prefix: string): string =>
  jobs.filter((j) => j.spec.name.startsWith(prefix)).map((j) => j.spec.script).join("\n");

describe("a non-prod consumer on the shared MongoDB", () => {
  it("PLANTED: a TEST consumer's move dumps, lists and drops only its own stage's database", async () => {
    const { world } = await worldAt("test");
    const dump = scripts(await world.dumpJobs("gen", "name: acme\n", stepCtx(db, "dump", {}, [])), "reloc-dump-mongo");
    const list = (await world.sourceDbListJob(stepCtx(db, "verify-source-released", {}, [])))?.spec.script ?? "";
    const clear = scripts(await world.clearSourceJobs(stepCtx(db, "clear-source", {}, [])), "reloc-clear");
    for (const script of [dump, list, clear]) {
      expect(script).toContain(`"acme_db_test"`);
      expect(script).not.toContain(`"acme_db"`);
    }
  });

  it("a PROD consumer keeps the manifest's name", async () => {
    const { world } = await worldAt("prod");
    const dump = scripts(await world.dumpJobs("gen", "name: acme\n", stepCtx(db, "dump", {}, [])), "reloc-dump-mongo");
    expect(dump).toContain(`"acme_db"`);
    expect(dump).not.toContain(`"acme_db_prod"`);
  });
});

/** Run the shared-set restore script against stand-ins for rclone and mongorestore: the generation
 *  holds `archives`; answers what mongorestore was asked to restore, or the script's refusal. */
function restoreShared(databases: string[], archives: string[], opts: { failingGrep?: boolean } = {}): { restored: string[]; refusal?: string } {
  const dir = mkdtempSync(join(tmpdir(), "restore-stage-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(dir, "archives"), archives.map((a) => `${a}\n`).join(""));
  writeFileSync(join(bin, "rclone"), `#!/bin/sh\ncase "$1" in obscure) echo x;; lsf) cat "$STUB/archives";; copyto) : > "$3";; esac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "mongorestore"), `#!/bin/sh\necho "$*" >> "$STUB/restored"\n`, { mode: 0o755 });
  if (opts.failingGrep) writeFileSync(join(bin, "grep"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  const [job] = consumerRestoreJobs({
    name: CONSUMER, namespace: `${CONSUMER}-test`, stage: "test", databases, services: ["mongodb"], mongodb: "shared", pvcs: [], image: "dbtools:1", folder: "box/gen",
  }).filter((j) => j.spec.name.startsWith("reloc-restore-mongo"));
  const script = job!.spec.script.replaceAll("/tmp/", `${dir}/tmp/`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB: dir, STORAGE_BOX_HOST: "h", STORAGE_BOX_USER: "u", STORAGE_BOX_PASSWORD: "p", MONGO_HOST: "m", MONGO_ROOT_PASSWORD: "r" };
  const restored = (): string[] => (existsSync(join(dir, "restored")) ? readFileSync(join(dir, "restored"), "utf8").trim().split("\n") : []);
  try {
    execFileSync("/bin/sh", ["-ec", script], { env, stdio: "pipe" });
    return { restored: restored() };
  } catch (e) {
    return { restored: restored(), refusal: String((e as { stdout?: Buffer }).stdout ?? "") };
  }
}

describe("the shared-set restore", () => {
  it("PLANTED: refuses a generation holding a database the consumer is not served, and restores nothing", () => {
    const { restored, refusal } = restoreShared(["acme_db_test"], ["acme_db_test.archive", "acme_db.archive"]);
    expect(refusal).toMatch(/acme_db\.archive/);
    expect(restored).toEqual([]);
  });

  it("PLANTED: an archive whose name only contains a served name is foreign", () => {
    const { restored, refusal } = restoreShared(["acme_db_test"], ["acme_db_test.archive", "x_acme_db_test.archive"]);
    expect(refusal).toMatch(/x_acme_db_test\.archive/);
    expect(restored).toEqual([]);
  });

  it("PLANTED: a grep that fails stops the restore before anything is restored", () => {
    const { restored, refusal } = restoreShared(["acme_db_test"], ["acme_db_test.archive", "acme_db.archive"], { failingGrep: true });
    expect(refusal).toBeDefined();
    expect(restored).toEqual([]);
  });

  it("restores each served database, and only that database out of its archive", () => {
    const { restored, refusal } = restoreShared(["acme_db_test"], ["acme_db_test.archive"]);
    expect(refusal).toBeUndefined();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toContain(`--nsInclude=acme_db_test.*`);
  });
});

describe("moving or restoring onto a cluster where another registration holds the same data", () => {
  async function collidingTarget(stage: Stage) {
    const ctx = await worldAt(stage);
    // Another consumer on the target cluster is served the database this one would be served there.
    await ctx.ports.registrations.commitRegistration({
      unit: { name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false },
      builds: [],
      deploy: {
        stage: "prod", host: "other", chartPath: "deploy/chart", cluster: TARGET.cluster, keyPatterns: [], channelPatterns: [],
        databases: [stage === "prod" ? "acme_db" : `acme_db_${stage}`], services: ["mongodb"], size: "small", mongodb: "shared",
        quota: (await ctx.ports.registrations.readRegistration(stage, CONSUMER))!.entry.quota!,
      },
      runId: "run_other",
    });
    return ctx;
  }

  it("PLANTED: the move is refused at plan, naming both registrations and the database", async () => {
    const { ports } = await collidingTarget("prod");
    await expect(makeMigrateDef(ports).plan({ appId: "app_1", targetClusterId: TARGET.clusterId }, { db: db.db }))
      .rejects.toThrow(/acme at prod would be served the database acme_db on s2's shared MongoDB, which other at prod is served already/);
  });

  it("PLANTED: the repoint is refused before the registration moves", async () => {
    const { ports } = await collidingTarget("prod");
    await expect(repointStep(consumerWorld(ports, "app_1"), TARGET.clusterId).run(stepCtx(db, "repoint", {}, [])))
      .rejects.toThrow(/would be served the database acme_db on s2's shared MongoDB/);
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.cluster).toBe(SOURCE.cluster);
  });

  it("PLANTED: the restore is refused before the dumped registration is written", async () => {
    const { ports } = await collidingTarget("prod");
    const dumped = (await ports.registrations.readRegistration("prod", CONSUMER))!.entry;
    const ctx = stepCtx(db, "restore", {}, []);
    await expect((await consumerWorld(ports, "app_1")(ctx)).writeRegistrationFromDump(ctx, JSON.stringify(dumped), TARGET))
      .rejects.toThrow(/would be served the database acme_db on s2's shared MongoDB/);
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.cluster).toBe(SOURCE.cluster);
  });

  for (const space of ["keyPatterns", "channelPatterns"] as const) {
    it(`PLANTED: the restore is refused where another registration on the target holds the same Redis ${space}`, async () => {
      seedClusters(db);
      seedConsumerRow(db);
      const ports = consumerPorts(makeFakes());
      await seedConsumerRegistration(ports.registrations, { services: ["redis"], databases: [], [space]: ["acme:*"] });
      await seedConsumerRegistration(ports.registrations, { name: "other", cluster: TARGET.cluster, services: ["redis"], databases: [], [space]: ["acme:*"] });
      const dumped = (await ports.registrations.readRegistration("prod", CONSUMER))!.entry;
      const ctx = stepCtx(db, "restore", {}, []);
      await expect((await consumerWorld(ports, "app_1")(ctx)).writeRegistrationFromDump(ctx, JSON.stringify(dumped), TARGET))
        .rejects.toThrow(/acme at prod would be granted the Redis (keys|channels) acme:\* on s2's shared Redis, which meet the (keys|channels) acme:\* of other at prod/);
    });
  }

  it("a restore of a unit on its own Redis is admitted beside the same patterns on the shared one", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const ports = consumerPorts(makeFakes());
    await seedConsumerRegistration(ports.registrations, { services: ["redis"], databases: [], keyPatterns: ["acme:*"], redis: "standalone" });
    await seedConsumerRegistration(ports.registrations, { name: "other", cluster: TARGET.cluster, services: ["redis"], databases: [], keyPatterns: ["acme:*"] });
    const dumped = (await ports.registrations.readRegistration("prod", CONSUMER))!.entry;
    const ctx = stepCtx(db, "restore", {}, []);
    await expect((await consumerWorld(ports, "app_1")(ctx)).writeRegistrationFromDump(ctx, JSON.stringify(dumped), TARGET)).resolves.toBeUndefined();
  });

  it("PLANTED: a TEST move is refused at plan where the target serves the same _test database", async () => {
    const { ports } = await worldAt("test");
    await seedConsumerRegistration(ports.registrations, { name: "other", cluster: TARGET.cluster, databases: ["acme_db_test"] });
    await expect(makeMigrateDef(ports).plan({ appId: "app_1", targetClusterId: TARGET.clusterId }, { db: db.db }))
      .rejects.toThrow(/acme at test would be served the database acme_db_test/);
  });

  it("a TEST move is planned beside a PROD unit that holds the literal name on the target", async () => {
    const { ports } = await worldAt("test");
    await seedConsumerRegistration(ports.registrations, { name: "other", cluster: TARGET.cluster, databases: ["acme_db"] });
    await expect(makeMigrateDef(ports).plan({ appId: "app_1", targetClusterId: TARGET.clusterId }, { db: db.db })).resolves.toMatchObject({ kind: "consumer-migrate" });
  });

  it("PLANTED: a TEST restore is refused where the target serves the same _test database", async () => {
    const { ports } = await worldAt("test");
    await seedConsumerRegistration(ports.registrations, { name: "other", cluster: TARGET.cluster, databases: ["acme_db_test"] });
    const dumped = (await ports.registrations.readRegistration("test", CONSUMER))!.entry;
    const ctx = stepCtx(db, "restore", {}, []);
    await expect((await consumerWorld(ports, "app_1")(ctx)).writeRegistrationFromDump(ctx, JSON.stringify(dumped), TARGET))
      .rejects.toThrow(/acme at test would be served the database acme_db_test/);
  });

  it("a move onto a cluster where nothing collides is planned", async () => {
    const { ports } = await worldAt("prod");
    await expect(makeMigrateDef(ports).plan({ appId: "app_1", targetClusterId: TARGET.clusterId }, { db: db.db })).resolves.toMatchObject({ kind: "consumer-migrate" });
  });
});

describe("the restore re-commits the unit's Redis mode", () => {
  async function restoredRedis(over: { redis?: "standalone" }) {
    seedClusters(db);
    seedConsumerRow(db);
    const ports = consumerPorts(makeFakes());
    await seedConsumerRegistration(ports.registrations, { services: ["redis"], databases: [], ...over });
    const dumped = (await ports.registrations.readRegistration("prod", CONSUMER))!.entry;
    const ctx = stepCtx(db, "restore", {}, []);
    await (await consumerWorld(ports, "app_1")(ctx)).writeRegistrationFromDump(ctx, JSON.stringify(dumped), TARGET);
    return (await ports.registrations.readRegistration("prod", CONSUMER))!.entry;
  }

  it("PLANTED: a restored own-Redis unit keeps redis: standalone and its maxmemory policy", async () => {
    const back = await restoredRedis({ redis: "standalone" });
    expect([back.cluster, back.redis, back.redisMaxmemoryPolicy]).toEqual([TARGET.cluster, "standalone", "noeviction"]);
  });

  it("a restored shared-Redis unit stays without either field", async () => {
    const back = await restoredRedis({});
    expect([back.cluster, back.redis, back.redisMaxmemoryPolicy]).toEqual([TARGET.cluster, undefined, undefined]);
  });
});

