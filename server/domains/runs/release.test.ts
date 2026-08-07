import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { RELEASE_TAG_RE, parseReleaseTag } from "../../../shared/release.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import {
  makeHarness, disposeHarnesses, stepColumn, PARAMS, SLAVE_ID, MASTER_ID, SLAVE_MARKING_YAML,
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

describe("release — the cluster release verb", () => {
  it("plans four steps and starts with attest-target, so the ceiling is checked before anything is written", async () => {
    const { executor } = await liveSlave();
    const { plan } = await executor.plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "set-pin", "host-run", "argocd-follow"]);
    expect(plan.targetKind).toBe("cluster");
    expect(plan.summary).toContain("1.0.0-stable");
  });

  it("pins the cluster map, runs the installer over SSH and follows ArgoCD — always all three", async () => {
    const h = await liveSlave();
    const r = await h.executor.plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" });
    await h.executor.approve(r.runId);
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // (1) the pin — the ONE declarative place, in the release grammar, on the trunk.
    const map = markingOf(h, PARAMS.domain);
    const pinned = /^release: (.+)$/m.exec(map)?.[1] ?? "";
    expect(pinned).toMatch(RELEASE_TAG_RE);
    expect(parseReleaseTag(pinned)).toMatchObject({ version: "1.0.0", channel: "stable" });
    expect(h.platformRepo.tags.has(pinned)).toBe(true);
    // The map's identity fields survive the pin write — a release states a version, nothing else.
    // Plain scalars, the shape install.sh write_map emits: the other writer of this file, so a map's
    // first release shows ONE changed line rather than every line re-quoted.
    expect(map).toContain(`fqdn: ${PARAMS.domain}`);
    expect(map).toContain("apiHost: 100.64.0.11");

    // (2) the host run — the installer, on the cluster's OWN host, after its checkout was refreshed.
    const onSlave = h.hosts.log.filter((l) => l.host === "10.1.1.11").map((l) => l.command);
    expect(onSlave.some((c) => c.includes("dc-refresh-checkout-"))).toBe(true);
    expect(onSlave.some((c) => c.includes("./setup.sh --prod"))).toBe(true);
    // ...and the branch regeneration on the MASTER, which is the host whose checkout can push.
    const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
    expect(onMaster.some((c) => c.includes("dc-regenerate-install-branch-"))).toBe(true);

    // (3) the follow — a pure slave's Applications live in the per-slave instance on the master.
    const events = JSON.stringify(readEvents(h.db.db, r.runId));
    expect(events).toContain("applications in ns s1 on m1 are Synced + Healthy");
  });

  it("refuses a channel the cluster's stage is above — BEFORE the pin, naming channel, stage and the allowed list", async () => {
    const h = await liveSlave(); // marked prod
    const r = await h.executor.plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "alpha" });
    await h.executor.approve(r.runId);
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("failed");

    const err = stepColumn(h.db, r.runId, "attest-target", "error") ?? "";
    expect(err).toContain("alpha");
    expect(err).toContain("prod");
    expect(err).toContain("dev"); // the stages alpha DOES reach
    // Nothing was written: no tag minted, no pin committed, and set-pin never even started.
    expect(h.platformRepo.tags.size).toBe(0);
    expect(markingOf(h, PARAMS.domain)).toBe(SLAVE_MARKING_YAML);
    expect(h.platformRepo.commits).toHaveLength(0);
  });

  it("mints once: a re-run of the same version and channel reuses the tag the map already names", async () => {
    const h = await liveSlave();
    const first = await h.executor.plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" });
    await h.executor.approve(first.runId);
    await h.executor.settle(first.runId);
    const tag = /^release: (.+)$/m.exec(markingOf(h, PARAMS.domain))?.[1];

    const second = await h.executor.plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" });
    await h.executor.approve(second.runId);
    await h.executor.settle(second.runId);
    expect(getRun(h.db.db, second.runId)?.status).toBe("succeeded");
    // One tag for one release: the second run adopted the standing one instead of stamping a new ts14
    // and leaving the first orphaned, and the map still names exactly it.
    expect([...h.platformRepo.tags.keys()]).toEqual([tag]);
    expect(/^release: (.+)$/m.exec(markingOf(h, PARAMS.domain))?.[1]).toBe(tag);
    expect(JSON.stringify(readEvents(h.db.db, second.runId))).toContain("reused, never re-pointed");
  });

  it("refuses a server whose cluster is not live — there is no running platform to raise", async () => {
    const h = await makeHarness({ keystore: "keyfile" });
    h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, CHANNEL_TABLE);
    const err = await h.executor.plan("release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/carries no cluster/);
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
