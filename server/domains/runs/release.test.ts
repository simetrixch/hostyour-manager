import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { buildRegistry } from "./registry.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { markingAnswers } from "./defs/release.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { activeClusterTarget } from "./defs/deploy-slave.kit.ts";
import { getRun } from "../../executor/read.ts";
import {
  makeHarness, disposeHarnesses, bareStepCtx, PARAMS, SLAVE_ID, MASTER_ID,
  SLAVE_MARKING_YAML, MASTER_MARKING_YAML,
} from "./deploy-slave.fixture.ts";
import type { Harness } from "./deploy-slave.fixture.ts";

// The cluster release, at the fake-repo level: what the verb PLANS, what set-pin writes, which
// answers the manager reads off the cluster map, and the two refusals that stop a release before it
// touches a machine — the wrong role and the channel ceiling. What the verb does ON the machine —
// the three programs over the real `ansiwise serve` — is proven in redeploy.ansiwise.test.ts,
// the one file every machine-run suite shares (the engine's run root is per-drive).
//
// The channel ceiling is read from the platform repo's ONE table, so the fake repo carries that file
// verbatim: a test that seeded a controller-side copy instead would prove the opposite of the rule.

const CHANNEL_TABLE = [
  "global:",
  "  channelStages:",
  "    alpha: [dev]",
  "    beta: [dev, test]",
  "    stable: [dev, test, prod]",
].join("\n") + "\n";

const RELEASE_STEPS = [
  "attest-target", "set-pin", "refresh-checkout",
  "run-regenerate-branch", "run-deploy-cluster", "run-deploy-gitops", "argocd-follow",
];

const BUILD_PLANE_PATS = [
  "activation-input:build_hostyour_cloud_repo_pat",
  "activation-input:build_hostyour_manager_repo_pat",
  "activation-input:build_catalog_repo_pat",
];

afterEach(disposeHarnesses);

/** A harness whose slave cluster is already ACTIVE — the state the refusal test aims a release at. */
async function liveSlave(): Promise<Harness> {
  const h = await makeHarness({ keystore: "keyfile" });
  h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, CHANNEL_TABLE);
  h.db.db.insert(clusters).values({
    id: "cls_live", serverId: SLAVE_ID, stage: PARAMS.stage as "prod", domain: PARAMS.domain,
    status: "active", tier: "rehearsal", slaveId: 1, planeState: "ready",
  }).run();
  h.db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
  return h;
}

/** A harness whose MASTER carries an ACTIVE cluster — the one shape a release plans against.
 *  MASTER_MARKING_YAML names the master as its own build plane, exactly like a real one-master
 *  installation; a test about the other case seeds a different marking over it. */
async function liveMaster(over: { marking?: string } = {}): Promise<Harness> {
  const h = await makeHarness({ keystore: "keyfile", ansiwiseServeCommand: "ansiwise serve" });
  h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, CHANNEL_TABLE);
  if (over.marking) h.platformRepo.seed(h.platformRepo.booksBranch, clusterMarkingPath("m1.example.com"), over.marking);
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com",
    status: "active", tier: "rehearsal", planeState: "ready",
  }).run();
  return h;
}

const markingOf = (h: Harness, fqdn: string): string =>
  h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath(fqdn)) ?? "";

const MASTER_RELEASE = { serverId: MASTER_ID, version: "1.0.0", channel: "stable" as const };

describe("release — plan", () => {
  it("composes attest → set-pin → refresh-checkout → the three programs → argocd-follow, and asks for the password, the build-plane PATs and the answers nobody records", async () => {
    const h = await liveMaster();
    const { plan } = await h.executor.plan("release", MASTER_RELEASE);
    expect(plan.steps.map((s) => s.name)).toEqual(RELEASE_STEPS);
    // The master's own map names it as its build plane, so the three stated_when credentials of
    // regenerate-branch are demanded at approve — the same demand the machine's validation makes.
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET, ...BUILD_PLANE_PATS]);
    expect(plan.requiredInputs?.map((i) => i.field)).toEqual(
      ["committer_email", "letsencrypt_email", "letsencrypt_server", "lan_cidr", "storage_path", "storage_directory"],
    );
    // The trunk (the tag), the master's install branch (pin commit + regeneration — for a master
    // that branch IS the books branch), and the master's ArgoCD (the follow).
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: PRODUCT_BRANCH },
      { resource: "git-branch", key: "m1.example.com" },
      { resource: "master-kube", key: "m" },
    ]);
  });

  it("a master whose map names ANOTHER cluster as build plane is not asked for the build PATs", async () => {
    const h = await liveMaster({
      marking: MASTER_MARKING_YAML.replace("build-plane: m1.example.com", "build-plane: b1.example.com"),
    });
    const { plan } = await h.executor.plan("release", MASTER_RELEASE);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
  });

  it("REFUSES a slave at plan time — the books and the pin live on the master's branch, and nothing regenerates a slave's branch at a pin", async () => {
    const h = await liveSlave();
    const err = await h.executor
      .plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    const message = (err as AppError).message;
    expect(message).toContain("books");              // why the shape does not hold
    expect(message).toContain("deploy-slave-branch"); // the program whose shape the missing regenerator has
    expect(message).toContain("redeploy");            // what a slave CAN have meanwhile

    // Nothing was planned and nothing was touched: no run row, no tag, no commit on the books branch.
    expect((h.db.sqlite.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
    expect(h.platformRepo.tags.size).toBe(0);
    expect(h.platformRepo.commits).toHaveLength(0);
    expect(markingOf(h, PARAMS.domain)).toBe(SLAVE_MARKING_YAML);

    // Counter-probe: the same harness, the same live slave, still plans a REDEPLOY. So the refusal
    // above is this verb's own reading of the role and not a planner that refuses everything.
    const ok = await h.executor.plan("redeploy", { serverId: SLAVE_ID });
    expect(ok.plan.steps.map((s) => s.name)).toEqual(["attest-target", "slave-preflight", "prepare-branch",
      "mint-join-key", "install-microk8s", "create-mgmt", "gitops-handoff", "verify-slave", "register"]);
  });
});

describe("release — set-pin and the map-sourced answers", () => {
  const setPinOf = (h: Harness): ReturnType<AnyRunDefinition["steps"]>[number] | undefined => {
    const def = buildRegistry({ db: h.db.db, platformRepo: h.platformRepo }).get("release") as AnyRunDefinition;
    return def.steps(MASTER_RELEASE).find((s) => s.name === "set-pin");
  };

  it("set-pin mints the tag on the TRUNK, states the pin in the cluster map, and a re-run adopts its own tag instead of minting a second one", async () => {
    const h = await liveMaster();
    const setPin = setPinOf(h);
    await setPin?.run(bareStepCtx(h.db, h.store));

    expect(h.platformRepo.tags.size).toBe(1);
    const tag = [...h.platformRepo.tags.keys()][0] ?? "";
    expect(tag).toMatch(/^1\.0\.0-stable-\d{14}$/);
    expect(markingOf(h, "m1.example.com")).toContain(`release: ${tag}`);
    // The pin commit landed on the books branch; the tag was minted on the trunk (the fake records
    // the branch a commit was taken on, and mintTag ran under a PRODUCT_BRANCH turn).
    expect(h.platformRepo.commits.map((c) => c.branch)).toEqual([h.platformRepo.booksBranch]);
    // It never reached a host: the pin is the manager's own git act, the machine's turn comes later.
    expect(h.hosts.log).toHaveLength(0);

    const commitsBefore = h.platformRepo.commits.length;
    await setPin?.run(bareStepCtx(h.db, h.store));
    expect(h.platformRepo.tags.size).toBe(1); // mint-once: the standing tag is adopted, never re-pointed
    expect(h.platformRepo.commits).toHaveLength(commitsBefore); // the map already states it — nothing to commit
  });

  it("PLANTED DEFECT: a channel that may not reach the cluster's stage fails at attest-target — no tag is minted, no pin is written", async () => {
    const h = await liveMaster();
    const r = await h.executor.plan("release", { serverId: MASTER_ID, version: "1.0.0", channel: "alpha" });
    await h.executor.approve(r.runId, {
      [ANSIWISE_ELEVATION_SECRET]: Buffer.from("root-pw"),
      ...Object.fromEntries(BUILD_PLANE_PATS.map((name) => [name, Buffer.from("github_pat_x")])),
    });
    await h.executor.settle(r.runId);

    expect(getRun(h.db.db, r.runId)?.status).toBe("failed");
    expect(h.platformRepo.tags.size).toBe(0);
    expect(markingOf(h, "m1.example.com")).toBe(MASTER_MARKING_YAML);
  });

  it("markingAnswers reads off the cluster map exactly what the programs declare: the build plane by name, the apex, the recipients as the LIST the program takes", async () => {
    const h = await liveMaster();
    const answers = await markingAnswers(activeClusterTarget(MASTER_ID), { platformRepo: h.platformRepo })(bareStepCtx(h.db, h.store));
    expect(answers).toEqual({
      build_plane: "m1.example.com",
      unit_apex: "example.com",
      platform_domain: "example.com",
      alert_recipients: ["ops@example.com"],
      catalog_repo: "acme/acme-catalog",
      // no post_url: the map states none, and an absent optional field rides nowhere — the machine's
      // own default (or refusal, by name) decides, never a value invented here.
    });
  });

  it("markingAnswers splits a multi-mailbox recipients list on the map's own comma grammar", async () => {
    const h = await liveMaster({
      marking: MASTER_MARKING_YAML.replace("alert-recipients: ops@example.com", "alert-recipients: ops@example.com, oncall@example.com"),
    });
    const answers = await markingAnswers(activeClusterTarget(MASTER_ID), { platformRepo: h.platformRepo })(bareStepCtx(h.db, h.store));
    expect(answers.alert_recipients).toEqual(["ops@example.com", "oncall@example.com"]);
  });
});
