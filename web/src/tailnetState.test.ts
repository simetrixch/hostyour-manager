import { describe, it, expect } from "vitest";
import type { ServerTailnetRead, ServerView } from "../../shared/api-types.ts";
import { SERVER_TAILNET_STATE, type ServerTailnetState } from "../../shared/enums.ts";
import { tailnetChip, tailnetRunKindOffer, TAILNET_READING_FRESH_MS } from "./tailnetState.ts";

const NOW = 1_700_000_000_000;

function server(tailnetState: ServerTailnetState, tailnet: ServerTailnetRead): ServerView {
  return {
    id: "srv_1", name: "s1", host: "203.0.113.7", lanHost: null, tailnetHost: null, sshPort: 22, sshUser: "root",
    role: "slave", status: "ready", tailnetState, tailnet,
    passwordLoginState: "unknown", passwordLogin: { kind: "none" },
    authorizedKeysState: "unknown", authorizedKeys: { kind: "none" },
    release: { kind: "unknown", reason: "no cluster map" },
    createdAt: NOW, adoptedAt: NOW, hasPassword: false, hasKey: true,
  };
}

type FactOverrides = Partial<{
  observedAt: number; address: string | null; clientVersion: string | null;
  backendState: string | null; coordinator: string | null;
}>;
const facts = (over: FactOverrides = {}): ServerTailnetRead => ({
  kind: "v0",
  facts: {
    v: 0, observedAt: NOW, runId: "run_abc", clientVersion: "1.80.2", backendState: "Running",
    address: "100.71.4.9", coordinator: "https://tailnet.example.com", ...over,
  },
});

describe("tailnetChip — a reading is never dressed up as a status", () => {
  it("a fresh joined reading is the ONLY case that reads green, and it names the address", () => {
    const chip = tailnetChip(server("joined", facts()), NOW);
    expect(chip.className).toBe("chip chip--ok");
    expect(chip.label).toBe("tailnet: 100.71.4.9");
    expect(chip.detail).toContain("100.71.4.9");
    expect(chip.runId).toBe("run_abc");
  });

  it("names the coordinator, so an address on somebody else's network is not read as ours", () => {
    const chip = tailnetChip(server("joined", facts({ coordinator: "https://controlplane.tailscale.com" })), NOW);
    expect(chip.detail).toContain("https://controlplane.tailscale.com");
  });

  it("the same joined reading, older than the freshness window, drops its colour and states the age", () => {
    const old = tailnetChip(server("joined", facts({ observedAt: NOW - TAILNET_READING_FRESH_MS - 1 })), NOW);
    expect(old.className).toBe("chip"); // never chip--ok: nothing has re-read it
    expect(old.detail).toContain("ago");
  });

  it("a server nothing has read reads as unread — not as absent, and never as green", () => {
    const chip = tailnetChip(server("unknown", { kind: "none" }), NOW);
    expect(chip.className).toBe("chip");
    expect(chip.label).toBe("tailnet: not read");
    expect(chip.runId).toBeNull();
  });

  it("a document from a newer manager is named as unreadable, never read as v0", () => {
    const chip = tailnetChip(server("joined", { kind: "unsupported", v: 1 }), NOW);
    expect(chip.className).toBe("chip chip--warn");
    expect(chip.label).toBe("tailnet: reading unreadable");
    expect(chip.detail).toContain("version 1");
    expect(chip.runId).toBeNull(); // no readable reading ⇒ no run to point at
  });

  it("a document that failed its schema says so and repeats the reason", () => {
    const chip = tailnetChip(server("joined", { kind: "unreadable", reason: "observedAt: expected number" }), NOW);
    expect(chip.className).toBe("chip chip--warn");
    expect(chip.detail).toContain("observedAt");
  });

  it("not joined, no client and an unreadable client each say which of the three it is", () => {
    const notJoined = tailnetChip(server("not-joined", facts({ backendState: "NeedsLogin", address: null })), NOW);
    expect(notJoined.className).toBe("chip chip--warn");
    expect(notJoined.label).toBe("tailnet: not joined");
    expect(notJoined.detail).toContain("1.80.2");
    expect(notJoined.detail).toContain("NeedsLogin");

    const noClient = tailnetChip(server("no-client", facts({ address: null, clientVersion: null, backendState: null })), NOW);
    expect(noClient.className).toBe("chip chip--warn");
    expect(noClient.label).toBe("tailnet: no client");

    const silent = tailnetChip(server("client-unreadable", facts({ address: null, backendState: null })), NOW);
    expect(silent.className).toBe("chip chip--warn");
    expect(silent.label).toBe("tailnet: client unreadable");
    expect(silent.detail).toContain("unmeasured");
  });

  it("no sentence tells the operator to do anything — the card's buttons are the buttons", () => {
    // The paragraph renders on EVERY card, including the master's (never adopted, never deployed)
    // and every server past adoption, where the page offers no Adopt at all. An imperative here is
    // followable only by the rows whose reading is least likely to be wrong.
    const every = [
      tailnetChip(server("unknown", { kind: "none" }), NOW),
      tailnetChip(server("joined", { kind: "unsupported", v: 1 }), NOW),
      tailnetChip(server("joined", { kind: "unreadable", reason: "boom" }), NOW),
      ...SERVER_TAILNET_STATE.map((s) => tailnetChip(server(s, facts()), NOW)),
    ];
    for (const chip of every) {
      expect(chip.detail).not.toMatch(/\bAdopt\b|\bDeploy\b|\bRedeploy\b/);
    }
  });

  it("every state produces a chip — the table is total over the enum", () => {
    for (const state of SERVER_TAILNET_STATE) {
      expect(tailnetChip(server(state, facts()), NOW).label).toMatch(/^tailnet: /);
    }
  });
});

describe("the age in the sentence", () => {
  const detailAt = (observedAt: number): string => tailnetChip(server("joined", facts({ observedAt })), NOW).detail;

  it("is coarse on purpose — minutes, then hours, then days", () => {
    expect(detailAt(NOW)).toContain("Read just now");
    expect(detailAt(NOW - 59_000)).toContain("Read just now");
    expect(detailAt(NOW - 14 * 60_000)).toContain("Read 14 min ago");
    expect(detailAt(NOW - 3 * 60 * 60_000)).toContain("Read 3 h ago");
    expect(detailAt(NOW - 6 * 24 * 60 * 60_000)).toContain("Read 6 d ago");
  });

  it("a host clock ahead of the browser reads 'just now', not a negative age", () => {
    expect(detailAt(NOW + 10_000)).toContain("just now");
  });

  it("every readable reading ends by saying what would take a new one — there is no live probe", () => {
    for (const state of ["joined", "not-joined", "no-client", "client-unreadable"] as const) {
      expect(tailnetChip(server(state, facts()), NOW).detail).toContain("takes a new one");
    }
  });
});

describe("tailnetRunKindOffer — which repair run kinds a card may offer", () => {
  const live = { liveCluster: true };

  it("offers all three on a live slave a run has seen a client on", () => {
    expect(tailnetRunKindOffer(server("joined", facts()), live)).toEqual({ disconnect: true, reconnect: true, rejoin: true });
  });

  it("offers them on a NOT-JOINED host too — a reading is a snapshot, not the live state", () => {
    // Hiding reconnect from a host that once read joined, or disconnect from one that read
    // not-joined, would let an hour-old number decide what the operator may attempt. Each run kind
    // reads the host itself and returns saying so when there is nothing to do.
    for (const state of ["not-joined", "client-unreadable", "joined"] as const) {
      expect(tailnetRunKindOffer(server(state, facts({ backendState: state })), live).reconnect, state).toBe(true);
      expect(tailnetRunKindOffer(server(state, facts({ backendState: state })), live).disconnect, state).toBe(true);
    }
  });

  it("offers NOTHING where a run looked and found no client — there is nothing to drive", () => {
    expect(tailnetRunKindOffer(server("no-client", { kind: "none" }), live)).toEqual({
      disconnect: false, reconnect: false, rejoin: false,
    });
  });

  it("offers the REJOIN on a row nothing has looked at, and only the rejoin", () => {
    // The three do not rest on a reading the same way. Disconnect and reconnect act on a membership
    // somebody established; a rejoin establishes one from nothing, which is exactly the repair for a
    // host whose membership is not known. A machine this manager never adopted has no reading and no
    // way to get one, so withholding the rejoin locks out the one host that needs it.
    expect(tailnetRunKindOffer(server("unknown", { kind: "none" }), live)).toEqual({
      disconnect: false, reconnect: false, rejoin: true,
    });
  });

  it("offers the master everything but the DISCONNECT, which is the line the plan draws", () => {
    // The master's in-cluster components — its per-slave ArgoCD, Vault on every ESO login, the
    // manager's own kube client — reach every slave over the private network a disconnect would cut,
    // so taking the master off it is not a repair. Putting it back on is: a master that is not a
    // member cannot dial the address its slaves are registered under.
    const master: ServerView = { ...server("joined", facts()), role: "master" };
    expect(tailnetRunKindOffer(master, live)).toEqual({ disconnect: false, reconnect: true, rejoin: true });
  });

  it("withholds the master's REJOIN without a live cluster, the same rule as any other host", () => {
    const master: ServerView = { ...server("joined", facts()), role: "master" };
    expect(tailnetRunKindOffer(master, { liveCluster: false })).toEqual({
      disconnect: false, reconnect: true, rejoin: false,
    });
  });

  it("offers a master the REJOIN where no run has read a client on it", () => {
    // The offer rests on a reading, not on the role: a host nothing has looked at gives the card
    // nothing to base an offer on, and that holds for the master as much as for a slave.
    const master: ServerView = { ...server("unknown", { kind: "none" }), role: "master" };
    expect(tailnetRunKindOffer(master, live)).toEqual({ disconnect: false, reconnect: false, rejoin: true });
  });

  it("withholds only REJOIN without a live cluster — the credential is minted per slave", () => {
    expect(tailnetRunKindOffer(server("joined", facts()), { liveCluster: false })).toEqual({
      disconnect: true, reconnect: true, rejoin: false,
    });
  });

  it("covers every reading state, so a new one cannot be forgotten here", () => {
    for (const state of SERVER_TAILNET_STATE) {
      expect(Object.values(tailnetRunKindOffer(server(state, facts()), live)).every((v) => typeof v === "boolean"), state).toBe(true);
    }
  });
});
