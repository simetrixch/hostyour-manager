import { describe, it, expect } from "vitest";
import {
  authorizedKeysHold, authorizedKeysReading, classifyAuthorizedKey, managerKeyMarker, isAuthorizedKeysEntry,
  isOperatorKeyLabel, normalizeOperatorPublicKey, operatorKeyLine, operatorKeyMarker, OPERATOR_MARKER_PREFIX,
  parseAuthorizedKeysLine, readServerAuthorizedKeys,
} from "./operator-keys.ts";
import type { AuthorizedKeyFact } from "./api-types.ts";

// The two properties this file exists for.
//
//   THE MARKERS CANNOT REACH EACH OTHER. Removing an operator's key must never strip the line this
//   manager logs in with, and the adoption's own cleanup must never strip a human's key. Both
//   directions are asserted, and the pattern anchoring is asserted with them — an unanchored match
//   on "pat" would take "pat-laptop" off the host too.
//
//   A LINE IS READ THE WAY sshd READS IT. An authorized_keys entry may carry an options prefix, and
//   the naive "second field is the blob" split fingerprints the string "ssh-ed25519" for such a
//   line — reporting a key that is not there and missing the one that is.

const BLOB_A = "AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKeyOneAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BLOB_B = "AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKeyTwoBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** The POSIX pattern the removal ships, translated to the one JavaScript understands: `[[:space:]]`
 *  is `\s` and everything else is literal. What is under test is the ANCHORING and the marker, both
 *  of which survive the translation unchanged. */
function removalRegex(label: string): RegExp {
  return new RegExp(`\\s${operatorKeyMarker(label)}\\s*$`);
}

describe("the two markers", () => {
  it("cannot match one another, in either direction", () => {
    const manager = managerKeyMarker("s1");
    const operator = operatorKeyMarker("s1");
    // The manager marker is `hostyour` and then a colon; the operator marker puts
    // `-operator` in between, so that substring never occurs in it.
    expect(operator.includes("hostyour:")).toBe(false);
    expect(manager.includes(OPERATOR_MARKER_PREFIX)).toBe(false);
    // The pattern adopt's cleanup deletes by is the manager marker as a plain substring.
    const managerLine = `ssh-ed25519 ${BLOB_A} ${manager}`;
    const operatorLine = operatorKeyLine(`ssh-ed25519 ${BLOB_B}`, "s1");
    expect(operatorLine.includes(manager)).toBe(false);
    expect(removalRegex("s1").test(managerLine)).toBe(false);
    expect(removalRegex("s1").test(operatorLine)).toBe(true);
  });

  it("anchors at the end of the line, so one label never takes another's key off", () => {
    const line = operatorKeyLine(`ssh-ed25519 ${BLOB_A}`, "pat-laptop");
    // Unanchored, "pat" matches the start of "pat-laptop" and removes a key nobody asked about.
    expect(removalRegex("pat").test(line)).toBe(false);
    expect(removalRegex("pat-laptop").test(line)).toBe(true);
  });

  it("takes only a label that cannot widen the pattern it is interpolated into", () => {
    for (const good of ["pat", "pat-laptop", "a", "0", "x9-y"]) expect(isOperatorKeyLabel(good)).toBe(true);
    // A metacharacter would change what the removal matches; a colon, a space or an upper-case
    // letter would change which marker the comment reads as.
    for (const bad of ["", "Pat", "pat laptop", "pat.*", "pat$", "-pat", "a:b", "pat/../x", "pat'", "a".repeat(64)]) {
      expect(isOperatorKeyLabel(bad), bad).toBe(false);
    }
  });
});

describe("reading one authorized_keys line", () => {
  it("finds the key by SHAPE, so an options prefix does not shift the blob", () => {
    const parsed = parseAuthorizedKeysLine(`command="/bin/true",no-pty ssh-ed25519 ${BLOB_A} pat@example.com`);
    expect(parsed).toEqual({ type: "ssh-ed25519", blob: BLOB_A, comment: "pat@example.com" });
  });

  it("goes PAST a field that only looks like a type — the key sits after it and sshd uses it", () => {
    // An options value may contain the words themselves. Stopping at the first match reports this
    // line as unreadable while the key on it goes on authenticating.
    const parsed = parseAuthorizedKeysLine(`command="echo ssh-ed25519 denied" ssh-ed25519 ${BLOB_A} x`);
    expect(parsed).toEqual({ type: "ssh-ed25519", blob: BLOB_A, comment: "x" });
  });

  it("keeps a comment with spaces whole, and reports an absent one as empty", () => {
    expect(parseAuthorizedKeysLine(`ssh-rsa ${BLOB_A} pat on the old laptop`)?.comment).toBe("pat on the old laptop");
    expect(parseAuthorizedKeysLine(`ssh-ed25519 ${BLOB_A}`)?.comment).toBe("");
  });

  it("is not a key line when there is no key on it", () => {
    for (const line of ["", "   ", "# a comment", "ssh-ed25519", `ssh-ed25519 short`, "just some text"]) {
      expect(parseAuthorizedKeysLine(line), line).toBeNull();
    }
  });

  it("tells blank and #-comment lines apart from a broken key line", () => {
    // The first two are nothing at all; the third is a line sshd would look at and reject, which is
    // what the reading counts as unparsed.
    expect(isAuthorizedKeysEntry("")).toBe(false);
    expect(isAuthorizedKeysEntry("  # nothing here")).toBe(false);
    expect(isAuthorizedKeysEntry("ssh-ed25519 truncated")).toBe(true);
  });
});

describe("normalizing a pasted operator key", () => {
  it("drops the operator's own comment, because the placed line's comment is the marker", () => {
    expect(normalizeOperatorPublicKey(`  ssh-ed25519 ${BLOB_A} pat@example.com\n`))
      .toEqual({ publicKey: `ssh-ed25519 ${BLOB_A}`, type: "ssh-ed25519" });
    expect(operatorKeyLine(`ssh-ed25519 ${BLOB_A}`, "pat")).toBe(`ssh-ed25519 ${BLOB_A} hostyour-operator:pat`);
  });

  it("refuses anything that is not exactly one key", () => {
    expect(normalizeOperatorPublicKey("")).toBeNull();
    expect(normalizeOperatorPublicKey("not a key")).toBeNull();
    // A whole authorized_keys file pasted in: two keys under one label would make the label mean
    // two lines, and a removal would take off whichever the file happened to hold.
    expect(normalizeOperatorPublicKey(`ssh-ed25519 ${BLOB_A}\nssh-ed25519 ${BLOB_B}`)).toBeNull();
  });
});

describe("classifying a key line", () => {
  const ctx = {
    managerFingerprints: ["SHA256:mine"],
    operatorKeys: [{ label: "pat", fingerprint: "SHA256:pat" }],
    // classifyAuthorizedKey does not read this field, and that is the point of stating it: the
    // classification must never vouch for a line merely because its comment equals the marker, and a
    // fixture without the field would let such a branch land — by a merge, a revert, an edit — with
    // the stranger case below still green, because `comment === undefined` is false for every real
    // comment. With the marker present, such a branch fails that case loudly.
    managerMarker: managerKeyMarker("s1"),
  };

  it("knows this manager's own key by its FINGERPRINT alone — the comment is not consulted", () => {
    // The sealed fingerprint covers both roads a manager key takes onto a host: adopt seals the
    // key it generates before installing the line (which then carries the marker), and the boot
    // seed seals the master's, whose line carries whatever comment it was generated with.
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:mine", comment: managerKeyMarker("s1") }, ctx).kind).toBe("manager");
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:mine", comment: "root@buildbox" }, ctx).kind).toBe("manager");
  });

  it("calls a stranger's key that only WEARS the manager marker foreign", () => {
    // Anyone with a shell can append `ssh-ed25519 <their key> hostyour:s1` to the file. If the
    // marker comment could vouch for a line, that key would read "manager", the file would fold
    // to "accounted", and a working way into the machine would hide behind the card built to
    // surface it.
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:theirs", comment: managerKeyMarker("s1") }, ctx).kind).toBe("foreign");
  });

  it("names the label an operator line was placed under", () => {
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:pat", comment: operatorKeyMarker("pat") }, ctx))
      .toEqual({ kind: "operator", label: "pat" });
  });

  it("takes the marker AND the stored key, so nobody appoints themselves an operator by comment", () => {
    // The comment is text on the machine and anyone who can append to authorized_keys can type it.
    // A stranger's key under a marker naming a label this manager does not hold, and one under a
    // label it does hold but with a different key, are both keys nothing here placed.
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:theirs", comment: operatorKeyMarker("ops") }, ctx).kind).toBe("foreign");
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:theirs", comment: operatorKeyMarker("pat") }, ctx).kind).toBe("foreign");
    // And a manager holding no operator key at all reads every marker line as foreign, which is
    // the truth about such a host.
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:pat", comment: operatorKeyMarker("pat") }, { ...ctx, operatorKeys: [] }).kind)
      .toBe("foreign");
  });

  it("calls a comment that imitates the marker foreign — no row can carry that label", () => {
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:pat", comment: `${OPERATOR_MARKER_PREFIX}Pat Smith` }, ctx).kind).toBe("foreign");
  });

  it("calls everything else foreign — an image's provisioning key is exactly this case", () => {
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:x", comment: "" }, ctx)).toEqual({ kind: "foreign", label: null });
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:x", comment: "someone@hetzner" }, ctx).kind).toBe("foreign");
    // The operator's own key under their own hand-written comment: known key, line nothing here
    // wrote, and no removal by marker reaches it.
    expect(classifyAuthorizedKey({ fingerprint: "SHA256:pat", comment: "pat@laptop" }, ctx).kind).toBe("foreign");
  });
});

describe("folding a probe into the stored pair", () => {
  const key = (kind: AuthorizedKeyFact["kind"], fingerprint = "SHA256:k"): AuthorizedKeyFact =>
    ({ fingerprint, type: "ssh-ed25519", comment: "", kind, label: null });
  const meta = { runId: "run_1", observedAt: 1_700_000_000_000 };

  it("claims accounted only when the file was READ and every line is one we can name", () => {
    expect(authorizedKeysReading({ readable: true, keys: [key("manager"), key("operator")], unparsed: 0 }, meta).state)
      .toBe("accounted");
    expect(authorizedKeysReading({ readable: true, keys: [], unparsed: 0 }, meta).state).toBe("accounted");
  });

  it("falls to unreadable, never to accounted, when the file could not be opened", () => {
    // An unread file is not a clean one — the direction a security surface has to fall in.
    expect(authorizedKeysReading({ readable: false, keys: [], unparsed: 0 }, meta).state).toBe("unreadable");
  });

  it("says unaccounted the moment ONE line was placed by nothing here", () => {
    expect(authorizedKeysReading({ readable: true, keys: [key("manager"), key("foreign")], unparsed: 0 }, meta).state)
      .toBe("unaccounted");
  });

  it("says unaccounted for a line it could not read either — the two parsers are not the same one", () => {
    // sshd may well authenticate somebody with a line this build cannot read (a certificate, a key
    // type it never heard of), so a line nobody here can name is the opposite of accounted.
    const out = authorizedKeysReading({ readable: true, keys: [key("manager")], unparsed: 2 }, meta);
    expect(out.state).toBe("unaccounted");
    expect(out.doc).toMatchObject({ v: 0, runId: "run_1", observedAt: meta.observedAt, unparsed: 2 });
  });

  it("answers whether a fingerprint is held only from a reading it could actually parse", () => {
    const doc = authorizedKeysReading({ readable: true, keys: [key("operator", "SHA256:pat")], unparsed: 0 }, meta).doc;
    expect(authorizedKeysHold(readServerAuthorizedKeys(doc), "SHA256:pat")).toBe(true);
    expect(authorizedKeysHold(readServerAuthorizedKeys(doc), "SHA256:someone-else")).toBe(false);
    expect(authorizedKeysHold({ kind: "none" }, "SHA256:pat")).toBe(false);
  });
});

describe("the version-narrowing reader", () => {
  const v0 = {
    v: 0, observedAt: 1_700_000_000_000, runId: "run_1", unparsed: 0,
    keys: [{ fingerprint: "SHA256:k", type: "ssh-ed25519", comment: "", kind: "manager", label: null }],
  };

  it("names all four outcomes instead of collapsing three of them to null", () => {
    expect(readServerAuthorizedKeys(null)).toEqual({ kind: "none" });
    expect(readServerAuthorizedKeys(undefined)).toEqual({ kind: "none" });
    expect(readServerAuthorizedKeys(v0)).toEqual({ kind: "v0", facts: v0 });
    expect(readServerAuthorizedKeys({ v: 1, whatever: true })).toEqual({ kind: "unsupported", v: 1 });
    expect(readServerAuthorizedKeys({ nope: true })).toMatchObject({ kind: "unreadable" });
  });

  it("reads the version BEFORE the body, so a v1 document is unsupported and not corrupt", () => {
    // A future shape must be answerable as "this build does not read that", never as a schema
    // failure the card would render as damage.
    expect(readServerAuthorizedKeys({ v: 1, keys: "something else entirely" })).toEqual({ kind: "unsupported", v: 1 });
    expect(readServerAuthorizedKeys({ ...v0, keys: [{ fingerprint: "x" }] })).toMatchObject({ kind: "unreadable" });
  });
});
