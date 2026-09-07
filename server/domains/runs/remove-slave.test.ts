import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { removeSlaveSteps, makeRemoveSlaveDef } from "./defs/remove-slave.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, SLAVE_PUBLIC_KEY, makeHarness, disposeHarnesses, hostedStepCtx,
  scriptedHosts, seedMasterCluster, type Harness,
} from "./deploy-slave.fixture.ts";
import { IMAGE_KEY_LINE } from "./deploy-slave.first-contact.fixture.ts";

// TAKING A SLAVE OUT OF AN INSTALLATION — the run kind, driven step by step.
//
// The three shell files this replaces removed the slave from the master and told this manager
// nothing, so the cluster went on standing at `active` with a plane describing a Vault mount and an
// ArgoCD namespace that no longer existed. What the cases below hold is three things: the removal
// only starts on a row it may act on, the MACHINE is put back where it still answers and skipped by
// name where it does not, and every row that described the slave has moved by the time the run
// ends.
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

  it("is seven steps opening with attest-target, in the order that keeps each route open for the next", () => {
    // assertGuardsArmed refuses to boot a mutating definition whose step 0 is called anything else,
    // and Executor.skipStep refuses to wave exactly that name through. A rename here is silent
    // everywhere except this assertion and that boot check.
    //
    // THE THREE MACHINE-SIDE NAMES ARE THE ABORT'S OWN, and in the abort's order: the master-side
    // removal while the coordinator still knows the node, then the machine stripped, then the
    // password door back on, then the key line off LAST because it is the route the two before it
    // travel. The map and the rows follow what has already happened.
    expect(removeSlaveSteps(SLAVE_ID, { }).map((s) => s.name))
      .toEqual([
        "attest-target", "remove-slave",
        "leave-host", "restore-password-login", "remove-manager-key",
        "drop-cluster-map", "retire-rows",
      ]);
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

  // LEAVING A MACHINE PUTS IT BACK — the three machine-side steps, which are cluster-deploy-slave's
  // own compensating actions run as steps of this run kind. Both cases below drive the SAME three
  // steps: the difference is only whether the scripted machine takes this manager's key.

  /** Drive the three machine-side steps in the order the run kind holds them, collecting the log. */
  async function putBack(h: Harness, over: Partial<Pick<StepCtx, "log">> = {}): Promise<string[]> {
    const logs: string[] = [];
    const ctx = hostedStepCtx(h, { log: (_s, l) => logs.push(l), ...over });
    for (const name of ["leave-host", "restore-password-login", "remove-manager-key"]) {
      await stepOf(h, name).run(ctx);
    }
    return logs;
  }

  it("PUTS THE MACHINE BACK where it answers: stripped, password login on, this manager's key off and purged", async () => {
    // A machine as a finished deployment leaves it: it judges the key a session offers and takes
    // this manager's line, and its password door is shut.
    const h = await makeHarness({
      hosts: scriptedHosts({ judgesKeys: true, authorizedKeys: [IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY], passwordLogin: "no" }),
    });
    seedLiveSlave(h);
    await putBack(h);

    // leave-host: the script raised whole, and the two engine executables off the route they were
    // placed by — they are deliberately outside MACHINE_STATE, so the script cannot carry them.
    const sent = h.hosts.log.filter((c) => c.host === "10.1.1.11").map((c) => c.command);
    expect(sent.filter((c) => c.startsWith("sudo -S -p '' bash /tmp/dc-leave-host-"))).toHaveLength(1);
    expect(sent.some((c) => c.includes("rm -f ") && c.includes("/usr/local/bin/ansiwise"))).toBe(true);
    // restore-password-login: the door the deployment shut is open again. Without it a machine whose
    // key line has just been taken off answers nobody at all.
    expect(h.hosts.passwordLogin).toBe("yes");
    // remove-manager-key: OUR line and only ours. The image's own key is a way in nothing here may
    // touch, and it is the only way in the next owner of the box has.
    expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE]);
    // The row and the credential follow the act: a machine that takes no key of ours is one no
    // ctx.ssh() can reach, so a sealed key left standing would offer run kinds that die at their
    // first session.
    expect(await h.store.list({ serverId: SLAVE_ID, kind: "ssh_key", excludeRotated: true })).toHaveLength(0);
    const row = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect(row?.status).toBe("bare");
    expect(row?.adoptedAt).toBeNull();

    // ...and retire-rows leaves `bare` standing. Writing `undeployed` over it would say this
    // installation still holds something on a machine it holds nothing on.
    await stepOf(h, "retire-rows").run(hostedStepCtx(h));
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("bare");
    expect(h.db.db.select().from(clusters).where(eq(clusters.id, "cls_s1")).get()?.status).toBe("removed");
  });

  it("SKIPS each machine-side act BY NAME where the machine no longer answers, and the removal goes on", async () => {
    // The ordinary reason to remove a slave: the machine is gone. It judges keys and carries no line
    // of this manager's, so every key session to it is refused — which is exactly what a machine
    // reinstalled at the hosting provider does while its cluster row still stands.
    const h = await makeHarness({ hosts: scriptedHosts({ judgesKeys: true, authorizedKeys: [IMAGE_KEY_LINE] }) });
    seedLiveSlave(h);
    const logs = await putBack(h);

    // Each act says which one it is and which machine it could not reach. A run that failed here
    // would refuse precisely the case this run kind exists for.
    for (const act of ["leave-host", "restore-password-login", "remove-manager-key"]) {
      expect(logs.join("\n")).toContain(`${act} is skipped: s1 does not answer this manager's key`);
    }
    // Nothing was done to the machine, and nothing was written about it as if it had been: the
    // key stays sealed and the row is not moved to `bare` by a step that reached nothing.
    expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE]);
    expect(h.hosts.passwordLogin).toBe("yes");
    expect(await h.store.list({ serverId: SLAVE_ID, kind: "ssh_key", excludeRotated: true })).toHaveLength(1);

    // The rows still follow, which is the whole point of going on: the cluster is removed and the
    // machine reads `undeployed` — it keeps what the deployment left on it and this installation
    // deploys it no longer.
    await stepOf(h, "retire-rows").run(hostedStepCtx(h));
    expect(h.db.db.select().from(clusters).where(eq(clusters.id, "cls_s1")).get()?.status).toBe("removed");
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("undeployed");
  });

  it("names the OTHER absence too: a machine this manager holds no key for is skipped without a session", async () => {
    // An earlier removal already took the key off, or the credential was purged by hand. There is no
    // route at all, and the step must not report that as a machine that refused one.
    const h = await makeHarness();
    seedLiveSlave(h);
    for (const key of await h.store.list({ serverId: SLAVE_ID, kind: "ssh_key", excludeRotated: true })) await h.store.purge(key.id);
    const logs = await putBack(h);
    expect(logs.join("\n")).toContain("leave-host is skipped: this manager holds no SSH key for s1");
    expect(h.hosts.log.filter((c) => c.host === "10.1.1.11")).toHaveLength(0);
  });

  it("plans a card naming BOTH machines, and owning both — it acts on the master and strips the slave", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const plan = await makeRemoveSlaveDef(h.runPorts).plan({ serverId: SLAVE_ID }, { db: h.db.db });
    expect(plan.targets?.map((t) => ({ id: t.serverId, owns: t.ownsHost })))
      .toEqual([{ id: MASTER_ID, owns: true }, { id: SLAVE_ID, owns: true }]);
    // The summary says what an operator gets, BOTH ways: the machine put back where it answers, and
    // left as it stands where it does not.
    expect(plan.summary).toContain("PUT THE MACHINE BACK");
    expect(plan.summary).toContain("IF IT STILL ANSWERS");
    expect(plan.summary).toContain("IF IT DOES NOT ANSWER");
    // A run that destroys a Vault mount and a reconciler project says so on the card a person
    // approves it from, and says what it does NOT do — a removal is not a decommissioning.
    expect(plan.warnings.join("\n")).toMatch(/not reversible/);
    expect(plan.warnings.join("\n")).toMatch(/not wiped and not shut down/);
    expect(plan.warnings.join("\n")).toMatch(/bootstrap password/);
    expect(plan.requiredSecrets).toEqual(["ansiwise-elevation"]);
  });
});
