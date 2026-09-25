import { describe, it, expect } from "vitest";
import type { ServerClusterView, ServerView } from "../../shared/api-types.ts";
import { masterPartsLine } from "./masterParts.ts";

// The master's card is the ONE place the machine this manager runs on says which parts it carries.
// A master carries both from its own installation, so the sentence states both and offers no act.

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

describe("masterPartsLine — which parts the machine carries", () => {
  it("states both parts on a master, naming its own branch and stage", () => {
    const line = masterPartsLine(server());
    expect(line).toContain("carries the master part and the slave part");
    expect(line).toContain("m1.example.com (prod)");
  });

  it("states both parts and that no cluster is recorded where the master keeps none", () => {
    expect(masterPartsLine(server({ cluster: null }))).toContain("records no cluster for it");
  });

  it("says nothing at all about a machine carrying no master part", () => {
    // Such a machine takes the slave part by being deployed, which its lifecycle offers; a second
    // sentence about parts on that card would describe the same act twice.
    expect(masterPartsLine(server({ role: "slave", cluster: null }))).toBeNull();
    expect(masterPartsLine(server({ role: "slave" }))).toBeNull();
  });
});
