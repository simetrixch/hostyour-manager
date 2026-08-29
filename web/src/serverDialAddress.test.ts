import { describe, it, expect } from "vitest";
import { addressLines, dialAddressLine, sshAddressLine } from "./serverDialAddress.ts";
import type { ServerView } from "../../shared/api-types.ts";

// The card has to say WHICH address is used for WHAT, and the arms have to be told apart: a slave
// deliberately reached over the cluster network and a slave whose tailnet address was never
// recorded look identical on the row and are two different situations. The master is the row that
// has no dial address at all.

function server(over: Partial<ServerView>): ServerView {
  return {
    id: "srv_1", name: "s1", host: "203.0.113.7", lanHost: null, tailnetHost: null,
    sshPort: 22, sshUser: "ubuntu", role: "slave", status: "ready",
    tailnetState: "unknown", tailnet: { kind: "none" },
    passwordLoginState: "unknown", passwordLogin: { kind: "none" },
    authorizedKeysState: "unknown", authorizedKeys: { kind: "none" },
    createdAt: 0, adoptedAt: null, hasPassword: false, hasKey: true,
    ...over,
  };
}

describe("sshAddressLine — where this manager's session actually opens", () => {
  it("names lanHost when the row carries one, which is what the executor dials", () => {
    expect(sshAddressLine(server({ lanHost: "10.1.1.11", tailnetHost: "100.64.0.11" })))
      .toBe("ssh ubuntu@10.1.1.11:22");
  });

  it("names host when there is no lanHost", () => {
    expect(sshAddressLine(server({ sshUser: "hostyour1", sshPort: 2222 }))).toBe("ssh hostyour1@203.0.113.7:2222");
  });

  it("never names the tailnet address — that is not an SSH transport", () => {
    expect(sshAddressLine(server({ tailnetHost: "100.64.0.11" }))).not.toContain("100.64.0.11");
  });
});

describe("dialAddressLine — the address the master's in-cluster components take", () => {
  it("names the tailnet address, and says it is the tailnet one, whenever the row carries it", () => {
    expect(dialAddressLine(server({ tailnetHost: "100.64.0.11", lanHost: "10.1.1.11" })))
      .toBe("kube-apiserver dialled on 100.64.0.11 (tailnet)");
  });

  it("falls back to the cluster-network address and says so", () => {
    expect(dialAddressLine(server({ lanHost: "10.1.1.11" })))
      .toBe("kube-apiserver dialled on 10.1.1.11 (cluster network)");
  });

  it("falls back to the public address and states that no internal address is on file", () => {
    expect(dialAddressLine(server({}))).toBe("kube-apiserver dialled on 203.0.113.7 (no internal address on file)");
  });

  it("says NOTHING for a role carrying the master part — install.sh refuses it an apiHost", () => {
    // MASTER_LAN_HOST seeds the master's row with a lanHost, so the fallback chain would happily
    // produce a sentence. There is no such address: the master is the one dialling.
    expect(dialAddressLine(server({ role: "master", lanHost: "10.1.1.4" }))).toBeNull();
    expect(dialAddressLine(server({ role: "master+slave", lanHost: "10.1.1.4" }))).toBeNull();
  });
});

describe("addressLines — what the card prints, in order", () => {
  it("gives a slave both lines, the SSH one first", () => {
    expect(addressLines(server({ lanHost: "10.1.1.11", tailnetHost: "100.64.0.11" }))).toEqual([
      "ssh ubuntu@10.1.1.11:22",
      "kube-apiserver dialled on 100.64.0.11 (tailnet)",
    ]);
  });

  it("gives a master ONE line — the row every installation has must not state an address it has none of", () => {
    expect(addressLines(server({ role: "master", lanHost: "10.1.1.4" }))).toEqual(["ssh ubuntu@10.1.1.4:22"]);
  });
});
