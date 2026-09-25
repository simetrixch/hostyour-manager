import { describe, it, expect, afterEach } from "vitest";
import { dropCoordinatorNodes, coordinatorNodesOf } from "./defs/tailnet.coordinator.ts";
import type { Stage } from "../../../shared/enums.ts";
import {
  MASTER_ID, PARAMS,
  scriptedHosts, makeHarness, disposeHarnesses, hostedStepCtx, type Harness,
} from "./deploy-slave.fixture.ts";

// WHAT AN EARLIER LIFE OF A MACHINE LEAVES AT THE COORDINATOR, and why a join clears it.
//
// A registration lives in the coordinator's own database on the master, not on the machine. So it
// survives everything done to the machine: restoring a slave puts back a disk that has forgotten its
// node key while the coordinator still lists the node that key belonged to. The machine then joins
// again and registers FRESH, and the coordinator holds two nodes under one name — at which point
// nothing can say which of them the manager should open a wire to.
//
// The join is where this is cleared, because the join is the act that makes the standing node dead:
// the catalogue's join programs discard the machine's node key as their first step.

const OWNER = PARAMS.domain.split(".")[0]!;
const STAGE = PARAMS.stage as Stage;

/** A node listing as the coordinator prints it — the shape measured off headscale 0.29.2. */
function listing(nodes: Array<{ id: number; name: string; owner: string; ips: string[] }>): string {
  return JSON.stringify(nodes.map((n) => ({
    id: n.id,
    name: n.name,
    given_name: n.name,
    user: { id: 1, name: n.owner, created_at: { seconds: 1, nanos: 0 } },
    ip_addresses: n.ips,
    online: false,
  })));
}

async function world(over: Partial<ReturnType<typeof scriptedHosts>> = {}): Promise<Harness> {
  return makeHarness({ hosts: scriptedHosts(over) });
}

/** Every coordinator command the run sent, in order, with the host it went to. */
function coordinatorCalls(h: Harness): Array<{ host: string; command: string }> {
  return h.hosts.log.filter((l) => l.command.includes("headscale")).map((l) => ({ host: l.host, command: l.command }));
}

describe("clearing what an earlier life left at the coordinator", () => {
  afterEach(disposeHarnesses);

  it("takes the standing node away, by id, on the master", async () => {
    const h = await world({ coordinatorNodesOut: listing([{ id: 7, name: OWNER, owner: OWNER, ips: ["100.64.0.1"] }]) });
    const ctx = hostedStepCtx(h);

    const cleared = await dropCoordinatorNodes(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER);

    expect(cleared).toBe(1);
    const calls = coordinatorCalls(h);
    // THE MASTER AND NOWHERE ELSE: the coordinator is a workload of the master's own cluster, and the
    // machine being deployed is never asked about its own registration.
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(["m1.example.com"]));
    expect(calls.at(-1)?.command).toContain("nodes delete -i 7 --force");
  });

  it("says so and touches nothing where the coordinator lists none", async () => {
    const h = await world({ coordinatorNodesOut: "null" });
    const said: string[] = [];
    const ctx = hostedStepCtx(h, { log: (_s, text) => said.push(text) });

    const cleared = await dropCoordinatorNodes(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER);

    expect(cleared).toBe(0);
    expect(said.join(" ")).toContain("nothing of an earlier life to clear");
    expect(coordinatorCalls(h).filter((c) => c.command.includes("nodes delete"))).toEqual([]);
  });

  it("leaves another machine's node alone", async () => {
    // The listing carries every machine of the installation. Clearing by owner is what keeps this
    // act exact — the coordinator files one user per machine, named after it.
    const h = await world({
      coordinatorNodesOut: listing([
        { id: 3, name: "somebody-else", owner: "somebody-else", ips: ["100.64.0.4"] },
        { id: 4, name: OWNER, owner: OWNER, ips: ["100.64.0.5"] },
      ]),
    });
    const ctx = hostedStepCtx(h);

    await dropCoordinatorNodes(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER);

    const deletes = coordinatorCalls(h).filter((c) => c.command.includes("nodes delete"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.command).toContain("-i 4 ");
  });

  it("clears BOTH where an earlier life left two, which is the state this exists for", async () => {
    const h = await world({
      coordinatorNodesOut: listing([
        { id: 1, name: OWNER, owner: OWNER, ips: ["100.64.0.1"] },
        { id: 2, name: OWNER, owner: OWNER, ips: ["100.64.0.2"] },
      ]),
    });
    const ctx = hostedStepCtx(h);

    expect(await dropCoordinatorNodes(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER)).toBe(2);
    expect(coordinatorCalls(h).filter((c) => c.command.includes("nodes delete"))).toHaveLength(2);
  });

  it("STOPS where the coordinator will not let go", async () => {
    // Joining anyway would put a second node under one name, and the step that reads the address
    // afterwards refuses exactly that — three steps later, about something else.
    const h = await world({
      coordinatorNodesOut: listing([{ id: 9, name: OWNER, owner: OWNER, ips: ["100.64.0.9"] }]),
      coordinatorDeleteExit: 1,
    });
    const ctx = hostedStepCtx(h);

    await expect(dropCoordinatorNodes(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER))
      .rejects.toThrow(/would not take away .*100\.64\.0\.9/);
  });

  it("refuses output that is not the coordinator's document rather than reading past it", async () => {
    const h = await world({ coordinatorNodesOut: "Error from server: pods \"headscale\" not found" });
    const ctx = hostedStepCtx(h);

    await expect(coordinatorNodesOf(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER)).rejects.toThrow(/not JSON/);
  });

  it("names the invocation when the coordinator cannot be addressed at all", async () => {
    const h = await world({ coordinatorNodesOut: "", coordinatorNodesExit: 1 });
    const ctx = hostedStepCtx(h);

    await expect(coordinatorNodesOf(ctx, await ctx.ssh(MASTER_ID), STAGE, OWNER))
      .rejects.toThrow(/could not be read on the master/);
  });
});
