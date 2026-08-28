import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { markingAnswers } from "./defs/release.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { activeClusterTarget } from "./defs/deploy-slave.kit.ts";
import { getRun } from "../../executor/read.ts";
import {
  makeHarness, disposeHarnesses, bareStepCtx, ELEVATION_PASSWORD, PARAMS, SLAVE_ID, MASTER_ID,
  SLAVE_MARKING_YAML, MASTER_MARKING_YAML, REDEPLOY_STEP_NAMES,
} from "./deploy-slave.fixture.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import type { Harness } from "./deploy-slave.fixture.ts";

// The cluster release, at the fake-repo level: what each of the two arms PLANS, what set-pin writes,
// which answers the manager reads off the cluster map, and the two refusals that stop a release
// before it touches a machine — the channel ceiling and a catalogue that cannot be read. What the run
// kind does ON the machine — the three programs over the real `ansiwise-rest serve` — is proven in
// redeploy.ansiwise.test.ts, the one file every machine-run suite shares (the engine's run root is
// per-drive).
//
// The channel ceiling is read from the platform repo's ONE table, so the fake repo carries that file
// verbatim: a test that seeded a manager-side copy instead would prove the opposite of the rule.

const CHANNEL_TABLE = [
  "global:",
  "  channelStages:",
  "    alpha: [dev]",
  "    beta: [dev, test]",
  "    stable: [dev, test, prod]",
].join("\n") + "\n";

const RELEASE_STEPS = [
  "attest-target", "require-programs", "set-pin", "refresh-checkout",
  "run-regenerate-branch", "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
];

/** The slave arm's list, and the three places it differs from the master's are the whole ticket: the
 *  regeneration is regenerate-slave-branch and runs on the MASTER; prepare-regeneration stands the
 *  master's two checkouts where refresh-checkout would have stood (that step opens the OWNED host,
 *  which here is the slave, and would leave the master's books tree unfetched); and the slave's own
 *  refresh-checkout moves to AFTER the regeneration, onto the branch head it just pushed. */
const SLAVE_RELEASE_STEPS = [
  "attest-target", "require-programs", "set-pin", "prepare-regeneration",
  "run-regenerate-slave-branch", "refresh-checkout",
  "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
];

const BUILD_PLANE_PATS = [
  "activation-input:build_hostyour_cloud_repo_pat",
  "activation-input:build_hostyour_manager_repo_pat",
  "activation-input:build_catalog_repo_pat",
];

afterEach(disposeHarnesses);

/** A harness whose slave cluster is already ACTIVE — the state the slave arm plans against. */
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
  const h = await makeHarness({ keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, CHANNEL_TABLE);
  if (over.marking) h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath("m1.example.com"), over.marking);
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com",
    status: "active", tier: "rehearsal", planeState: "ready",
  }).run();
  return h;
}

const markingOf = (h: Harness, fqdn: string): string =>
  h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(fqdn)) ?? "";

const MASTER_RELEASE = { serverId: MASTER_ID, version: "1.0.0", channel: "stable" as const };
const SLAVE_RELEASE = { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" as const };

describe("release — plan", () => {
  it("composes attest → require-programs → set-pin → refresh-checkout → the three programs → argocd-follow, and asks for the password, the build-plane PATs and the answers nobody records", async () => {
    const h = await liveMaster();
    const { plan } = await h.executor.plan("cluster-release", MASTER_RELEASE);
    expect(plan.steps.map((s) => s.name)).toEqual(RELEASE_STEPS);
    // The master's own map names it as its build plane, so the three stated_when credentials of
    // regenerate-branch are demanded at approve — the same demand the machine's validation makes.
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET, ...BUILD_PLANE_PATS]);
    expect(plan.requiredInputs?.map((i) => i.field)).toEqual(
      ["committer_email", "letsencrypt_email", "letsencrypt_server", "lan_cidr", "storage_mount", "storage_subdirectory"],
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
      marking: MASTER_MARKING_YAML.replace("  buildPlane: m1.example.com", "  buildPlane: b1.example.com"),
    });
    const { plan } = await h.executor.plan("cluster-release", MASTER_RELEASE);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
  });

  it("PLANS a slave over TWO hosts: the regeneration on the master (where the pin and the books stand), the machine layer on the slave, and no build-plane PATs", async () => {
    const h = await liveSlave();
    const { plan } = await h.executor.plan("cluster-release", SLAVE_RELEASE);

    expect(plan.steps.map((s) => s.name)).toEqual(SLAVE_RELEASE_STEPS);
    // The master is a declared AUX target — run-regenerate-slave-branch and prepare-regeneration both
    // open its session, and an undeclared aux session is what the executor refuses.
    expect(plan.targets).toEqual([
      { serverId: SLAVE_ID, ownsHost: true, label: "s1 (slave)" },
      { serverId: MASTER_ID, ownsHost: false, label: "m1 (master)" },
    ]);
    // Three branches, not two: the trunk carries the tag, the slave's own branch is what the merge
    // moves, and the BOOKS branch — the master's — is where the pin is committed and where the map
    // naming this slave stands. A master release states the last two as one key.
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: PRODUCT_BRANCH },
      { resource: "git-branch", key: PARAMS.domain },
      { resource: "git-branch", key: "m1.example.com" },
      { resource: "master-kube", key: "m" },
    ]);
    // regenerate-slave-branch declares no credential answer at all — a slave's secrets file is
    // nothing a branch program run on the master writes — so the elevation password is the whole ask.
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.requiredInputs?.map((i) => i.field)).toEqual(
      [],
    );
    // Planning writes nothing: the tag and the pin are set-pin's, three steps later.
    expect(h.platformRepo.tags.size).toBe(0);
    expect(markingOf(h, PARAMS.domain)).toBe(SLAVE_MARKING_YAML);

    // Counter-probe: the same live slave still plans a REDEPLOY, whose step list is a different one.
    // So the list above is this run kind's own reading of the role, not one shape for every plan.
    const ok = await h.executor.plan("cluster-redeploy", { serverId: SLAVE_ID });
    expect(ok.plan.steps.map((s) => s.name)).toEqual(REDEPLOY_STEP_NAMES);
  });
});

describe("release — set-pin and the map-sourced answers", () => {
  const setPinOf = (h: Harness): ReturnType<AnyRunDefinition["steps"]>[number] | undefined => {
    const def = buildRunDefinitions({ db: h.db.db, platformRepo: h.platformRepo }).get("cluster-release") as AnyRunDefinition;
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
    const r = await h.executor.plan("cluster-release", { serverId: MASTER_ID, version: "1.0.0", channel: "alpha" });
    await h.executor.approve(r.runId, {
      [ANSIWISE_ELEVATION_SECRET]: Buffer.from(ELEVATION_PASSWORD),
      ...Object.fromEntries(BUILD_PLANE_PATS.map((name) => [name, Buffer.from("github_pat_x")])),
    });
    await h.executor.settle(r.runId);

    expect(getRun(h.db.db, r.runId)?.status).toBe("failed");
    expect(h.platformRepo.tags.size).toBe(0);
    expect(markingOf(h, "m1.example.com")).toBe(MASTER_MARKING_YAML);
  });

  it("PLANTED DEFECT: the machine's catalogue cannot be read at all, and the run dies at require-programs — BEFORE the tag and BEFORE the pin", async () => {
    // THE ORDER IS WHAT IS UNDER PROOF. The scripted hosts hold no `ansiwise-rest serve` conversation, so
    // asking the machine what it carries fails — the same shape as a machine whose catalogue is older
    // than this manager and does not carry the regeneration program. Because that question is asked
    // BEFORE set-pin, the map is left saying nothing about a release the cluster never received; ask
    // it after, and the record contradicts the branch and only a person can repair it.
    const h = await liveMaster();
    const r = await h.executor.plan("cluster-release", MASTER_RELEASE);
    expect(r.plan.steps.map((s) => s.name).indexOf("require-programs"))
      .toBeLessThan(r.plan.steps.map((s) => s.name).indexOf("set-pin"));
    await h.executor.approve(r.runId, {
      [ANSIWISE_ELEVATION_SECRET]: Buffer.from(ELEVATION_PASSWORD),
      ...Object.fromEntries(BUILD_PLANE_PATS.map((name) => [name, Buffer.from("github_pat_x")])),
    });
    await h.executor.settle(r.runId);

    expect(getRun(h.db.db, r.runId)?.status).toBe("failed");
    expect(stepColumn(h.db, r.runId, "require-programs", "error")).toMatch(/ANSIWISE_SERVE_COMMAND|no conversation scripted/);
    // set-pin never ran: no tag on the trunk, not one commit on the books branch, and the map still
    // reads byte for byte as it did.
    expect(stepColumn(h.db, r.runId, "set-pin", "error")).toBeNull();
    expect(h.platformRepo.tags.size).toBe(0);
    expect(h.platformRepo.commits).toHaveLength(0);
    expect(markingOf(h, "m1.example.com")).toBe(MASTER_MARKING_YAML);
  });

  it("markingAnswers reads off the cluster map exactly what the programs declare: the build plane by name, the apex, the recipients as the LIST the program takes", async () => {
    const h = await liveMaster();
    const answers = await markingAnswers(activeClusterTarget(MASTER_ID), { platformRepo: h.platformRepo })(bareStepCtx(h.db, h.store));
    expect(answers).toEqual({
      build_plane_fqdn: "m1.example.com",
      unit_apex: "example.com",
      platform_domain: "example.com",
      alert_recipients: ["ops@example.com"],
      catalog_repo: "acme/acme-catalog",
      // no mail_url: the map states none, and an absent optional field rides nowhere — the machine's
      // own default (or refusal, by name) decides, never a value invented here.
    });
  });

  it("markingAnswers splits a multi-mailbox recipients list on the map's own comma grammar", async () => {
    const h = await liveMaster({
      marking: MASTER_MARKING_YAML.replace("  alertRecipients: ops@example.com", "  alertRecipients: ops@example.com, oncall@example.com"),
    });
    const answers = await markingAnswers(activeClusterTarget(MASTER_ID), { platformRepo: h.platformRepo })(bareStepCtx(h.db, h.store));
    expect(answers.alert_recipients).toEqual(["ops@example.com", "oncall@example.com"]);
  });
});
