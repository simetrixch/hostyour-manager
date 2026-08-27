import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../db/client.ts";
import { parseConfig, type Config } from "../kernel/config.ts";
import { createLogger } from "../kernel/logger.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "../executor/bus.ts";
import { buildRunDefinitions } from "../domains/runs/run-definitions.ts";
import { buildUnits } from "./wire-units.ts";
import { RUN_FAMILY, RUN_KIND, type RunFamily, type RunKind } from "../../shared/enums.ts";
import type { AnyRunDefinition } from "../executor/types.ts";
import { FakePlatformRepo } from "../adapters/git/testing/fake.ts";
import { RELEASE_TAG_RE } from "../../shared/release.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../domains/inventory/channel-stages.ts";
import { PRODUCT_BRANCH } from "../../shared/branches.ts";
import { INSTALL_ORDER_PATH } from "../domains/inventory/install-order.ts";
import { runSelfChecks, runAsyncSelfChecks, assertBlockingChecksPass, readinessOf } from "./selfchecks.ts";

const BASE_ENV = {
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.example/o/manager/",
  OIDC_CLIENT_ID: "manager",
  OIDC_CLIENT_SECRET: "secret",
  MANAGER_VERSION: "test",
  DATA_DIR: "/data",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv;
// The bare config wires NEITHER onboarding family (no gate-runner addr, no github, no catalog
// PAT) — the boot a manager with onboarding off actually runs.
const config = parseConfig(BASE_ENV);
// run-definitions.total reasons about the run families, and the two onboarding families are the opt-in ones
// (wire-units.ts builds them only with their adapters) — so the check is exercised against the
// runDefinitions a FULLY configured manager builds as well, which is the one every deployment runs.
const wiredConfig = parseConfig({
  ...BASE_ENV,
  ONBOARD_GATE_MANAGER_ADDR: "10.152.183.5:8484",
  GITHUB_REPO: "simetrixch/hostyour-cloud",
  GITHUB_WRITE_PAT: "ghp_platform",
  CATALOG_REPO: "acme/acme-catalog",
  CATALOG_WRITE_PAT: "ghp_deploy",
  // Both onboarding families write onto the branch this installation keeps its books on, which is
  // named after the cluster holding the master role — so a fully configured manager states it.
  MASTER_FQDN: "m1.example.com",
  MASTER_SSH_USER: "m1",
  MASTER_STAGE: "prod",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

describe("boot self-checks", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(onboardingConfig: Config = wiredConfig) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-sc-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const onboarding = buildUnits(onboardingConfig, store, db.db, logger);
    const runDefinitions = buildRunDefinitions({ db: db.db, ...(onboarding.platformRepo ? { platformRepo: onboarding.platformRepo } : {}) }, onboarding.defs);
    return { db, store, bus: new RunEventBus(), runDefinitions };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("passes every registered blocking check on a fresh DB", async () => {
    const { db, store, bus, runDefinitions } = fresh();
    const results = [...runSelfChecks({ db, config, store, bus, runDefinitions }), ...(await runAsyncSelfChecks({ db, config }))];
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
      "run-definitions.total",
      "forbidden.bytes",
      "session.roundtrip",
    ]) {
      expect(byName.get(name)?.ok, name).toBe(true);
    }
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
  });

  // The boot of a manager with onboarding off: buildUnits contributes no defs, so the consumer
  // and tenant families are absent WHOLE and their routes answer 501 NOT_CONFIGURED. Such a boot must
  // serve the run kinds it does hold, so every blocking check has to pass.
  it("passes every blocking check with NEITHER onboarding family wired", async () => {
    const { db, store, bus, runDefinitions } = fresh(config);
    const results = [...runSelfChecks({ db, config, store, bus, runDefinitions }), ...(await runAsyncSelfChecks({ db, config }))];
    expect(results.find((r) => r.name === "run-definitions.total")?.ok).toBe(true);
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
    // What that boot serves is exactly the families buildRunDefinitions registers unconditionally.
    expect([...runDefinitions.keys()].sort()).toEqual([...RUN_FAMILY.fixture, ...RUN_FAMILY.cluster].sort());
  });

  // runs.kinds_known measures the DATABASE, not the code: what it catches is a row left standing
  // under a spelling RUN_KIND has dropped, which is what a data migration over runs.kind leaves
  // behind when it misses one. Both probes plant real rows, because a row is the only thing this
  // check reads.
  it("runs.kinds_known passes on a database whose rows all stand under kinds this build names", () => {
    const { db, store, bus, runDefinitions } = fresh();
    // The INNOCENT CASE, planted rather than assumed: an empty table would pass a check that had
    // stopped looking at the column altogether.
    db.sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?,?,?,?,?,?,?,?)")
      .run("run_ok", "consumer-backup", "app", "app_1", "{}", "{}", "succeeded", "op_system");
    const check = runSelfChecks({ db, config, store, bus, runDefinitions }).find((r) => r.name === "runs.kinds_known");
    expect(check?.kind).toBe("degrading");
    expect(check?.ok).toBe(true);
  });

  it("runs.kinds_known is RED — and names the spelling — when a row stands under a kind this build dropped, without blocking boot", () => {
    const { db, store, bus, runDefinitions } = fresh();
    db.sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?,?,?,?,?,?,?,?)")
      .run("run_old", "backup", "app", "app_1", "{}", "{}", "succeeded", "op_system");
    const results = runSelfChecks({ db, config, store, bus, runDefinitions });
    const check = results.find((r) => r.name === "runs.kinds_known");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("backup");
    // Degrading: it is reported, and boot goes on — the operator keeps every screen.
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
  });

  // The counter-probe of run-definitions.total: HALF a family — some of its run kinds wired, some missing — is
  // the partial-wiring bug the check exists to catch, and it must ABORT boot rather than be noted.
  // Removing one definition from an otherwise wired family is that state exactly.
  it("run-definitions.total is RED when a wired family is missing one of its kinds, and that fails boot", () => {
    const { db, store, bus, runDefinitions } = fresh();
    runDefinitions.delete("tenant-create");
    const results = runSelfChecks({ db, config, store, bus, runDefinitions });
    const check = results.find((r) => r.name === "run-definitions.total");
    expect(check?.kind).toBe("blocking");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("tenant");
    expect(check?.detail).toContain("tenant-create");
    expect(() => assertBlockingChecksPass(results)).toThrow(/run-definitions\.total/);
  });

  // The second counter-probe: a literal belonging to NO family — the definition-less run kind that has no
  // family to be half of. RUN_KIND is `as const`, so such a literal cannot be added in TypeScript; the
  // probe appends to the runtime array and restores it, which is the state that build would ship.
  it("run-definitions.total is RED when a RUN_KIND literal belongs to no family, and that fails boot", () => {
    const { db, store, bus, runDefinitions } = fresh();
    const kinds = RUN_KIND as unknown as string[];
    kinds.push("ghost-kind");
    try {
      const results = runSelfChecks({ db, config, store, bus, runDefinitions });
      const check = results.find((r) => r.name === "run-definitions.total");
      expect(check?.kind).toBe("blocking");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("ghost-kind");
      expect(() => assertBlockingChecksPass(results)).toThrow(/run-definitions\.total/);
    } finally {
      kinds.pop();
    }
  });

  it("groups every RUN_KIND literal into exactly one family, and a wired boot registers them all", () => {
    const claimed: RunKind[] = [];
    for (const family of Object.keys(RUN_FAMILY) as RunFamily[]) claimed.push(...RUN_FAMILY[family]);
    // Equal as MULTISETS: every literal is claimed, and none is claimed twice.
    expect(claimed.sort()).toEqual([...RUN_KIND].sort());
    const { runDefinitions } = fresh();
    expect([...RUN_KIND].filter((kind) => !runDefinitions.has(kind))).toEqual([]);
    // ...and every registered definition answers to the kind it is filed under, so a def registered
    // twice under the wrong key could not make the check pass on a run kind nothing implements.
    for (const kind of RUN_KIND) expect((runDefinitions.get(kind) as AnyRunDefinition).kind).toBe(kind);
  });

  // The release grammar this Manager enforces (shared/release.ts RELEASE_TAG_RE) against the build
  // plane's copy of it (global.releaseTagFilter, clusters/platform/values-common.yaml on the platform repo's
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
  // exists to find, and the decision it embodies is that boot goes ON — a Manager with a stale or
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
  // platform repo (the wiring's own optional — a Manager with onboarding off) there is no second
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

  // CAN THIS MANAGER STILL FIND THE VERSION IT PLACES ON A MACHINE? The pin's path is the platform
  // repository's to choose, and when it moved under clusters/ nothing here noticed — the pin's own
  // fixture seeded whatever the reader read, and the first thing that failed was a slave's engine
  // placement, on the machine, mid-run. This check asks at boot instead.
  //
  // THE PATH IS A LITERAL HERE, never the constant under test: seeding from ANSIWISE_PIN_PATH is
  // exactly what let the drift through, so this fixture states where the platform repository really
  // carries the file (measured in simetrixch/hostyour-cloud, 2026-08-26).
  const PIN_FILE = "clusters/platform/versions.yaml";
  const PINNED = 'cliTools:\n  ansiwise:\n    version: "0.4.2"\n  yq:\n    version: "v4.53.3"\n';
  const platformRepoPinning = (path: string, text: string): FakePlatformRepo => {
    const repo = new FakePlatformRepo();
    repo.seed(PRODUCT_BRANCH, path, text);
    return repo;
  };

  it("ansiwise.pin_readable is GREEN when the trunk carries the pin, and says which version it read", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config, platformRepo: platformRepoPinning(PIN_FILE, PINNED) });
    const check = results.find((r) => r.name === "ansiwise.pin_readable");
    expect(check?.kind).toBe("degrading");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("0.4.2");
    expect(readinessOf(results).checks).toContainEqual({ name: "ansiwise.pin_readable", ok: true });
  });

  // THE COUNTER-PROBE, and it is this ticket's own defect: the file where this Manager looked before
  // the rename. Boot goes ON — a Manager that cannot place a binary right now still serves every
  // cluster, consumer and tenant that has nothing to do with placing one — but /readyz carries the
  // red line and the detail names the file and the branch, which is what a reader has to act on.
  it("ansiwise.pin_readable is RED when the trunk carries the file at the OLD path, and does NOT fail boot", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config, platformRepo: platformRepoPinning("platform/versions.yaml", PINNED) });
    const check = results.find((r) => r.name === "ansiwise.pin_readable");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(PIN_FILE);
    expect(check?.detail).toContain(PRODUCT_BRANCH);
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
    expect(readinessOf(results).ok).toBe(true);
    expect(readinessOf(results).checks).toContainEqual({ name: "ansiwise.pin_readable", ok: false });
  });

  it("ansiwise.pin_readable is RED when the file is there and states no version for the binary", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config, platformRepo: platformRepoPinning(PIN_FILE, 'cliTools:\n  yq:\n    version: "v4.53.3"\n') });
    const check = results.find((r) => r.name === "ansiwise.pin_readable");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("cliTools.ansiwise.version");
  });

  it("ansiwise.pin_readable SKIPS without a platform repo instead of reporting a pass", async () => {
    const { db } = fresh();
    const results = await runAsyncSelfChecks({ db, config });
    const check = results.find((r) => r.name === "ansiwise.pin_readable");
    expect(check?.kind).toBe("skipped");
    expect(check?.ok).toBe(false);
    expect(readinessOf(results).checks.map((c) => c.name)).not.toContain("ansiwise.pin_readable");
  });

  // THE PLATFORM'S DECLARATION OF THE PROGRAM ORDER, held against the order this manager really
  // drives. The declaration had no reader at all, and a declaration nothing consumes looks exactly
  // like one that is obeyed — three of its own sentences were false for days before a person noticed.
  //
  // The stated order is a LITERAL here, taken off the platform repository's own file, never composed
  // from what the run happens to do: a fixture derived from the subject cannot disagree with it.
  const STATED_MASTER = ["deploy-host", "deploy-branch", "deploy-cluster", "deploy-platform-services", "onboard-manager"];
  const declaring = (programs: readonly string[]): FakePlatformRepo => {
    const repo = new FakePlatformRepo();
    repo.seed(PRODUCT_BRANCH, INSTALL_ORDER_PATH, ["sequence:", "  master:", ...programs.map((p) => `    - program: ${p}`), ""].join("\n"));
    return repo;
  };

  /** EVERY run kind this manager registers that drives one of the machine's programs, as a LITERAL —
   *  the check derives its own list from the definitions, so a list composed the same way could not
   *  disagree with it. Measured 2026-08-27 against the definitions a fully wired boot builds. */
  const KINDS_DRIVING_PROGRAMS = [
    "cluster-deploy-slave", "cluster-redeploy", "cluster-release",
    "cluster-tailnet-disconnect", "cluster-tailnet-reconnect",
  ];

  it("install-order.agrees is GREEN against the platform's stated order, and names every run kind it held", async () => {
    const { db, runDefinitions } = fresh();
    const results = await runAsyncSelfChecks({ db, config, runDefinitions, platformRepo: declaring(STATED_MASTER) });
    const check = results.find((r) => r.name === "install-order.agrees");
    expect(check?.kind).toBe("degrading");
    expect(check?.ok).toBe(true);
    // How much it covered, not only that it found nothing. Two things make a clean answer worth
    // something: every run kind that drives a program is named, so one that stops being held is
    // visible as an absence, and a program the declaration does not state is named too — the
    // declaration states no slave sequence on purpose, so the master-side branch cut is one of them.
    for (const kind of KINDS_DRIVING_PROGRAMS) expect(check?.detail, kind).toContain(kind);
    expect(check?.detail).toContain("deploy-slave-branch");
  });

  // THE COUNTER-PROBE: the declaration edited and the manager not. Two of the programs the slave run
  // drives swap places in the stated order, and the check must name which after which — both orders
  // in the message, because either side can be the wrong one.
  it("install-order.agrees is RED when the stated order and the driven order disagree, and does NOT fail boot", async () => {
    const { db, runDefinitions } = fresh();
    const swapped = ["deploy-host", "deploy-branch", "deploy-platform-services", "deploy-cluster", "onboard-manager"];
    const results = await runAsyncSelfChecks({ db, config, runDefinitions, platformRepo: declaring(swapped) });
    const check = results.find((r) => r.name === "install-order.agrees");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("deploy-platform-services after deploy-cluster");
    expect(check?.detail).toContain(swapped.join(" -> "));
    expect(() => assertBlockingChecksPass(results)).not.toThrow();
    expect(readinessOf(results).checks).toContainEqual({ name: "install-order.agrees", ok: false });
  });

  // THE COUNTER-PROBE FOR THE RUN KINDS THE SLAVE INSTALL DOES NOT COVER, and the reason this check
  // holds all of them: `regenerate-branch` is a program only `cluster-release` drives, so a
  // declaration stating it AFTER the two machine-layer programs is a disagreement no reading of the
  // slave install could ever see. The slave install stays green here — that is the point of the case.
  it("install-order.agrees is RED for cluster-release alone when the declaration states its regeneration last", async () => {
    const { db, runDefinitions } = fresh();
    const lateRegeneration = [...STATED_MASTER, "regenerate-branch"];
    const results = await runAsyncSelfChecks({ db, config, runDefinitions, platformRepo: declaring(lateRegeneration) });
    const check = results.find((r) => r.name === "install-order.agrees");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("cluster-release: this run drives deploy-cluster after regenerate-branch");
    // The run kind the old check held is green on this declaration, so a check that still read only
    // that one would report a pass here.
    expect(check?.detail).not.toContain("cluster-deploy-slave: this run drives");
  });

  // THE INNOCENT NEIGHBOUR to the case above: the same program stated where the release really drives
  // it — before the machine layer — and every run kind agrees. Without this, the red above could mean
  // the check simply goes red on any declaration that names `regenerate-branch` at all.
  it("install-order.agrees is GREEN when the declaration states the regeneration where the release drives it", async () => {
    const { db, runDefinitions } = fresh();
    const early = ["deploy-host", "regenerate-branch", "deploy-branch", "deploy-cluster", "deploy-platform-services", "onboard-manager"];
    const results = await runAsyncSelfChecks({ db, config, runDefinitions, platformRepo: declaring(early) });
    const check = results.find((r) => r.name === "install-order.agrees");
    expect(check?.ok).toBe(true);
    // Held rather than skipped past: the release's regeneration is one of the programs it measured.
    expect(check?.detail).toContain("cluster-release 3/3");
  });

  it("install-order.agrees is RED when the trunk carries no such declaration at all", async () => {
    const { db, runDefinitions } = fresh();
    const results = await runAsyncSelfChecks({ db, config, runDefinitions, platformRepo: new FakePlatformRepo() });
    const check = results.find((r) => r.name === "install-order.agrees");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(INSTALL_ORDER_PATH);
  });

  it("install-order.agrees SKIPS without a platform repo instead of reporting a pass", async () => {
    const { db, runDefinitions } = fresh();
    const results = await runAsyncSelfChecks({ db, config, runDefinitions });
    const check = results.find((r) => r.name === "install-order.agrees");
    expect(check?.kind).toBe("skipped");
    expect(readinessOf(results).checks.map((c) => c.name)).not.toContain("install-order.agrees");
  });

  it("the append-only probe leaves no sentinel row behind (rolled back)", () => {
    const { db, store, bus, runDefinitions } = fresh();
    runSelfChecks({ db, config, store, bus, runDefinitions });
    const count = db.sqlite.prepare("SELECT count(*) AS n FROM audit").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
