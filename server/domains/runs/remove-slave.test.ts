import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { removeSlaveSteps, makeRemoveSlaveDef } from "./defs/remove-slave.ts";
import type { Step } from "../../executor/types.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, makeHarness, disposeHarnesses, hostedStepCtx, seedMasterCluster,
  type Harness,
} from "./deploy-slave.fixture.ts";

// TAKING A SLAVE OUT OF AN INSTALLATION — the run kind, driven step by step.
//
// The three shell files this replaces removed the slave from the master and told this manager
// nothing, so the cluster went on standing at `active` with a plane describing a Vault mount and an
// ArgoCD namespace that no longer existed. What the cases below hold is the two halves of that: the
// removal only starts on a row it may act on, and every row that described the slave has moved by
// the time the run ends.
//
// The middle step — the map's slave part and the remove-slave program on the master — is the act
// cluster-deploy-slave's compensating action performs, and it is the SAME code (takeSlavePlaneDown).
// It is proven where that one is: on the real `ansiwise-rest serve`, in
// redeploy.ansiwise.test.ts's "abort-with-cleanup (deploy-slave)" case. Nothing here mocks a
// program run to assert it a second time in a shape no machine has.

const stepOf = (h: Harness, name: string, serverId = SLAVE_ID): Step => {
  const step = removeSlaveSteps(serverId, h.runPorts).find((s: Step) => s.name === name);
  if (!step) throw new Error(`no step ${name}`);
  return step;
};

/** A live slave, the state a removal starts from. */
function seedLiveSlave(h: Harness): void {
  seedMasterCluster(h);
  h.db.db.insert(clusters).values({
    id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "active", slaveId: 1,
    planeState: "ready", planeJson: { v: 0, branch: PARAMS.domain },
  }).run();
  h.db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
}

describe("cluster-remove-slave", () => {
  afterEach(disposeHarnesses);

  it("is four steps opening with attest-target, which is what makes it unskippable", () => {
    // assertGuardsArmed refuses to boot a mutating definition whose step 0 is called anything else,
    // and Executor.skipStep refuses to wave exactly that name through. A rename here is silent
    // everywhere except this assertion and that boot check.
    expect(removeSlaveSteps(SLAVE_ID, { }).map((s) => s.name))
      .toEqual(["attest-target", "remove-slave", "drop-cluster-map", "retire-rows"]);
  });

  it("attests the MASTER, because that is the machine every act of this run lands on", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const logs: string[] = [];
    const checkpoints: unknown[] = [];
    await stepOf(h, "attest-target").run(hostedStepCtx(h, {
      log: (_s, l) => logs.push(l),
      checkpoint: (d) => checkpoints.push(d),
    }));
    // The fixture's hosts answer /etc/machine-id; the row it lands on is the MASTER's, and the
    // slave's stays untouched — the slave is never dialled at all.
    expect(h.db.db.select().from(servers).where(eq(servers.id, MASTER_ID)).get()?.machineId).toBe("abc123def4567890abc123def4567890");
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.machineId).toBeNull();
    expect(checkpoints.at(-1)).toMatchObject({ clusterId: "cls_s1", domain: PARAMS.domain, machineIdAction: "recorded" });
    expect(logs.join("\n")).toContain("every act of this run is on m1");
  });

  it("REFUSES a machine that also carries the master part, naming what such a removal would need", async () => {
    // The master arm of cluster-deploy-slave produces exactly this machine, so the case is real.
    // Taking the slave part off it leaves a live master whose branch and machine layer were
    // installed under the combined role — a regeneration and a machine-layer re-run, neither of
    // which this run kind does.
    const h = await makeHarness();
    seedLiveSlave(h);
    h.db.db.update(servers).set({ role: "master+slave" }).where(eq(servers.id, MASTER_ID)).run();
    await expect(stepOf(h, "attest-target", MASTER_ID).run(hostedStepCtx(h)))
      .rejects.toThrow(/carries the master part \(role master\+slave\).*regeneration and a machine-layer re-run/s);
  });

  it("REFUSES a server this manager records no cluster for", async () => {
    const h = await makeHarness();
    seedMasterCluster(h); // the master's own row stands; the slave has none
    await expect(stepOf(h, "attest-target").run(hostedStepCtx(h)))
      .rejects.toThrow(/records no cluster for s1 — there is no slave here to remove/);
  });

  it("takes the cluster's map off the books branch, and a second run finds it already gone", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain))).not.toBeNull();

    const checkpoints: unknown[] = [];
    const ctx = hostedStepCtx(h, { checkpoint: (d) => checkpoints.push(d) });
    await stepOf(h, "drop-cluster-map").run(ctx);
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain))).toBeNull();
    expect(checkpoints.at(-1)).toEqual({ domain: PARAMS.domain, changed: true });

    // Idempotent: re-running the step commits nothing, so a resumed run does not write over the
    // books branch to say the same thing twice.
    const commits = h.platformRepo.commits.length;
    await stepOf(h, "drop-cluster-map").run(ctx);
    expect(h.platformRepo.commits).toHaveLength(commits);
    expect(checkpoints.at(-1)).toEqual({ domain: PARAMS.domain, changed: false });
    // The MASTER's map is not touched by a slave's removal.
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath("m1.example.com"))).not.toBeNull();
  });

  it("moves every row that described the slave — which is the whole of what the shell files never did", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    await stepOf(h, "retire-rows").run(hostedStepCtx(h));

    const cluster = h.db.db.select().from(clusters).where(eq(clusters.id, "cls_s1")).get();
    expect(cluster?.status).toBe("removed");
    // The plane's JSON goes with its state: every id in it named a Vault mount and an ArgoCD
    // namespace the program has just deleted, and a plane left behind is what a later reader
    // resolves a per-slave kube client from.
    expect(cluster?.planeState).toBe("absent");
    expect(cluster?.planeJson).toBeNull();
    // The ORDINAL is kept. It is never recycled, so a machine put back is a fresh deployment with a
    // new one; clearing it here would let the next allocation hand this one out again.
    expect(cluster?.slaveId).toBe(1);
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("undeployed");
    // The MASTER is left exactly as it stands: it keeps operating the installation.
    expect(h.db.db.select().from(servers).where(eq(servers.id, MASTER_ID)).get()?.status).toBe("healthy");
    expect(h.db.db.select().from(clusters).where(eq(clusters.id, "cls_master")).get()?.status).toBe("active");
  });

  it("plans a card naming BOTH machines, the master as the one it acts on and the slave as the one it never reaches", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const plan = await makeRemoveSlaveDef(h.runPorts).plan({ serverId: SLAVE_ID }, { db: h.db.db });
    expect(plan.targets?.map((t) => ({ id: t.serverId, owns: t.ownsHost })))
      .toEqual([{ id: MASTER_ID, owns: true }, { id: SLAVE_ID, owns: false }]);
    expect(plan.summary).toContain("EVERY ONE OF THEM ON THE MASTER");
    expect(plan.summary).toContain("THE SLAVE ITSELF IS NOT TOUCHED");
    // A run that destroys a Vault mount and a reconciler project says so on the card a person
    // approves it from, and says what it does NOT do — a removal is not a decommissioning.
    expect(plan.warnings.join("\n")).toMatch(/not reversible/);
    expect(plan.warnings.join("\n")).toMatch(/not wiped, not shut down/);
    expect(plan.requiredSecrets).toEqual(["ansiwise-elevation"]);
  });
});
