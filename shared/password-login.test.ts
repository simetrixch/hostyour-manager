import { describe, it, expect } from "vitest";
import { passwordLoginReading, readServerPasswordLogin, type PasswordLoginProbe } from "./password-login.ts";

// The fold from "what sshd printed" to "is the door open", and the version-narrowing reader beside
// it. Both are pure, and both decide something a surface then states as fact — so the one property
// under test throughout is that an unmeasured door is never reported as a shut one.

const probe = (over: Partial<PasswordLoginProbe> = {}): PasswordLoginProbe => ({
  readable: true,
  passwordAuthentication: "no",
  kbdInteractiveAuthentication: "no",
  pubkeyAuthentication: "yes",
  ...over,
});

const META = { runId: "run_abc", observedAt: 1_700_000_000_000 };

describe("passwordLoginReading — 'off' is claimed only when both keywords were read and both said no", () => {
  it("reads off when the daemon printed no to both", () => {
    const r = passwordLoginReading(probe(), META);
    expect(r.state).toBe("off");
    expect(r.doc).toEqual({
      v: 0, observedAt: META.observedAt, runId: META.runId,
      passwordAuthentication: "no", kbdInteractiveAuthentication: "no", pubkeyAuthentication: "yes",
    });
  });

  it("reads ON when only the obvious keyword is off — keyboard-interactive is the same door", () => {
    // PAM serves passwords through keyboard-interactive, so a host in this state still takes one.
    expect(passwordLoginReading(probe({ kbdInteractiveAuthentication: "yes" }), META).state).toBe("on");
  });

  it("reads on when the daemon takes a password", () => {
    expect(passwordLoginReading(probe({ passwordAuthentication: "yes", kbdInteractiveAuthentication: "yes" }), META).state).toBe("on");
  });

  it("reads unreadable when the daemon would not print its configuration at all", () => {
    const r = passwordLoginReading({ readable: false, passwordAuthentication: null, kbdInteractiveAuthentication: null, pubkeyAuthentication: null }, META);
    expect(r.state).toBe("unreadable");
    expect(r.doc.passwordAuthentication).toBeNull();
  });

  it("reads unreadable when the one keyword the state is about was absent from the printout", () => {
    expect(passwordLoginReading(probe({ passwordAuthentication: null }), META).state).toBe("unreadable");
  });

  it("falls to ON, never off, when the second keyword is absent — an unmeasured door is not a shut one", () => {
    expect(passwordLoginReading(probe({ kbdInteractiveAuthentication: null }), META).state).toBe("on");
  });

  it("carries pubkeyauthentication through whatever the other two say — it is what says the host is reachable", () => {
    expect(passwordLoginReading(probe({ pubkeyAuthentication: "no" }), META).doc.pubkeyAuthentication).toBe("no");
  });
});

describe("readServerPasswordLogin — a stored document is narrowed on its version before it is trusted", () => {
  const v0 = {
    v: 0, observedAt: META.observedAt, runId: "run_abc",
    passwordAuthentication: "no", kbdInteractiveAuthentication: "no", pubkeyAuthentication: "yes",
  };

  it("parses a v0 document", () => {
    const read = readServerPasswordLogin(v0);
    expect(read.kind).toBe("v0");
    expect(read.kind === "v0" && read.facts.passwordAuthentication).toBe("no");
  });

  it("answers 'none' for a row nothing has written", () => {
    expect(readServerPasswordLogin(null).kind).toBe("none");
    expect(readServerPasswordLogin(undefined).kind).toBe("none");
  });

  it("answers 'unsupported' for a version this build does not read, instead of calling it corrupt", () => {
    const read = readServerPasswordLogin({ ...v0, v: 1 });
    expect(read.kind === "unsupported" && read.v).toBe(1);
  });

  it("answers 'unreadable' with the reason for a v0 body that fails its schema", () => {
    const read = readServerPasswordLogin({ ...v0, observedAt: "yesterday" });
    expect(read.kind).toBe("unreadable");
    expect(read.kind === "unreadable" && read.reason).toContain("observedAt");
  });

  it("answers 'unreadable' for a document with no version field at all", () => {
    expect(readServerPasswordLogin({ passwordAuthentication: "no" })).toEqual({ kind: "unreadable", reason: "no version field" });
  });
});
