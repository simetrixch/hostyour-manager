import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../db/client.ts";
import { parseConfig, type Config } from "../kernel/config.ts";
import { createLogger } from "../kernel/logger.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "../executor/bus.ts";
import { buildRegistry } from "../domains/runs/registry.ts";
import { buildOnboarding } from "./wire-onboarding.ts";
import { RUN_FAMILY, RUN_KIND, type RunFamily, type RunKind } from "../../shared/enums.ts";
import type { AnyRunDefinition } from "../executor/types.ts";
import { FakePlatformRepo } from "../adapters/git/testing/fake.ts";
import { RELEASE_TAG_RE } from "../../shared/release.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../domains/inventory/channel-stages.ts";
import { runSelfChecks, runAsyncSelfChecks, assertBlockingChecksPass, readinessOf } from "./selfchecks.ts";

const BASE_ENV = {
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.example/o/controller/",
  OIDC_CLIENT_ID: "controller",
  OIDC_CLIENT_SECRET: "secret",
  CONTROLLER_VERSION: "test",
  DATA_DIR: "/data",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv;
// The bare config wires NEITHER onboarding family (no gate-runner addr, no github, no catalog
// PAT) — the boot a controller with onboarding off actually runs.
const config = parseConfig(BASE_ENV);
// registry.total reasons about the run families, and the two onboarding families are the opt-in ones
// (wire-onboarding.ts builds them only with their adapters) — so the check is exercised against the
// registry a FULLY configured controller builds as well, which is the one every deployment runs.
const wiredConfig = parseConfig({
  ...BASE_ENV,
  ONBOARD_GATE_CONTROLLER_ADDR: "10.152.183.5:8484",
  GITHUB_REPO: "simetrixch/hostyour-cloud",
  GITHUB_WRITE_PAT: "ghp_platform",
  CATALOG_WRITE_PAT: "ghp_deploy",
  // Both onboarding families write onto the branch this installation keeps its books on, which is
  // named after the cluster holding the master role — so a fully configured controller states it.
  MASTER_FQDN: "m1.example.com",
  MASTER_SSH_USER: "m1",
  MASTER_STAGE: "prod",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

describe("boot self-checks", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(onboardingConfig: Config = wiredConfig) {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-sc-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const onboarding = buildOnboarding(onboardingConfig, store, db.db, logger);
    const registry = buildRegistry({ db: db.db, ...(onboarding.platformRepo ? { platformRepo: onboarding.platformRepo } : {}) }, onboarding.defs);
    return { db, store, bus: new RunEventBus(), registry };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("passes every registered blocking check on a fresh DB", async () => {
    const { db, store, bus, registry } = fresh();
    const results = [...runSelfChecks({ db, config, store, bus, registry }), ...(await runAsyncSelfChecks({ db, config }))];
    const byName = new Map(results.map((r) => [r.name, r]));
    for (const name of [
      "db.integrity",
      "db.append_only",
      "publicUrl.derived",
      "store.mode_banner",
      "redact.canary",
      "sse.echo",
      "locks.rebuilt",
      "guards.armed",
      "registry.total",
      "forbidden.bytes",
      "session.roundtrip",
    ]) {
      expect(byName.get(name)?.ok, name).toBe(true);
    }
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
  });

  // The boot of a controller with onboarding off: buildOnboarding contributes no defs, so the consumer
  // and tenant families are absent WHOLE and their routes answer 501 NOT_CONFIGURED. Such a boot must
  // serve the run kinds it does hold, so every blocking check has to pass.
  it("passes every blocking check with NEITHER onboarding family wired", async () => {
    const { db, store, bus, registry } = fresh(config);
    const results = [...runSelfChecks({ db, config, store, bus, registry }), ...(await runAsyncSelfChecks({ db, config }))];
    expect(results.find((r) => r.name === "registry.total")?.ok).toBe(true);
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
    // What that boot serves is exactly the families buildRegistry registers unconditionally.
    expect([...registry.keys()].sort()).toEqual([...RUN_FAMILY.fixture, ...RUN_FAMILY.cluster].sort());
  });

  // The counter-probe of registry.total: HALF a family — some of its run kinds wired, some missing — is
  // the partial-wiring bug the check exists to catch, and it must ABORT boot rather than be noted.
  // Removing one definition from an otherwise wired family is that state exactly.
  it("registry.total is RED when a wired family is missing one of its kinds, and that fails boot", () => {
    const { db, store, bus, registry } = fresh();
    registry.delete("create-tenant");
    const results = runSelfChecks({ db, config, store, bus, registry });
    const check = results.find((r) => r.name === "registry.total");
    expect(check?.kind).toBe("blocking");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("tenant");
    expect(check?.detail).toContain("create-tenant");
    expect(() => assertBlockingChecksPass(results)).toThrow(/registry\.total/);
  });

  // The second counter-probe: a literal belonging to NO family — the definition-less run kind that has no
  // family to be half of. RUN_KIND is `as const`, so such a literal cannot be added in TypeScript; the
  // probe appends to the runtime array and restores it, which is the state that build would ship.
  it("registry.total is RED when a RUN_KIND literal belongs to no family, and that fails boot", () => {
    const { db, store, bus, registry } = fresh();
    const kinds = RUN_KIND as unknown as string[];
    kinds.push("ghost-kind");
    try {
      const results = runSelfChecks({ db, config, store, bus, registry });
      const check = results.find((r) => r.name === "registry.total");
      expect(check?.kind).toBe("blocking");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("ghost-kind");
      expect(() => assertBlockingChecksPass(results)).toThrow(/registry\.total/);
    } finally {
      kinds.pop();
    }
  });

  it("groups every RUN_KIND literal into exactly one family, and a wired boot registers them all", () => {
    const claimed: RunKind[] = [];
    for (const family of Object.keys(RUN_FAMILY) as RunFamily[]) claimed.push(...RUN_FAMILY[family]);
    // Equal as MULTISETS: every literal is claimed, and none is claimed twice.
    expect(claimed.sort()).toEqual([...RUN_KIND].sort());
    const { registry } = fresh();
    expect([...RUN_KIND].filter((kind) => !registry.has(kind))).toEqual([]);
    // ...and every registered definition answers to the kind it is filed under, so a def registered
    // twice under the wrong key could not make the check pass on a run kind nothing implements.
    for (const kind of RUN_KIND) expect((registry.get(kind) as AnyRunDefinition).kind).toBe(kind);
  });

  // The release grammar this Controller enforces (shared/release.ts RELEASE_TAG_RE) against the build
  // plane's copy of it (global.releaseTagFilter, platform/values-common.yaml on the platform repo's
  // trunk). A boot with the platform repo wired is the only place both sides are present.
  //
  /** The copy as the platform repo states it: the grammar without its anchors, derived rather than typed. */
  const MIRROR = RELEASE_TAG_RE.source.replace(/^\^/, "").replace(/\$$/, "");
  const DRIFTED = MIRROR.replace("{14}", "{12}");
  const platformRepoCarrying = (filter: string): FakePlatformRepo => {
    const repo = new FakePlatformRepo();
    repo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, `global:\n  releaseTagFilter: '${filter}'\n`);
    return repo;
  };

  it("release.grammar_mirror is GREEN when the platform repo carries the grammar this process enforces", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config, platformRepo: platformRepoCarrying(MIRROR) });
    const check = results.find((r) => r.name === "release.grammar_mirror");
    expect(check?.kind).toBe("degrading");
    expect(check?.ok).toBe(true);
    expect(readinessOf(results).checks).toContainEqual({ name: "release.grammar_mirror", ok: true });
  });

  // The counter-probe: one segment of the grammar changed on the platform side is the drift the check
  // exists to find, and the decision it embodies is that boot goes ON — a Controller with a stale or
  // unreadable platform checkout still serves everything that has nothing to do with release tags.
  it("release.grammar_mirror is RED on a drifted copy, names both literals, and does NOT fail boot", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config, platformRepo: platformRepoCarrying(DRIFTED) });
    const check = results.find((r) => r.name === "release.grammar_mirror");
    expect(check?.kind).toBe("degrading");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(RELEASE_TAG_RE.source);
    expect(check?.detail).toContain(`^${DRIFTED}$`);
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
    // Reported, and reported where an operator looks: /readyz stays 200 and carries the red line.
    expect(readinessOf(results).ok).toBe(true);
    expect(readinessOf(results).checks).toContainEqual({ name: "release.grammar_mirror", ok: false });
  });

  // The second counter-probe: a platform repo whose values file has lost the key. "I could not read
  // the other side" must not arrive as "the two agree".
  it("release.grammar_mirror is RED when the platform repo carries no filter at all", async () => {
    const { db } = fresh();
    const repo = new FakePlatformRepo();
    repo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, "global:\n  timezone: Europe/Amsterdam\n");
    const results = await runAsyncSelfChecks({ db, config, platformRepo: repo });
    const check = results.find((r) => r.name === "release.grammar_mirror");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("no readable global.releaseTagFilter");
  });

  // The third counter-probe, and the one that decides whether the check proves anything at all: with no
  // platform repo (the wiring's own optional — a Controller with onboarding off) there is no second
  // side. It must SKIP and say so, never report a pass, and never be listed on /readyz as measured.
  it("release.grammar_mirror SKIPS without a platform repo instead of reporting a pass", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config });
    const check = results.find((r) => r.name === "release.grammar_mirror");
    expect(check?.kind).toBe("skipped");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("platform repo is not configured");
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
    expect(readinessOf(results).ok).toBe(true);
    expect(readinessOf(results).checks.map((c) => c.name)).not.toContain("release.grammar_mirror");
  });

  it("the append-only probe leaves no sentinel row behind (rolled back)", () => {
    const { db, store, bus, registry } = fresh();
    runSelfChecks({ db, config, store, bus, registry });
    const count = db.sqlite.prepare("SELECT count(*) AS n FROM audit").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
