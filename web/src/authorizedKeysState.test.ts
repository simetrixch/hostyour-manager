import { describe, it, expect } from "vitest";
import type { AuthorizedKeyFact, ServerAuthorizedKeysRead, ServerView } from "../../shared/api-types.ts";
import { SERVER_AUTHORIZED_KEYS_STATE, type ServerAuthorizedKeysState } from "../../shared/enums.ts";
import {
  authorizedKeysChip, authorizedKeysRunKindOffer, operatorKeyPlacement, AUTHORIZED_KEYS_READING_FRESH_MS,
} from "./authorizedKeysState.ts";

// The card is where an operator finds out that somebody else can log in to a machine, so the wording
// is the substance: a key nobody here placed has to read as exactly that, and a reading nobody has
// taken has to read as nothing at all — never as "clean".

const NOW = 1_700_000_000_000;

function server(
  authorizedKeysState: ServerAuthorizedKeysState,
  authorizedKeys: ServerAuthorizedKeysRead,
  over: Partial<ServerView> = {},
): ServerView {
  return {
    id: "srv_1", name: "s1", host: "203.0.113.7", lanHost: null, tailnetHost: null, sshPort: 22, sshUser: "root",
    role: "slave", status: "ready", tailnetState: "unknown", tailnet: { kind: "none" },
    passwordLoginState: "unknown", passwordLogin: { kind: "none" },
    authorizedKeysState, authorizedKeys,
    release: { kind: "unknown", reason: "no cluster map" },
    createdAt: NOW, adoptedAt: NOW, hasPassword: false, hasKey: true, ...over,
  };
}

const key = (over: Partial<AuthorizedKeyFact> = {}): AuthorizedKeyFact => ({
  fingerprint: "SHA256:k", type: "ssh-ed25519", comment: "", kind: "controller", label: null, ...over,
});

const read = (keys: AuthorizedKeyFact[], over: { observedAt?: number; unparsed?: number } = {}): ServerAuthorizedKeysRead => ({
  kind: "v0",
  facts: { v: 0, observedAt: over.observedAt ?? NOW, runId: "run_abc", keys, unparsed: over.unparsed ?? 0 },
});

describe("the authorized-keys chip", () => {
  it("says NOTHING WAS MEASURED when nothing was, and points at no run", () => {
    const chip = authorizedKeysChip(server("unknown", { kind: "none" }), NOW);
    expect(chip.label).toBe("authorized keys: not read");
    expect(chip.className).toBe("chip");
    expect(chip.detail).toMatch(/No run has read/);
    expect(chip.runId).toBeNull();
  });

  it("goes green only for a FRESH reading in which every key is one we can name", () => {
    const fresh = authorizedKeysChip(server("accounted", read([key(), key({ kind: "operator", label: "pat" })])), NOW);
    expect(fresh.label).toBe("authorized keys: all known");
    expect(fresh.className).toBe("chip chip--ok");
    expect(fresh.detail).toMatch(/pat/);
    expect(fresh.runId).toBe("run_abc");
    // Past the freshness window the age carries the whole claim: nothing re-reads a host on its own,
    // and authorized_keys is a plain file anyone with a shell can append to.
    const stale = authorizedKeysChip(
      server("accounted", read([key()], { observedAt: NOW - AUTHORIZED_KEYS_READING_FRESH_MS - 1 })), NOW,
    );
    expect(stale.className).toBe("chip");
    expect(stale.detail).toMatch(/Read 1 h ago/);
  });

  it("names the foreign keys, and never softens them with age", () => {
    const chip = authorizedKeysChip(
      server("unaccounted", read([key(), key({ fingerprint: "SHA256:hetz", kind: "foreign", comment: "someone@example.com" })])),
      NOW,
    );
    expect(chip.label).toBe("authorized keys: 1 foreign");
    expect(chip.className).toBe("chip chip--warn");
    // The fingerprint is what an operator can cross-check on the box with ssh-keygen -lf.
    expect(chip.detail).toMatch(/SHA256:hetz/);
    expect(chip.detail).toMatch(/someone@example\.com/);
    expect(chip.detail).toMatch(/no run kind can remove them/);
  });

  it("says an unreadable file is unmeasured, not empty", () => {
    const chip = authorizedKeysChip(server("unreadable", read([])), NOW);
    expect(chip.label).toBe("authorized keys: unreadable");
    expect(chip.className).toBe("chip chip--warn");
    expect(chip.detail).toMatch(/unmeasured/);
  });

  it("tells a document this build cannot read apart from one that failed its schema", () => {
    expect(authorizedKeysChip(server("accounted", { kind: "unsupported", v: 7 }), NOW).detail).toMatch(/version 7/);
    expect(authorizedKeysChip(server("accounted", { kind: "unreadable", reason: "keys: expected array" }), NOW).detail)
      .toMatch(/keys: expected array/);
  });

  it("counts the lines it could not read as a key, beside the foreign ones and never instead", () => {
    // A line this controller cannot read may still be one sshd authenticates with, so the chip has
    // to name it — and a chip that counted only foreign keys would say "0 foreign" here.
    const chip = authorizedKeysChip(server("unaccounted", read([key()], { unparsed: 2 })), NOW);
    expect(chip.label).toBe("authorized keys: 2 unreadable");
    expect(chip.className).toBe("chip chip--warn");
    expect(chip.detail).toMatch(/2 line\(s\) in the file are not a key this controller can read/);
    const both = authorizedKeysChip(
      server("unaccounted", read([key(), key({ fingerprint: "SHA256:hetz", kind: "foreign" })], { unparsed: 1 })),
      NOW,
    );
    expect(both.label).toBe("authorized keys: 1 foreign, 1 unreadable");
  });

  it("answers every state, and every sentence says a run is what takes a new reading", () => {
    for (const state of SERVER_AUTHORIZED_KEYS_STATE) {
      const chip = authorizedKeysChip(server(state, state === "unknown" ? { kind: "none" } : read([key()])), NOW);
      expect(chip.label, state).toMatch(/^authorized keys: /);
      // No sentence tells the operator to do something — the card's own buttons are the buttons.
      expect(chip.detail, state).not.toMatch(/press|click|run the/i);
    }
  });
});

describe("what the card may offer", () => {
  it("offers the read run kind exactly where this controller holds a key, and never on the reading", () => {
    for (const status of ["ready", "healthy", "degraded", "provisioning", "draining", "undeployed"] as const) {
      expect(authorizedKeysRunKindOffer(server("unknown", { kind: "none" }, { status })).read, status).toBe(true);
    }
    // A host adopt has never touched, and one whose key is being installed right now: there is no
    // session to read over.
    for (const status of ["bare", "adopting"] as const) {
      expect(authorizedKeysRunKindOffer(server("accounted", read([key()]), { status })).read, status).toBe(false);
    }
  });

  it("offers both acts on the same predicate, whatever the reading says", () => {
    // A snapshot may not decide what an operator is allowed to attempt: "not on the host" an hour
    // ago says nothing about now, and each run kind reads the live file and reports what it found.
    for (const s of [server("accounted", read([])), server("unknown", { kind: "none" })]) {
      expect(operatorKeyPlacement(s, "SHA256:pat")).toMatchObject({ place: true, remove: true });
    }
    expect(operatorKeyPlacement(server("accounted", read([]), { status: "bare" }), "SHA256:pat"))
      .toMatchObject({ place: false, remove: false });
  });
});

describe("one key against one server", () => {
  it("tells 'not on the host' apart from 'nobody has looked'", () => {
    expect(operatorKeyPlacement(server("accounted", read([key()])), "SHA256:pat").state).toBe("absent");
    expect(operatorKeyPlacement(server("unknown", { kind: "none" }), "SHA256:pat").state).toBe("unread");
    expect(operatorKeyPlacement(server("unknown", { kind: "none" }), "SHA256:pat").line).toMatch(/nothing here can say/);
  });

  it("names the label a present key was placed under", () => {
    const p = operatorKeyPlacement(
      server("accounted", read([key({ fingerprint: "SHA256:pat", kind: "operator", label: "pat" })])), "SHA256:pat",
    );
    expect(p.state).toBe("present");
    expect(p.line).toMatch(/under the label "pat"/);
  });

  it("warns when the key is there under a comment this platform did not write", () => {
    // Removing by marker cannot reach such a line, and the run says so rather than reporting a
    // removal that did not happen — the card has to say it first.
    const p = operatorKeyPlacement(
      server("unaccounted", read([key({ fingerprint: "SHA256:pat", kind: "foreign", comment: "pat@his-laptop" })])), "SHA256:pat",
    );
    expect(p.state).toBe("present");
    expect(p.line).toMatch(/a removal by label will not reach it/);
    expect(p.line).toMatch(/pat@his-laptop/);
  });
});
