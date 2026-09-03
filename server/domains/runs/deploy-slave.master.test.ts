import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { masterTakingSlavePart, MASTER_AND_SLAVE_ROLE } from "./defs/deploy-slave.master.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { MASTER_ID, SLAVE_ID, makeHarness, disposeHarnesses, type Harness } from "./deploy-slave.fixture.ts";

// THE MASTER ARM of cluster-deploy-slave — the machine that carries the master part taking the slave
// part as well. It is a different act from the other arm and the plan is where a person meets that
// difference: one host instead of two, the machine's OWN branch regenerated under the combined role
// instead of a branch cut for a new machine, and not one compensating action armed.
//
// WHAT THE CARD SAYS IS ASSERTED HERE AND NOT ONLY THAT THE STEPS COMPOSE, because the summary is
// the whole of what the approve screen renders about a run (RunView carries a summary and no
// warnings): a person types the password of the machine this manager itself runs on into that
// screen, and what they are told the run does is these sentences.
//
// AND THE TWO REFUSALS, which say where the act cannot hold: a machine that is not this manager's
// own master, and a master that carries the slave part already.

const MASTER_DOMAIN = "m1.example.com";
const MASTER_PARAMS = { serverId: MASTER_ID, stage: "prod", domain: MASTER_DOMAIN };

/** A harness whose master keeps the LIVE cluster its platform runs from — the row the slave part is
 *  added to, and the one the arm refuses without. */
async function masterWithLiveCluster(): Promise<Harness> {
  const h = await makeHarness();
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: MASTER_DOMAIN,
    status: "active", tier: "rehearsal", planeState: "ready",
  }).run();
  return h;
}

describe("cluster-deploy-slave, master arm — the plan, what it says, and where it refuses", () => {
  afterEach(disposeHarnesses);

  it("plans ONE host and ONE cluster: first contact, the regeneration under the combined role, and the machine layer", async () => {
    const h = await masterWithLiveCluster();
    const { plan } = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS);
    expect(plan.steps.map((s) => s.name)).toEqual([
      "attest-target",
      "prove-elevation", "generate-key", "install-key", "verify-key-login", "remove-sudoers",
      "place-ansiwise", "run-regenerate-branch", "project-marking",
      "run-deploy-host", "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
    ]);
    // The machine IS the master, so there is no master-side half and no per-slave Vault surgery for
    // another run to interleave with — one owned target, and no master-vault lock.
    expect(plan.targets).toEqual([{ serverId: MASTER_ID, ownsHost: true, label: "m1 (master)" }]);
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: MASTER_DOMAIN },
      { resource: "master-kube", key: "m" },
    ]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
  });

  it("says on the approve card that it regenerates the master's OWN branch, builds no second cluster and no plane, and arms nothing", async () => {
    // THE THREE THINGS A PERSON MUST NOT READ AS THE OTHER ARM. Deploying a slave writes a second
    // cluster row, allocates an ordinal, builds that slave a management plane and arms compensations
    // that put the machine back; this run does none of it, on the host this manager runs from.
    const h = await masterWithLiveCluster();
    const { plan } = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS);
    expect(plan.summary).toContain("already carries the master part");
    expect(plan.summary).toContain(`branch ${MASTER_DOMAIN} is regenerated under role ${MASTER_AND_SLAVE_ROLE}`);
    expect(plan.summary).toContain("no ordinal is allocated");
    expect(plan.summary).toContain("no second cluster row is written");
    expect(plan.summary).toContain("no per-slave management plane is built");
    expect(plan.summary).toContain("NOT ONE COMPENSATING ACTION IS ARMED");
    expect(plan.summary).toContain("an abort leaves the machine as the last completed step left it");
    expect(plan.summary).toContain("the way back is running this run again");
  });

  it("refuses a master that already carries the slave part, and names what rebuilds its machine layer", async () => {
    const h = await masterWithLiveCluster();
    h.db.db.update(servers).set({ role: MASTER_AND_SLAVE_ROLE }).where(eq(servers.id, MASTER_ID)).run();
    const err = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain(`already stands at role ${MASTER_AND_SLAVE_ROLE}`);
    expect((err as AppError).message).toContain("cluster-redeploy");
  });

  it("still composes its own steps for a machine at the combined role, so a run that stopped part way is finished by running it again", async () => {
    // The refusal above is the PLAN's and never the steps': `project-marking` moves the row onto the
    // combined role part way through, so a run that then failed in the machine layer would be
    // unfinishable if the step list refused what the plan does.
    const h = await masterWithLiveCluster();
    h.db.db.update(servers).set({ role: MASTER_AND_SLAVE_ROLE }).where(eq(servers.id, MASTER_ID)).run();
    const def = buildRunDefinitions(h.runPorts).get("cluster-deploy-slave") as AnyRunDefinition;
    expect(def.steps({ ...MASTER_PARAMS, tier: "rehearsal" }).map((s) => s.name))
      .toContain("run-regenerate-branch");
  });

  it("refuses a machine that is not this manager's own master", async () => {
    // `servers_one_master_uq` admits one row carrying a master part, and every master-side act of
    // every run kind resolves that row through loadMaster — so the arm asks the same equality rather
    // than trusting the role column of whichever row it was handed.
    const h = await masterWithLiveCluster();
    expect(() => masterTakingSlavePart(h.db.db, SLAVE_ID)).toThrow(/master part of this installation is carried by m1/);
  });

  it("refuses a master with no cluster of its own, and one whose cluster is not live", async () => {
    // The slave part is added to the cluster the master already keeps, so there has to be one and it
    // has to be the live one its platform runs from.
    const h = await makeHarness();
    const none = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS).catch((e: unknown) => e);
    expect((none as AppError).message).toContain("records no cluster for it");

    h.db.db.insert(clusters).values({
      id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: MASTER_DOMAIN, status: "planned", tier: "rehearsal",
    }).run();
    const notLive = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS).catch((e: unknown) => e);
    expect((notLive as AppError).message).toContain("takes the slave part on its own LIVE cluster");
  });

  it("refuses a domain or a stage that is not the master's own, because one machine keeps one cluster", async () => {
    const h = await masterWithLiveCluster();
    const otherDomain = await h.executor.plan("cluster-deploy-slave", { ...MASTER_PARAMS, domain: "s9.example.com" })
      .catch((e: unknown) => e);
    expect((otherDomain as AppError).message).toContain("a second domain needs a machine of its own");
    const otherStage = await h.executor.plan("cluster-deploy-slave", { ...MASTER_PARAMS, stage: "test" })
      .catch((e: unknown) => e);
    expect((otherStage as AppError).message).toContain("a cluster carries one stage");
  });
});
