import { describe, it, expect } from "vitest";
import { AUTHORIZED_KEYS_PROBE_SCRIPT, parseAuthorizedKeysProbe } from "./operator-keys-probe.ts";
import { controllerKeyMarker, operatorKeyMarker } from "../../../shared/operator-keys.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";

// The probe and its parser, tested apart from any run: the script's own properties (it names one
// file, it never escalates, and every path exits 0), and the console-side reading of what it prints.

const BLOB_MINE = "AAAAC3NzaC1lZDI1NTE5AAAAIControllerOwnKeyAAAAAAAAAAAAAAAAAAAAAAAA";
const BLOB_PAT = "AAAAC3NzaC1lZDI1NTE5AAAAIOperatorPatKeyAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BLOB_HETZ = "AAAAC3NzaC1lZDI1NTE5AAAAICloudImageKeyAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const CTX = {
  controllerFingerprints: [fingerprintPublicKey(`ssh-ed25519 ${BLOB_MINE}`)],
  // The operator keys this controller holds. A line reads as an operator's only when its
  // fingerprint is the one stored under the label its comment names.
  operatorKeys: [{ label: "pat", fingerprint: fingerprintPublicKey(`ssh-ed25519 ${BLOB_PAT}`) }],
  // The parser does not read this field, and states it anyway. The classification this reading
  // dropped vouched for any line whose comment equalled the marker; restoring that branch (a merge,
  // a revert) against a fixture WITHOUT the marker compares `comment === undefined`, so the
  // stranger's marked key below would still read foreign and the case would prove nothing. With the
  // marker here, the restored branch fails it.
  controllerMarker: controllerKeyMarker("s1"),
};

const out = (...lines: string[]): string => ["AKEYS readable", ...lines.map((l) => `AKEY ${l}`)].join("\n");

describe("the authorized-keys probe script", () => {
  it("reads ONE file and names it once — the login user's own", () => {
    // Not /root's, not another user's: this session authenticated as the login user, and the only
    // file that decides whether that login works is theirs.
    expect(AUTHORIZED_KEYS_PROBE_SCRIPT).toContain('ak="$HOME/.ssh/authorized_keys"');
    expect([...AUTHORIZED_KEYS_PROBE_SCRIPT.matchAll(/authorized_keys/g)]).toHaveLength(1);
  });

  it("never escalates — a probe that read a file the login would not use describes nothing", () => {
    expect(AUTHORIZED_KEYS_PROBE_SCRIPT).not.toContain("sudo");
  });

  it("exits 0 on every path, so an unreadable file is a READING and not a failed step", () => {
    expect([...AUTHORIZED_KEYS_PROBE_SCRIPT.matchAll(/^\s*exit \d+$/gm)].map((m) => m[0].trim())).toEqual(["exit 0", "exit 0"]);
    expect(AUTHORIZED_KEYS_PROBE_SCRIPT).toContain('echo "AKEYS unreadable"');
    // No `set -e`: a single failing command inside the loop must not turn a partial reading into a
    // non-zero exit, which the recorder would treat as "nothing was measured".
    expect(AUTHORIZED_KEYS_PROBE_SCRIPT).not.toContain("set -e");
  });

  it("keeps a final line that has no newline after it", () => {
    // Hand-edited authorized_keys files routinely end without one, and a dropped last line is a key
    // nobody would ever be shown.
    expect(AUTHORIZED_KEYS_PROBE_SCRIPT).toContain('while IFS= read -r line || [ -n "$line" ]; do');
  });
});

describe("parsing what the probe printed", () => {
  it("classifies the three origins a real file mixes", () => {
    const probe = parseAuthorizedKeysProbe(out(
      `ssh-ed25519 ${BLOB_MINE} ${controllerKeyMarker("s1")}`,
      `ssh-ed25519 ${BLOB_PAT} ${operatorKeyMarker("pat")}`,
      `ssh-ed25519 ${BLOB_HETZ} someone@hetzner`,
    ), CTX);
    expect(probe.readable).toBe(true);
    expect(probe.keys.map((k) => k.kind)).toEqual(["controller", "operator", "foreign"]);
    expect(probe.keys[1]?.label).toBe("pat");
    expect(probe.keys[2]?.comment).toBe("someone@hetzner");
    expect(probe.unparsed).toBe(0);
  });

  it("reads a stranger's key wearing the CONTROLLER marker as foreign — only the sealed fingerprint vouches", () => {
    const probe = parseAuthorizedKeysProbe(out(`ssh-ed25519 ${BLOB_HETZ} ${controllerKeyMarker("s1")}`), CTX);
    expect(probe.keys[0]?.kind).toBe("foreign");
  });

  it("fingerprints exactly what ssh-keygen -lf would, so an operator can cross-check on the box", () => {
    const probe = parseAuthorizedKeysProbe(out(`ssh-ed25519 ${BLOB_PAT} ${operatorKeyMarker("pat")}`), CTX);
    expect(probe.keys[0]?.fingerprint).toBe(fingerprintPublicKey(`ssh-ed25519 ${BLOB_PAT}`));
    expect(probe.keys[0]?.fingerprint.startsWith("SHA256:")).toBe(true);
  });

  it("fingerprints the KEY and not the comment, so the same key under two comments is one key", () => {
    const a = parseAuthorizedKeysProbe(out(`ssh-ed25519 ${BLOB_PAT} ${operatorKeyMarker("pat")}`), CTX);
    const b = parseAuthorizedKeysProbe(out(`ssh-ed25519 ${BLOB_PAT} pat@somewhere-else`), CTX);
    expect(a.keys[0]?.fingerprint).toBe(b.keys[0]?.fingerprint);
    // Same key, and still foreign: the marker is what a removal deletes by, and this line has none.
    expect(b.keys[0]?.kind).toBe("foreign");
  });

  it("reads a stranger's key under the marker as foreign — the comment is text on the machine", () => {
    // Anyone who can append to authorized_keys can type `hostyour-operator:<anything>`. Only
    // the fingerprint stored under that label makes the line one this platform placed.
    const probe = parseAuthorizedKeysProbe(out(
      `ssh-ed25519 ${BLOB_HETZ} ${operatorKeyMarker("ops")}`,
      `ssh-ed25519 ${BLOB_HETZ} ${operatorKeyMarker("pat")}`,
    ), CTX);
    expect(probe.keys.map((k) => k.kind)).toEqual(["foreign", "foreign"]);
    expect(probe.keys.map((k) => k.label)).toEqual([null, null]);
  });

  it("counts a line sshd would reject instead of dropping it", () => {
    const probe = parseAuthorizedKeysProbe(out("", "# an operator's note", "ssh-ed25519 truncated"), CTX);
    expect(probe.keys).toHaveLength(0);
    // Blank and #-comment lines are nothing at all; the broken key line is a fact about the file.
    expect(probe.unparsed).toBe(1);
  });

  it("reports an unreadable file as unmeasured rather than as an empty one", () => {
    const probe = parseAuthorizedKeysProbe("AKEYS unreadable", CTX);
    expect(probe).toEqual({ readable: false, keys: [], unparsed: 0 });
  });

  it("ignores whatever else the log carried — only its own lines are read", () => {
    const probe = parseAuthorizedKeysProbe(["Connecting to s1…", "AKEYS readable", `AKEY ssh-ed25519 ${BLOB_PAT}`, "done"].join("\n"), CTX);
    expect(probe.keys).toHaveLength(1);
    expect(probe.unparsed).toBe(0);
  });
});
