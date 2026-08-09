import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { AppError } from "../../kernel/errors.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import { buildRegistry } from "./registry.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import {
  makeHarness, disposeHarnesses, bareStepCtx, PARAMS, SLAVE_ID, MASTER_ID, SLAVE_MARKING_YAML,
} from "./deploy-slave.fixture.ts";
import type { Harness } from "./deploy-slave.fixture.ts";

// The cluster release and the master arm of redeploy. Both act on a cluster that is already
// LIVE, so every test here starts from an active cluster row rather than from a deploy-slave run —
// what is under test is what the two verbs do to a running cluster, not how it got there.
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

const MASTER_MARKING_YAML = [
  "fqdn: m1.example.com",
  "stage: prod",
  "role: master+slave",
  "build-plane: m1.example.com",
].join("\n") + "\n";

afterEach(disposeHarnesses);

/** A harness whose slave cluster is already ACTIVE — the state both verbs act on. */
async function liveSlave(over: { stage?: "dev" | "test" | "prod"; marking?: string } = {}): Promise<Harness> {
  const h = await makeHarness({ keystore: "keyfile" });
  h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, CHANNEL_TABLE);
  if (over.marking) h.platformRepo.seed(h.platformRepo.booksBranch, clusterMarkingPath(PARAMS.domain), over.marking);
  h.db.db.insert(clusters).values({
    id: "cls_live", serverId: SLAVE_ID, stage: over.stage ?? "prod", domain: PARAMS.domain,
    status: "active", tier: "rehearsal", slaveId: 1, planeState: "ready",
  }).run();
  h.db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
  return h;
}

/** The same, for the cluster that carries the MASTER part — redeploy must hold for every role, not
 *  only for a slave. */
async function liveMaster(): Promise<Harness> {
  const h = await makeHarness({ keystore: "keyfile" });
  h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, CHANNEL_TABLE);
  h.platformRepo.seed(h.platformRepo.booksBranch, clusterMarkingPath("m1.example.com"), MASTER_MARKING_YAML);
  h.db.db.update(servers).set({ role: "master+slave" }).where(eq(servers.id, MASTER_ID)).run();
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com",
    status: "active", tier: "rehearsal", planeState: "ready",
  }).run();
  return h;
}

const markingOf = (h: Harness, fqdn: string): string =>
  h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath(fqdn)) ?? "";

describe("release — refused while nothing regenerates an install branch", () => {
  // A release moves a cluster onto a platform version by regenerating that cluster's install branch
  // from the pinned tag on the master. Nothing performs that regeneration: the shell that did it is in
  // no repository and its ansiwise replacement is unbuilt. The two steps AFTER set-pin read the branch
  // that act produces — host-run runs the installer out of the cluster's checkout of it, argocd-follow
  // calls Synced against it "the pinned state" — so a release without the regeneration would report a
  // version the cluster never took. The refusal therefore lands at PLAN time, before a run row exists.

  it("refuses at plan time, naming the missing script, its replacement and the verb to use instead", async () => {
    const h = await liveSlave();
    const err = await h.executor
      .plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PLAN_REFUSED");
    const message = (err as AppError).message;
    expect(message).toContain("tools/ops/sync-install-branch.sh"); // what is missing, by name
    expect(message).toContain("ansiwise");                         // what replaces it
    expect(message).toContain("redeploy");                         // what to reach for meanwhile

    // Nothing was planned and nothing was touched: no run row, no tag, no commit on the books branch.
    expect((h.db.sqlite.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
    expect(h.platformRepo.tags.size).toBe(0);
    expect(h.platformRepo.commits).toHaveLength(0);
    expect(markingOf(h, PARAMS.domain)).toBe(SLAVE_MARKING_YAML);

    // Counter-probe: the same harness, the same live cluster, still plans a REDEPLOY. So the refusal
    // above is this verb's own and not a planner that refuses everything.
    const ok = await h.executor.plan("redeploy", { serverId: SLAVE_ID });
    expect(ok.plan.steps.map((s) => s.name)).toEqual(["attest-target", "slave-preflight", "prepare-branch",
      "mint-join-key", "install-microk8s", "create-mgmt", "gitops-handoff", "verify-slave", "register"]);
  });

  it("set-pin refuses where the regeneration stood, so lifting the plan gate cannot ship a silent half-release", async () => {
    // The plan gate is one line in KIND_GUARDS. If it is lifted before a regenerator exists, the run
    // must still stop AT the missing act rather than mint a tag, commit a pin, re-run the installer and
    // report the cluster on a release it never took.
    const h = await liveSlave();
    const def = buildRegistry({ db: h.db.db, platformRepo: h.platformRepo }).get("release") as AnyRunDefinition;
    const setPin = def.steps({ serverId: SLAVE_ID, version: "1.0.0", channel: "stable" }).find((s) => s.name === "set-pin");

    await expect(setPin?.run(bareStepCtx(h.db, h.store))).rejects.toThrow(/sync-install-branch\.sh/);
    // It never reached a host: the regeneration is the step's only remote leg.
    expect(h.hosts.log).toHaveLength(0);
  });
});

describe("redeploy — the master arm (the same composition holds for every role)", () => {
  it("composes host-run + argocd-follow on a master+slave, and moves no pin", async () => {
    const h = await liveMaster();
    const before = markingOf(h, "m1.example.com");

    const { plan } = await h.executor.plan("redeploy", { serverId: MASTER_ID });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "host-run", "argocd-follow"]);

    const r = await h.executor.plan("redeploy", { serverId: MASTER_ID });
    await h.executor.approve(r.runId);
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // The installer ran on the master itself, and the follow read the master's OWN argocd namespace —
    // a cluster carrying the master part operates its own ArgoCD instead of hanging off another's.
    const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
    expect(onMaster.some((c) => c.includes("./setup.sh --prod"))).toBe(true);
    expect(onMaster.some((c) => c.includes("-n argocd get applications.argoproj.io"))).toBe(true);
    expect(JSON.stringify(readEvents(h.db.db, r.runId))).toContain("applications in ns argocd on m1 are Synced + Healthy");

    // No pin was touched, nothing was committed, and the cluster stayed active throughout.
    expect(markingOf(h, "m1.example.com")).toBe(before);
    expect(h.platformRepo.commits).toHaveLength(0);
    expect(h.platformRepo.tags.size).toBe(0);
    expect(h.db.db.select().from(clusters).where(eq(clusters.id, "cls_master")).get()?.status).toBe("active");
  });
});
