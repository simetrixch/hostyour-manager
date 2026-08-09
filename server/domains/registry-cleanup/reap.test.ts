import { describe, it, expect } from "vitest";
import { reap, type ReapDeps, type ReapLogger } from "./reap.ts";
import { FakeRegistryMaintenance } from "../../adapters/registry/testing/fake.ts";
import { FakeCarrierRepo, FakeUnitRepo, stageRegistration, pinFile } from "./carriers.fixture.ts";

// The reaper end-to-end against fakes — no git, no network, no registry. The safety proof lives here:
// DELETE is called for EXACTLY the computed delete-set and NEVER for a tag a carrier pins, a single
// bad read deletes NOTHING, and a floor that came back empty refuses the run outright.

const AUTH_REPO = "https://github.com/example/example-auth.git";

/** A release image tag: <version>-stable-<ts14>-<sha7>, as the release pipeline pushes it. */
const tagOf = (version: string, ts14: string): string => `${version}-stable-${ts14}-abc1234`;

/** One of the twelve AGED, unpinned tags every repository in the fixture carries. All of them are
 *  NEWER than every pin below, so the count trim reaches the pins and only the floor can save them —
 *  which is what makes this a proof rather than a coincidence. */
const agedTag = (n: number): string => tagOf("0.9.0", `202608010000${String(n).padStart(2, "0")}`);

/** The four pins the three carrier classes contribute. */
const AUTH_PIN = tagOf("0.4.0", "20260701000000");
const ENGINE_PIN = tagOf("0.3.0", "20260701000000");
const CONTROLLER_PIN_MASTER = tagOf("0.2.0", "20260701000000");
const CONTROLLER_PIN_BRANCH = tagOf("0.1.0", "20260601000000");

function makeLogger(): ReapLogger & { calls: { level: "info" | "warn" | "error"; obj: unknown; msg?: string }[] } {
  const calls: { level: "info" | "warn" | "error"; obj: unknown; msg?: string }[] = [];
  const rec = (level: "info" | "warn" | "error") => (obj: unknown, msg?: string): void => {
    calls.push({ level, obj, ...(msg !== undefined ? { msg } : {}) });
  };
  return { calls, info: rec("info"), warn: rec("warn"), error: rec("error") };
}

/** A repository holding `aged` aged tags (each a unique digest) plus the pinned tags given. */
function catalogRepo(repo: string, aged: number, pins: readonly string[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (let i = 0; i < aged; i++) tags[agedTag(i)] = `sha256:${repo}-aged${i}`;
  for (const [i, pin] of pins.entries()) tags[pin] = `sha256:${repo}-pin${i}`;
  return tags;
}

/**
 * The three carrier classes, together, as the floor sees them:
 *   (a) registration example-auth with a chartPath -> its repo's deploy/prod pins example-auth-backend
 *   (b) catalog books br. charts/example-engine/pins-dev.yaml    pins example-engine
 *   (c) hostyour-cloud master      apps/controller/values-prod.yaml      pins controller (newer)
 *       hostyour-cloud m1 branch apps/controller/values-prod.yaml     pins controller (OLDER)
 * Each of the three repositories additionally carries twelve aged, unpinned tags, all NEWER than the
 * pins, so every pin is outside the newest-ten and survives only because the floor holds it.
 *
 * `withDeployCarrier: false` takes class (b) out of the floor — the counter-probe.
 */
function threeClassFixture(opts: { withDeployCarrier?: boolean } = {}): {
  deps: Omit<ReapDeps, "logger" | "dryRun">;
  registry: FakeRegistryMaintenance;
} {
  const cloud = new FakeCarrierRepo();
  cloud.seed(cloud.booksBranch, "registrations/example-auth/prod.yaml", stageRegistration({ name: "example-auth", repoURL: AUTH_REPO, repoCredentialId: "cred_auth", chartPath: "deploy/chart", cluster: "m1" }));
  cloud.seed("master", "apps/controller/values-prod.yaml", pinFile([["controller", CONTROLLER_PIN_MASTER]]));
  cloud.seed("m1.example.com", "apps/controller/values-prod.yaml", pinFile([["controller", CONTROLLER_PIN_BRANCH]]));

  const deploy = new FakeCarrierRepo();
  // With the carrier: the chart states its pin. Without it: the same chart on the same branch, stating
  // no pins — exactly the floor class (b) would leave behind if it were dropped from the search.
  // The catalog pin stands on THIS installation's books branch, never on the trunk every
  // installation reads — see shared/pin.ts catalogPinFiles().
  deploy.seed(
    deploy.booksBranch,
    "charts/example-engine/pins-dev.yaml",
    opts.withDeployCarrier === false ? "global:\n  env: dev\n" : pinFile([["example-engine", ENGINE_PIN]]),
  );

  const unit = new FakeUnitRepo();
  unit.seed(AUTH_REPO, "deploy/prod", "deploy/chart/values-prod.yaml", pinFile([["example-auth-backend", AUTH_PIN]]));

  const registry = new FakeRegistryMaintenance({
    "example-auth-backend": catalogRepo("example-auth-backend", 12, [AUTH_PIN]),
    "example-engine": catalogRepo("example-engine", 12, [ENGINE_PIN]),
    controller: catalogRepo("controller", 12, [CONTROLLER_PIN_MASTER, CONTROLLER_PIN_BRANCH]),
    // A pull-through cache repo (multi-segment) with an ancient tag — never ours, never touched.
    "library/redis": { "7.0": "sha256:redis-old" },
  });

  return { deps: { cloud, deploy, unit, registry }, registry };
}

describe("reap — the floor IS the pin search, over all three carrier classes", () => {
  it("keeps all four pinned tags (the older install-branch pin included) and deletes only the aged unpinned ones", async () => {
    const { deps, registry } = threeClassFixture();

    const result = await reap({ ...deps, logger: makeLogger(), dryRun: false });

    const planFor = (repo: string): { keep: string[]; delete: string[] } => result.repos.find((r) => r.repo === repo)!;

    // All FOUR pinned keys are kept, and none of them is on any delete plan — although every one of
    // them is older than all twelve aged tags of its own repository.
    expect(planFor("example-auth-backend").keep).toContain(AUTH_PIN);
    expect(planFor("example-engine").keep).toContain(ENGINE_PIN);
    expect(planFor("controller").keep).toContain(CONTROLLER_PIN_MASTER);
    expect(planFor("controller").keep).toContain(CONTROLLER_PIN_BRANCH); // the OLDER install-branch pin
    expect(planFor("example-auth-backend").delete).not.toContain(AUTH_PIN);
    expect(planFor("example-engine").delete).not.toContain(ENGINE_PIN);
    expect(planFor("controller").delete).not.toContain(CONTROLLER_PIN_MASTER);
    expect(planFor("controller").delete).not.toContain(CONTROLLER_PIN_BRANCH);
    expect(result.referencedCount).toBe(4);

    // ...and the aged, unpinned tags of the SAME repositories still age out: twelve stable tags, ten
    // kept by count, so the two oldest fall. The floor protects what is pinned, not everything.
    expect(planFor("example-auth-backend").delete).toEqual([agedTag(0), agedTag(1)]);
    expect(planFor("example-engine").delete).toEqual([agedTag(0), agedTag(1)]);
    expect(planFor("controller").delete).toEqual([agedTag(0), agedTag(1)]);
    expect(registry.deleted.map((d) => d.digest).sort()).toEqual(
      [
        "sha256:controller-aged0",
        "sha256:controller-aged1",
        "sha256:example-auth-backend-aged0",
        "sha256:example-auth-backend-aged1",
        "sha256:example-engine-aged0",
        "sha256:example-engine-aged1",
      ].sort(),
    );
  });

  it("COUNTER-PROBE: take class (b) out of the floor and the example-engine pin lands on the delete plan", async () => {
    const { deps, registry } = threeClassFixture({ withDeployCarrier: false });

    const result = await reap({ ...deps, logger: makeLogger(), dryRun: false });

    // The one pin class (b) contributed is gone from the floor, so the tag the live tenant catalog
    // runs is now just an aged tag — planned for deletion, and deleted. That is the exact failure this
    // carrier class prevents.
    expect(result.repos.find((r) => r.repo === "example-engine")!.delete).toContain(ENGINE_PIN);
    expect(registry.deleted.some((d) => d.digest === "sha256:example-engine-pin0")).toBe(true);
    expect(result.referencedCount).toBe(3);
    // The other two classes are untouched by the switch — the probe discriminates exactly (b).
    expect(result.repos.find((r) => r.repo === "controller")!.delete).not.toContain(CONTROLLER_PIN_MASTER);
    expect(result.repos.find((r) => r.repo === "example-auth-backend")!.delete).not.toContain(AUTH_PIN);
  });

  it("never touches a multi-segment repository — those are pull-through caches, not our flat build names", async () => {
    const { deps, registry } = threeClassFixture();

    const result = await reap({ ...deps, logger: makeLogger(), dryRun: false });

    expect(result.repos.some((r) => r.repo.includes("/"))).toBe(false);
    expect(registry.deleted.some((d) => d.repo === "library/redis")).toBe(false);
  });

  it("DRY_RUN builds the full plan but deletes nothing", async () => {
    const { deps, registry } = threeClassFixture();

    const result = await reap({ ...deps, logger: makeLogger(), dryRun: true });

    expect(registry.deleted).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.repos.find((r) => r.repo === "controller")!.delete).toEqual([agedTag(0), agedTag(1)]);
  });

  it("digest-sharing guard: a delete candidate whose digest a KEPT tag shares is skipped", async () => {
    const { deps } = threeClassFixture();
    // Eleven aged tags: exactly one (the oldest) falls out by count. Give it the SAME digest as a tag
    // that is kept, and the delete would strip the kept tag too — so it must be skipped.
    const tags = catalogRepo("controller", 11, [CONTROLLER_PIN_MASTER, CONTROLLER_PIN_BRANCH]);
    tags[agedTag(0)] = "sha256:controller-aged5";
    const registry = new FakeRegistryMaintenance({ controller: tags });
    const logger = makeLogger();

    const result = await reap({ ...deps, registry, logger, dryRun: false });

    expect(result.repos.find((r) => r.repo === "controller")!.delete).toEqual([agedTag(0)]);
    expect(registry.deleted).toEqual([]); // ...but the shared-digest delete was skipped
    expect(result.deleted).toEqual([]);
    expect(logger.calls.some((c) => c.level === "warn" && String(c.msg).includes("digest is shared"))).toBe(true);
  });
});

describe("reap — an empty floor can never reach a delete plan", () => {
  it("REFUSES the run when the search found no pin at all — nothing is listed, nothing is deleted", async () => {
    // Every carrier is readable and every one of them is simply empty. This is what the floor looked
    // like the moment the tree it used to walk was gone: absent-is-empty, and every aged tag of every
    // repository on the delete plan.
    const registry = new FakeRegistryMaintenance({ controller: catalogRepo("controller", 12, []) });
    const logger = makeLogger();

    await expect(
      reap({ cloud: new FakeCarrierRepo(), deploy: new FakeCarrierRepo(), unit: new FakeUnitRepo(), registry, logger, dryRun: false }),
    ).rejects.toThrow(/referenced floor is EMPTY/);

    expect(registry.deleted).toEqual([]);
    // The abort lands BEFORE the catalog is read at all — no plan exists that anything could act on.
    expect(logger.calls.some((c) => String(c.msg).includes("retention plan"))).toBe(false);
  });

  it("REFUSES a DRY_RUN on an empty floor too — a plan nobody can trust must not be published either", async () => {
    const registry = new FakeRegistryMaintenance({ controller: catalogRepo("controller", 12, []) });

    await expect(
      reap({ cloud: new FakeCarrierRepo(), deploy: new FakeCarrierRepo(), unit: new FakeUnitRepo(), registry, logger: makeLogger(), dryRun: true }),
    ).rejects.toThrow(/referenced floor is EMPTY/);
  });
});

describe("reap — FAIL-CLOSED (a bug here destroys a deployment, so a bad read deletes nothing)", () => {
  it("a unit whose delivery branch cannot be read aborts the whole run before any delete", async () => {
    const { deps, registry } = threeClassFixture();
    const unit = new FakeUnitRepo(); // the registration stands, its deploy/prod branch does not

    await expect(reap({ ...deps, unit, logger: makeLogger(), dryRun: false })).rejects.toThrow(/delivery branch deploy\/prod/);
    expect(registry.deleted).toEqual([]);
  });

  it("a tags read that fails aborts with nothing deleted", async () => {
    const { deps } = threeClassFixture();
    const registry = new FakeRegistryMaintenance({ controller: catalogRepo("controller", 12, [CONTROLLER_PIN_MASTER]) }, { throwListTags: ["controller"] });

    await expect(reap({ ...deps, registry, logger: makeLogger(), dryRun: false })).rejects.toThrow(/scripted listTags failure/);
    expect(registry.deleted).toEqual([]);
  });

  it("a digest that cannot be resolved aborts BEFORE the first delete, not halfway through", async () => {
    const { deps } = threeClassFixture();
    const registry = new FakeRegistryMaintenance(
      { controller: catalogRepo("controller", 12, [CONTROLLER_PIN_MASTER, CONTROLLER_PIN_BRANCH]) },
      { throwDigest: [`controller:${agedTag(1)}`] },
    );

    await expect(reap({ ...deps, registry, logger: makeLogger(), dryRun: false })).rejects.toThrow(/scripted resolveDigest failure/);
    expect(registry.deleted).toEqual([]);
  });
});
