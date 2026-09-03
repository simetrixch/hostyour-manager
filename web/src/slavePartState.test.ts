import { describe, it, expect } from "vitest";
import type { ServerClusterView, ServerView } from "../../shared/api-types.ts";
import { slavePartBlock } from "./slavePartState.ts";

// The master's card is the ONE place the machine this manager runs on says which parts it carries,
// and the only place the run that adds the other part can be started from. Both are wording and a
// decision, so both are measured here.
//
// The rule the whole block is written under: the card offers exactly what the plan admits, in the
// words the plan refuses in. A card offering less would leave the act reachable only by somebody who
// can post to the API; a card offering more would send a person to a refusal.

const CLUSTER: ServerClusterView = { domain: "m1.example.com", stage: "prod", status: "active" };

function server(over: Partial<ServerView> = {}): ServerView {
  return {
    id: "srv_m1", name: "m1", host: "m1.example.com", lanHost: null, tailnetHost: null, sshPort: 22, sshUser: "m1",
    role: "master", status: "healthy", cluster: CLUSTER,
    tailnetState: "unknown", tailnet: { kind: "none" },
    passwordLoginState: "unknown", passwordLogin: { kind: "none" },
    authorizedKeysState: "unknown", authorizedKeys: { kind: "none" },
    hostKeyPinned: null, machineIdRecorded: false, createdAt: 0, adoptedAt: null, hasPassword: false, hasKey: true,
    ...over,
  };
}

describe("slavePartBlock — which parts the machine carries, and whether it offers the other one", () => {
  it("offers the act on a master whose own cluster is live, carrying that cluster's domain and stage", () => {
    const block = slavePartBlock(server(), { runOpen: false });
    // The offer IS the run's two parameters: the machine's own branch and stage, never typed.
    expect(block?.offer).toEqual({ domain: "m1.example.com", stage: "prod" });
    // The sentence names the same two, so what the card says and what the run takes cannot differ.
    expect(block?.line).toContain("carries the master part alone");
    expect(block?.line).toContain("m1.example.com (prod)");
    expect(block?.line).toContain("master+slave");
  });

  it("states BOTH parts and offers nothing once the machine stands at the combined role", () => {
    // This is the state the run writes onto the row, so the card reads it back as the act being
    // carried rather than as one still to take.
    const block = slavePartBlock(server({ role: "master+slave" }), { runOpen: false });
    expect(block?.offer).toBeNull();
    expect(block?.line).toContain("carries the master part and the slave part");
    expect(block?.line).toContain("m1.example.com (prod)");
  });

  it("withholds the act where the machine keeps no cluster, saying what there is none of", () => {
    // The slave part is added to the master's OWN cluster (deploy-slave.master.ts masterSelfCluster),
    // so a machine with no cluster row has nothing to add it to and the plan refuses in these words.
    const block = slavePartBlock(server({ cluster: null }), { runOpen: false });
    expect(block?.offer).toBeNull();
    expect(block?.line).toContain("records no cluster for it");
  });

  it("withholds the act while the machine's own cluster is not live, and names the status", () => {
    const block = slavePartBlock(server({ cluster: { ...CLUSTER, status: "provisioning" } }), { runOpen: false });
    expect(block?.offer).toBeNull();
    expect(block?.line).toContain("'provisioning'");
    expect(block?.line).toContain("LIVE cluster");
  });

  it("withholds the act while a run of this machine's is open, and states the same thing about it", () => {
    // An open run is the card's one next step. What the machine carries is unchanged by it, so only
    // the offer goes.
    const open = slavePartBlock(server(), { runOpen: true });
    expect(open?.offer).toBeNull();
    expect(open?.line).toBe(slavePartBlock(server(), { runOpen: false })?.line);
  });

  it("says nothing at all about a machine carrying no master part", () => {
    // Such a machine takes the slave part by being deployed, which its lifecycle offers; a second
    // sentence about parts on that card would describe the same act twice.
    expect(slavePartBlock(server({ role: "slave", cluster: null }), { runOpen: false })).toBeNull();
    expect(slavePartBlock(server({ role: "slave" }), { runOpen: false })).toBeNull();
  });
});
