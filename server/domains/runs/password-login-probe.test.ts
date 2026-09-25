import { describe, it, expect } from "vitest";
import { parsePasswordLoginProbe, PASSWORD_LOGIN_PROBE_SCRIPT, SSHD_HELPERS } from "./password-login-probe.ts";
import { passwordLoginReading } from "../../../shared/password-login.ts";

const meta = { runId: "run_abc", observedAt: 1_700_000_000_000 };
const state = (stdout: string): string => passwordLoginReading(parsePasswordLoginProbe(stdout), meta).state;

// What the probe prints on each kind of host, and the state that follows from it. These pin the one
// property the whole surface rests on: an absence the run MEASURED is told apart from an absence
// the run could not measure — a daemon that would not answer must never read as a shut door.
describe("parsePasswordLoginProbe — an empty value is an absent fact, not a false one", () => {
  it("a daemon that takes a password reads 'on' and keeps the words it printed", () => {
    const out = ["SSHD effective readable", "SSHD password yes", "SSHD keyboard yes", "SSHD pubkey yes"].join("\n");
    const probe = parsePasswordLoginProbe(out);
    expect(passwordLoginReading(probe, meta).state).toBe("on");
    expect(probe.passwordAuthentication).toBe("yes");
    expect(probe.pubkeyAuthentication).toBe("yes");
  });

  it("a key-only daemon reads 'off'", () => {
    expect(state(["SSHD effective readable", "SSHD password no", "SSHD keyboard no", "SSHD pubkey yes"].join("\n"))).toBe("off");
  });

  it("a daemon that would not print its configuration reads 'unreadable', never 'off'", () => {
    expect(state("SSHD effective unreadable")).toBe("unreadable");
    expect(parsePasswordLoginProbe("SSHD effective unreadable").readable).toBe(false);
  });

  it("a line with an empty value is an ABSENT key, the same as a branch that never ran", () => {
    // The script prints `SSHD password ` when the awk match produced nothing; that matches no
    // `SSHD <key> <value>` pair, so it lands here as absent rather than as an empty string.
    const probe = parsePasswordLoginProbe(["SSHD effective readable", "SSHD password ", "SSHD keyboard "].join("\n"));
    expect(probe.readable).toBe(true);
    expect(probe.passwordAuthentication).toBeNull();
    // Readable, but the one keyword the state is about was never printed — so nothing is claimed.
    expect(passwordLoginReading(probe, meta).state).toBe("unreadable");
  });

  it("ignores anything that is not one of its own lines", () => {
    const out = ["some other command's output", "SSHD effective readable", "SSHD password no", "SSHD keyboard no", "SSHD pubkey yes", ""].join("\n");
    expect(state(out)).toBe("off");
  });
});

describe("the probe script itself", () => {
  it("reads the DAEMON and no file at all", () => {
    // The whole reason this pair exists: a drop-in can say `PasswordAuthentication no` while the
    // daemon answers `yes`. A probe that grepped a file would confirm the lie.
    expect(SSHD_HELPERS).toContain('effective() { as_root "$(sshd_bin)" -T; }');
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).toContain(SSHD_HELPERS);
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).not.toContain("sshd_config");
  });

  it("exits 0 on every path, so a failed probe means the reading never happened", () => {
    // recordPasswordLoginReading keeps the stored reading on a non-zero exit rather than replacing
    // a measurement with a guess, which only works if the script never fails for a fact it found.
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).toContain("exit 0");
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).not.toContain("set -e");
  });

  it("reads BOTH password keywords, because keyboard-interactive is the same door through PAM", () => {
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).toContain("passwordauthentication");
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).toContain("kbdinteractiveauthentication");
    // OpenSSH 8.7 renamed that keyword. An 8.2 daemon (Ubuntu 20.04, which the preflight only warns
    // about, and the seeded master row, which is never preflighted) prints the old name and no
    // kbdinteractive line at all, so reading one name alone would report a shut door as open.
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).toContain("challengeresponseauthentication");
    // And the key door, which is what says the host is reachable at all.
    expect(PASSWORD_LOGIN_PROBE_SCRIPT).toContain("pubkeyauthentication");
    // Both spellings print the SAME `SSHD keyboard` line, so nothing downstream has to know which
    // OpenSSH answered.
    expect([...PASSWORD_LOGIN_PROBE_SCRIPT.matchAll(/print "SSHD keyboard "/g)].length).toBe(2);
  });
});
