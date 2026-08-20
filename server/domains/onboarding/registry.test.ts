import { describe, it, expect } from "vitest";
import { seedQuota, type UnitQuota } from "../../../shared/unit-size.ts";
import { z } from "zod";
import { Registry, serializePointer, parseFlatYaml, makeRegistrationGuard, trailer, clusterStageFromMarkings, type ClusterStageResolver } from "./registry.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { ConsumerRegistrationSchema, type ConsumerRegistration } from "../../../shared/consumer.ts";
import type { Stage } from "../../../shared/enums.ts";

const REPO = "https://github.com/x/acme.git";

/** The unit half of a commit — the fields both files of a unit carry. */
function unit(over: Partial<ConsumerRegistration> = {}) {
  return { name: "acme", repoURL: REPO, suspended: false, quiesced: false, ...over };
}

/** The deploy group of one stage, as an onboard freezes it — `fqdn` where the manifest declared one. */
function deploy(over: Partial<{ stage: Stage; chartPath: string; cluster: string; databases: string[]; services: ConsumerRegistration["services"]; size: "small" | "medium" | "large"; mongodb: "shared" | "standalone" | "replicaset"; quota: UnitQuota; fqdn: string }> = {}) {
  return { stage: "prod" as Stage, chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"), ...over };
}

/** A cluster-marking resolver that answers from a literal name -> stage map. Stands in for the maps
 *  under clusters/active/ so a guard test states BOTH sides of the boundary in one place. */
function marked(byName: Record<string, Stage>): ClusterStageResolver {
  return async (cluster: string) => {
    const stage = byName[cluster];
    if (!stage) throw new Error(`no cluster map for "${cluster}"`);
    return { name: cluster, stage };
  };
}

const CLUSTERS = marked({ s1: "prod", s1dev: "dev" });

describe("ConsumerRegistrationSchema", () => {
  it("refuses a name that is not basename(repoURL)", () => {
    const r = ConsumerRegistrationSchema.safeParse({ name: "other", repoURL: REPO, suspended: false, quiesced: false, builds: [] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("basename(repoURL)");
  });

  it("accepts the build form: builds[] and no deploy-group field", () => {
    const r = ConsumerRegistrationSchema.safeParse({ ...unit(), builds: ["acme-backend"] });
    expect(r.success).toBe(true);
    expect(r.data?.builds).toEqual(["acme-backend"]);
  });

  it("refuses a deploy-group field in a build registration", () => {
    for (const field of [{ chartPath: "deploy/chart" }, { databases: ["example_auth"] }, { services: ["postgresql"] }]) {
      const r = ConsumerRegistrationSchema.safeParse({ ...unit(), builds: [], ...field });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toContain("deploy-group field");
    }
  });

  it("refuses a build registration without builds[] — an empty list is the way to say the unit builds nothing", () => {
    expect(ConsumerRegistrationSchema.safeParse(unit()).success).toBe(false);
    expect(ConsumerRegistrationSchema.safeParse({ ...unit(), builds: [] }).success).toBe(true);
  });

  it("accepts the stage form and requires the WHOLE deploy group, services and size included", () => {
    expect(ConsumerRegistrationSchema.safeParse({ ...unit(), chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") }).success).toBe(true);
    const missing = ConsumerRegistrationSchema.safeParse({ ...unit(), chartPath: "deploy/chart", cluster: "s1", databases: [] });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.path.join("."))).toContain("services");
    // The size stands or falls with the rest: the consumers ApplicationSet composes the preset
    // file name from it and reads it BARE, so an absent one is a render failure for the whole
    // consumer rather than a quiet fall back to a size nobody chose. `mongodb` is in the group for
    // the same reason — the appset gates the per-consumer MongoDB source on it.
    expect(missing.error?.issues.map((i) => i.path.join("."))).toContain("size");
    expect(missing.error?.issues.map((i) => i.path.join("."))).toContain("mongodb");
  });

  it("refuses builds[] in a stage registration", () => {
    const r = ConsumerRegistrationSchema.safeParse({ ...unit(), chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"), builds: ["acme-backend"] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("stage-free build registration");
  });

  it("defaults suspended + quiesced to false so a chart may read them bare", () => {
    const r = ConsumerRegistrationSchema.parse({ name: "acme", repoURL: REPO, builds: [] });
    expect(r.suspended).toBe(false);
    expect(r.quiesced).toBe(false);
  });
});

describe("serializePointer (generic over the registration schemas)", () => {
  it("round-trips a validated registration as injection-safe flat YAML", () => {
    const y = serializePointer(ConsumerRegistrationSchema, ConsumerRegistrationSchema.parse({ ...unit({ repoCredentialId: "cred_1" }), builds: ["acme-backend"] }));
    expect(y).toContain('name: "acme"');
    expect(y).toContain('repoCredentialId: "cred_1"');
    expect(y).toContain('builds: ["acme-backend"]');
    expect(y).toContain("suspended: false");
    expect(y).toContain("quiesced: false");
  });

  it("carries the literal databases[] and the claimed services[] verbatim", () => {
    const { stage: _stage, ...group } = deploy({ databases: ["example_auth"], services: ["postgresql"] });
    const y = serializePointer(ConsumerRegistrationSchema, ConsumerRegistrationSchema.parse({ ...unit(), ...group }));
    expect(y).toContain('databases: ["example_auth"]');
    expect(y).toContain('services: ["postgresql"]');
    const back = ConsumerRegistrationSchema.parse(parseFlatYaml(y));
    expect(back.databases).toEqual(["example_auth"]);
    expect(back.services).toEqual(["postgresql"]);
  });
});

// A schema shaped like the tenant registration (a nested apps[]) — proves serializePointer's
// generalization + the deep-equal round-trip without depending on shared/tenant.ts.
const NestedSchema = z.object({
  cluster: z.string(),
  apps: z.array(z.object({ name: z.string() })).default([]),
  suspended: z.boolean().default(false),
});
type Nested = z.infer<typeof NestedSchema>;

const nested: Nested = { cluster: "s1", apps: [{ name: "shop" }, { name: "web" }], suspended: false };

describe("serializePointer (deep-equal round-trip)", () => {
  it("round-trips a nested-array value instead of throwing INTERNAL", () => {
    // A reference `!==` holds only for flat scalars: a nested value always re-parses to a NEW
    // reference, so a reference compare would throw INTERNAL on every nested commit.
    expect(() => serializePointer(NestedSchema, nested)).not.toThrow();
    expect(NestedSchema.parse(parseFlatYaml(serializePointer(NestedSchema, nested)))).toEqual(nested);
  });

  it("emits nested values as one-line JSON (valid YAML, injection-safe)", () => {
    const yaml = serializePointer(NestedSchema, nested);
    expect(yaml).toContain('cluster: "s1"');
    expect(yaml).toContain('apps: [{"name":"shop"},{"name":"web"}]');
  });

  it("round-trips an empty nested array", () => {
    const minimal: Nested = { cluster: "s1", apps: [], suspended: false };
    expect(NestedSchema.parse(parseFlatYaml(serializePointer(NestedSchema, minimal)))).toEqual(minimal);
  });

  it("still serializes a flat entry (deep-equal reduces to identity on scalars)", () => {
    expect(serializePointer(z.object({ name: z.string() }), { name: "acme" })).toBe('name: "acme"\n');
  });
});

describe("parseFlatYaml", () => {
  it("restores nested objects and arrays from one-line JSON values", () => {
    const parsed = parseFlatYaml('apps: [{"name":"shop"}]\nservices: ["postgresql"]\n');
    expect(parsed).toEqual({ apps: [{ name: "shop" }], services: ["postgresql"] });
  });

  it("skips blank lines and throws INTERNAL on a line without a colon", () => {
    expect(parseFlatYaml('\nname: "acme"\n\n')).toEqual({ name: "acme" });
    expect(() => parseFlatYaml("garbage-without-colon")).toThrow(/unparseable registration line/);
  });
});

describe("makeRegistrationGuard (reusable path-guard factory)", () => {
  const guardTenant = makeRegistrationGuard(/^registrations\/[0-9a-hjkmnp-tv-z]{12}\/(dev|test|prod)\.yaml$/, "registrations/<guid>/<stage>.yaml");

  it("returns the path when it matches the namespace", () => {
    expect(guardTenant("registrations/zsjs023ctne0/prod.yaml")).toBe("registrations/zsjs023ctne0/prod.yaml");
  });

  it("throws INTERNAL for a path outside the namespace", () => {
    expect(() => guardTenant("registrations/acme/prod.yaml")).toThrow(/path guard/);
  });

  it("rejects a `..` traversal even when the pattern would otherwise match", () => {
    const loose = makeRegistrationGuard(/^x\/.*$/, "x/");
    expect(loose("x/ok/file")).toBe("x/ok/file");
    expect(() => loose("x/../etc/passwd")).toThrow(/path guard/);
  });
});

describe("trailer", () => {
  it("wraps the run id in brackets", () => {
    expect(trailer("run_1")).toBe("[run_1]");
  });
});

describe("Registry.commitRegistration", () => {
  it("writes build.yaml AND the stage file in ONE commit on the books branch, with a run-id trailer", async () => {
    const repo = new FakePlatformRepo();
    await new Registry(repo, CLUSTERS).commitRegistration({ unit: unit(), builds: ["acme-backend"], deploy: deploy(), runId: "run_1" });
    expect(repo.commits).toHaveLength(1);
    const c = repo.commits[0]!;
    expect(c.branch).toBe(repo.booksBranch); // this installation's books, never the trunk
    expect(c.message).toBe("register(acme): prod on s1 [run_1]");
    expect(c.write?.map((w) => w.path)).toEqual(["registrations/acme/build.yaml", "registrations/acme/prod.yaml"]);
  });

  it("writes build.yaml alone for a build-only unit", async () => {
    const repo = new FakePlatformRepo();
    await new Registry(repo, CLUSTERS).commitRegistration({ unit: unit(), builds: [], runId: "run_1" });
    expect(repo.commits[0]!.write?.map((w) => w.path)).toEqual(["registrations/acme/build.yaml"]);
    expect(repo.commits[0]!.message).toBe("register(acme): build none [run_1]");
  });

  it("NEVER puts a deploy-group field in build.yaml", async () => {
    const repo = new FakePlatformRepo();
    await new Registry(repo, CLUSTERS).commitRegistration({
      unit: unit(),
      builds: ["acme-backend"],
      deploy: deploy({ databases: ["example_auth"], services: ["postgresql"] }),
      runId: "run_1",
    });
    const build = repo.commits[0]!.write!.find((w) => w.path === "registrations/acme/build.yaml")!.content;
    for (const key of ["chartPath", "cluster", "databases", "services"]) {
      expect(build).not.toContain(`${key}:`);
    }
    expect(build).toContain('builds: ["acme-backend"]');
    // …while the stage file carries the whole group and no builds[].
    const stage = repo.commits[0]!.write!.find((w) => w.path === "registrations/acme/prod.yaml")!.content;
    expect(stage).toContain('cluster: "s1"');
    expect(stage).toContain('services: ["postgresql"]');
    expect(stage).not.toContain("builds:");
  });

  it("refuses a stage registration whose cluster is marked for a DIFFERENT stage, naming both sides", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await expect(
      reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "prod", cluster: "s1dev" }), runId: "run_1" }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining('cluster "s1dev" is marked "dev"') });
    // Nothing was written — the boundary is checked BEFORE anything is staged, build.yaml included.
    expect(repo.commits).toHaveLength(0);
  });

  it("refuses a registration whose name disagrees with its repo, at the schema", async () => {
    const repo = new FakePlatformRepo();
    await expect(
      new Registry(repo, CLUSTERS).commitRegistration({ unit: unit({ name: "other" }), builds: [], runId: "run_1" }),
    ).rejects.toThrow(/basename\(repoURL\)/);
  });

  it("reads back the stage registration it wrote", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit({ repoCredentialId: "cred_1", owner: "team-acme" }), builds: [], deploy: deploy(), runId: "run_1" });
    const read = await reg.readRegistration("prod", "acme");
    expect(read?.entry.name).toBe("acme");
    expect(read?.entry.cluster).toBe("s1");
    expect(read?.entry.repoCredentialId).toBe("cred_1");
    expect(read?.entry.suspended).toBe(false);
  });
});

describe("Registry.removeRegistration", () => {
  it("removes the stage file AND build.yaml when it was the unit's last stage", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: ["acme-backend"], deploy: deploy(), runId: "run_1" });
    const { unitRemoved } = await reg.removeRegistration("prod", "acme", "run_2");
    expect(unitRemoved).toBe(true);
    expect(repo.commits.at(-1)!.remove).toEqual(["registrations/acme/prod.yaml", "registrations/acme/build.yaml"]);
    expect(await reg.readRegistration("prod", "acme")).toBeNull();
  });

  it("keeps build.yaml while ANOTHER stage still registers the unit", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, marked({ s1: "prod", s1dev: "dev" }));
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "dev", cluster: "s1dev" }), runId: "run_2" });
    const { unitRemoved } = await reg.removeRegistration("prod", "acme", "run_3");
    expect(unitRemoved).toBe(false);
    expect(repo.commits.at(-1)!.remove).toEqual(["registrations/acme/prod.yaml"]);
    expect((await reg.readRegistration("dev", "acme"))?.entry.cluster).toBe("s1dev");
  });

  it("refuses a second removal", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.removeRegistration("prod", "acme", "run_2");
    await expect(reg.removeRegistration("prod", "acme", "run_3")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("Registry.readUnitStages", () => {
  it("names every stage a unit stands at, and nothing for a unit that stands at none", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, marked({ s1: "prod", s1dev: "dev" }));
    expect(await reg.readUnitStages("acme")).toEqual([]);
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "dev", cluster: "s1dev" }), runId: "run_2" });
    // STAGE order, not commit order — the reader walks the enum.
    expect(await reg.readUnitStages("acme")).toEqual(["dev", "prod"]);
    // A build-only unit carries build.yaml and no stage file, which this reader does not count: it
    // answers "at which stages does this unit deploy", the question every per-unit teardown asks.
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: ["other-api"], runId: "run_3" });
    expect(await reg.readUnitStages("other")).toEqual([]);
  });

  it("drops a stage as its registration is removed — the source every per-unit teardown reads", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, marked({ s1: "prod", s1dev: "dev" }));
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "dev", cluster: "s1dev" }), runId: "run_2" });
    await reg.removeRegistration("prod", "acme", "run_3");
    expect(await reg.readUnitStages("acme")).toEqual(["dev"]);
    await reg.removeRegistration("dev", "acme", "run_4");
    expect(await reg.readUnitStages("acme")).toEqual([]);
  });
});

describe("Registry.listAttestedBuildNames", () => {
  it("returns every OTHER unit's build names, tagged with the unit that attested them", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: ["acme-backend"], deploy: deploy(), runId: "run_1" });
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: ["other-api", "other-web"], runId: "run_2" });
    expect(await reg.listAttestedBuildNames("acme")).toEqual([
      { unit: "other", build: "other-api" },
      { unit: "other", build: "other-web" },
    ]);
    // Its own registration is excluded — a unit re-onboarding must not collide with itself.
    expect(await reg.listAttestedBuildNames("other")).toEqual([{ unit: "acme", build: "acme-backend" }]);
  });

  it("THROWS on a build.yaml that does not validate — a shrunken set would pass a taken name", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/broken/build.yaml", "name: broken\nrepoURL: not-a-url\n");
    await expect(new Registry(repo, CLUSTERS).listAttestedBuildNames("acme")).rejects.toThrow(/registrations\/broken\/build\.yaml/);
  });
});

describe("Registry.listAttestedFqdns", () => {
  it("returns every attested fqdn except the candidate's own stage, skipping stage files that attest none", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, marked({ s1: "prod", s1dev: "dev" }));
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ fqdn: "shop.example.org" }), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "dev", cluster: "s1dev" }), runId: "run_2" });
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: [], deploy: deploy({ fqdn: "other.example.org" }), runId: "run_3" });
    expect(await reg.listAttestedFqdns({ unit: "acme", stage: "prod" })).toEqual([{ unit: "other", stage: "prod", fqdn: "other.example.org" }]);
    // Its own SAME-STAGE registration is excluded — a unit re-onboarding must not collide with itself.
    expect(await reg.listAttestedFqdns({ unit: "other", stage: "prod" })).toEqual([{ unit: "acme", stage: "prod", fqdn: "shop.example.org" }]);
  });

  it("keeps the SAME unit's OTHER stages in the set — a stage-less manifest fqdn must not be attested at two stages", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, marked({ s1: "prod", s1dev: "dev" }));
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ fqdn: "shop.example.org" }), runId: "run_1" });
    // Onboarding acme at DEV sees acme's own PROD attestation as taken.
    expect(await reg.listAttestedFqdns({ unit: "acme", stage: "dev" })).toEqual([{ unit: "acme", stage: "prod", fqdn: "shop.example.org" }]);
  });

  it("THROWS on a stage file that does not validate — a shrunken set would grant a taken name", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/broken/prod.yaml", "name: broken\nrepoURL: not-a-url\n");
    await expect(new Registry(repo, CLUSTERS).listAttestedFqdns({ unit: "acme", stage: "dev" })).rejects.toThrow(/registrations\/broken\/prod\.yaml/);
  });
});

describe("Registry.listConsumerRegistrations", () => {
  it("returns only the units this cluster carries at this stage", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, marked({ s1: "prod", s2: "prod" }));
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.commitRegistration({
      unit: { name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false },
      builds: [],
      deploy: deploy({ cluster: "s2" }),
      runId: "run_2",
    });
    const scan = await reg.listConsumerRegistrations("s1.example.com", "prod");
    expect(scan.registrations.map((r) => r.name)).toEqual(["acme"]);
    expect(scan.skipped).toEqual([]);
  });

  it("never sees a build-only unit", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: ["acme-backend"], runId: "run_1" });
    const scan = await reg.listConsumerRegistrations("s1.example.com", "prod");
    expect(scan.registrations).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  it("reports a body whose name disagrees with its directory instead of re-keying it", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/acme/prod.yaml", serializePointer(ConsumerRegistrationSchema, ConsumerRegistrationSchema.parse({
      name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false,
      chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"),
    })));
    const scan = await new Registry(repo, CLUSTERS).listConsumerRegistrations("s1.example.com", "prod");
    expect(scan.registrations).toEqual([]);
    expect(scan.skipped[0]?.reason).toContain("disagrees with its directory name");
  });

  it("reports a stage file that carries no deploy group", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/acme/prod.yaml", serializePointer(ConsumerRegistrationSchema, ConsumerRegistrationSchema.parse({ ...unit(), builds: [] })));
    const scan = await new Registry(repo, CLUSTERS).listConsumerRegistrations("s1.example.com", "prod");
    expect(scan.registrations).toEqual([]);
    expect(scan.skipped[0]?.reason).toContain("carries no deploy group");
  });

  it("reports an unparseable file rather than dropping it", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/acme/prod.yaml", "garbage-without-colon\n");
    const scan = await new Registry(repo, CLUSTERS).listConsumerRegistrations("s1.example.com", "prod");
    expect(scan.skipped[0]?.name).toBe("acme");
    expect(scan.skipped[0]?.reason).toContain("not readable registration YAML");
  });
});

describe("clusterStageFromMarkings", () => {
  it("resolves a cluster's stage off its own map on the books branch", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "clusters/active/s1.example.com.yaml", 'fqdn: "s1.example.com"\nstage: "prod"\nrole: "slave"\nbuild-plane: "m1.example.com"\n');
    const resolve = clusterStageFromMarkings(repo);
    await expect(resolve("s1")).resolves.toEqual({ name: "s1", stage: "prod" });
    await expect(resolve("s1.example.com")).resolves.toEqual({ name: "s1", stage: "prod" });
  });
});

describe("Registry.readClusterValueFiles", () => {
  it("reads the chain off the install branch in layering order", async () => {
    const repo = new FakePlatformRepo();
    repo.seed("s1.example", "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
    repo.seed("s1.example", "platform/values-prod.yaml", "global:\n  env: prod\n");
    repo.seed("s1.example", "installation/profile.yaml", "global:\n  vaultUrl: https://vault.s1.example:8200\n");

    const files = await new Registry(repo, CLUSTERS).readClusterValueFiles("s1.example", "prod");
    expect(files.map((f) => f.path)).toEqual([
      "platform/values-common.yaml",
      "platform/values-prod.yaml",
      "installation/profile.yaml",
    ]);
    expect(files[1]!.content).toContain("env: prod");
  });

  it("throws UPSTREAM when a chain file is missing", async () => {
    // A branch that carries only part of the chain: seeding one file marks it materialized, so the
    // fake's own default seed never fills the rest in.
    const repo = new FakePlatformRepo();
    repo.seed("bare.example", "platform/values-common.yaml", "global: {}\n");
    await expect(new Registry(repo, CLUSTERS).readClusterValueFiles("bare.example", "prod")).rejects.toMatchObject({ code: "UPSTREAM" });
  });
});
