import { describe, it, expect } from "vitest";
import type { ServerPasswordLoginRead, ServerView } from "../../shared/api-types.ts";
import { SERVER_PASSWORD_LOGIN_STATE, type ServerPasswordLoginState } from "../../shared/enums.ts";
import { passwordLoginChip, passwordLoginVerbOffer, PASSWORD_LOGIN_READING_FRESH_MS } from "./passwordLoginState.ts";

// The card is where an operator finds out that a machine takes passwords, so the wording is the
// substance: an open door has to read as open, and a reading nobody has taken has to read as
// nothing at all — never as "off".

const NOW = 1_700_000_000_000;

function server(passwordLoginState: ServerPasswordLoginState, passwordLogin: ServerPasswordLoginRead, over: Partial<ServerView> = {}): ServerView {
  return {
    id: "srv_1", name: "s1", host: "203.0.113.7", lanHost: null, tailnetHost: null, sshPort: 22, sshUser: "root",
    role: "slave", status: "ready", tailnetState: "unknown", tailnet: { kind: "none" },
    passwordLoginState, passwordLogin,
    authorizedKeysState: "unknown", authorizedKeys: { kind: "none" },
    createdAt: NOW, adoptedAt: NOW, hasPassword: false, hasKey: true, ...over,
  };
}

type FactOverrides = Partial<{
  observedAt: number; passwordAuthentication: string | null;
  kbdInteractiveAuthentication: string | null; pubkeyAuthentication: string | null;
}>;
const facts = (over: FactOverrides = {}): ServerPasswordLoginRead => ({
  kind: "v0",
  facts: {
    v: 0, observedAt: NOW, runId: "run_abc",
    passwordAuthentication: "no", kbdInteractiveAuthentication: "no", pubkeyAuthentication: "yes", ...over,
  },
});

describe("passwordLoginChip — an open door is never worded softly, and an unread one is never green", () => {
  it("a fresh off reading is the ONLY case that reads green", () => {
    const chip = passwordLoginChip(server("off", facts()), NOW);
    expect(chip.label).toBe("password login: off");
    expect(chip.className).toBe("chip chip--ok");
    expect(chip.detail).toContain("key logins only");
    expect(chip.runId).toBe("run_abc");
  });

  it("quotes what sshd -T said rather than only summarising it — the summary is what a file gets wrong", () => {
    const chip = passwordLoginChip(server("off", facts()), NOW);
    expect(chip.detail).toContain("passwordauthentication no");
    expect(chip.detail).toContain("kbdinteractiveauthentication no");
    expect(chip.detail).toContain("pubkeyauthentication yes");
  });

  it("an off reading nobody has refreshed loses its green — nothing re-reads the daemon on its own", () => {
    const stale = passwordLoginChip(server("off", facts({ observedAt: NOW - PASSWORD_LOGIN_READING_FRESH_MS - 1 })), NOW);
    expect(stale.className).toBe("chip");
    expect(stale.detail).toContain("only a run takes a new one");
  });

  it("an on reading warns and says who can try a password", () => {
    const chip = passwordLoginChip(server("on", facts({ passwordAuthentication: "yes", kbdInteractiveAuthentication: "yes" })), NOW);
    expect(chip.label).toBe("password login: on");
    expect(chip.className).toBe("chip chip--warn");
    expect(chip.detail).toContain("anyone who can reach its SSH port");
  });

  it("a row nothing has looked at says exactly that, and points at no run", () => {
    const chip = passwordLoginChip(server("unknown", { kind: "none" }), NOW);
    expect(chip.label).toBe("password login: not read");
    expect(chip.className).toBe("chip");
    expect(chip.runId).toBeNull();
  });

  it("a daemon that would not answer is unmeasured, never 'off'", () => {
    const chip = passwordLoginChip(server("unreadable", facts({ passwordAuthentication: null, kbdInteractiveAuthentication: null, pubkeyAuthentication: null })), NOW);
    expect(chip.label).toBe("password login: unreadable");
    expect(chip.className).toBe("chip chip--warn");
    expect(chip.detail).toContain("unmeasured");
  });

  it("tells a document this build cannot read apart from one that failed its schema", () => {
    expect(passwordLoginChip(server("off", { kind: "unsupported", v: 1 }), NOW).detail).toContain("version 1");
    expect(passwordLoginChip(server("off", { kind: "unreadable", reason: "runId: too small" }), NOW).detail).toContain("runId: too small");
  });

  it("is total over the state list and never green outside a fresh 'off'", () => {
    for (const state of SERVER_PASSWORD_LOGIN_STATE) {
      const chip = passwordLoginChip(server(state, state === "unknown" ? { kind: "none" } : facts()), NOW);
      expect(chip.label.startsWith("password login: ")).toBe(true);
      expect(chip.detail.length).toBeGreaterThan(0);
      if (state !== "off") expect(chip.className).not.toContain("chip--ok");
    }
  });
});

describe("passwordLoginVerbOffer — the buttons follow the key this controller holds, never the reading", () => {
  it("offers both verbs on a host this controller has a key for", () => {
    expect(passwordLoginVerbOffer(server("on", facts()))).toEqual({ disable: true, enable: true });
  });

  it("offers neither before the key is installed — there would be nothing to fall back on", () => {
    // The plan refuses the same two statuses through the same predicate
    // (defs/password-login.kit.ts), so the card cannot offer a run the server will reject.
    for (const status of ["bare", "adopting"] as const) {
      expect(passwordLoginVerbOffer(server("unknown", { kind: "none" }, { status }))).toEqual({ disable: false, enable: false });
    }
  });

  it("keeps offering the disable verb on a host that once read off — a snapshot may not gate an act", () => {
    // A reading an hour old says nothing about now, and this is the one surface where being wrong
    // means an open door nobody is looking at.
    expect(passwordLoginVerbOffer(server("off", facts({ observedAt: 0 }))).disable).toBe(true);
  });

  it("offers both on the MASTER, which carries no adoptedAt at all and needs the verb most", () => {
    // seed-master registers the master at boot with status "healthy" and never adopts it, so a rule
    // keyed on adoptedAt would hide these buttons from the one host whose door was measured.
    expect(passwordLoginVerbOffer(server("on", facts(), { role: "master", status: "healthy", adoptedAt: null })))
      .toEqual({ disable: true, enable: true });
  });
});
