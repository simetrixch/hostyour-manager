import { ALREADY_SHUT } from "./defs/password-login.kit.ts";
import { managerKeyMarker } from "../../../shared/operator-keys.ts";

/** What the comment on every line `install-key` appends begins with — the marker, before the name of
 *  the machine the key belongs to. Taken from the one place that composes it, so a machine here can
 *  never judge a key by a spelling this manager has stopped writing. */
const MANAGER_KEY_COMMENT = managerKeyMarker("");

// THE SCRIPTED MACHINE'S FIRST-CONTACT HALF: what it answers when it is asked which account this
// manager logs in as, what stands in that account's authorized_keys, whether it synchronises its
// clock, whether it still carries the standing passwordless-root grant, and what its daemon says
// about the password door. It reads and writes the SAME script object the rest of the scripted
// machine does — a machine with two states would let one act leave the other behind.
//
// EVERY ANSWER IS MACHINE STATE AND NOT A CANNED REPLY, which is the whole of what makes this
// fixture able to judge the steps it answers. The first-contact steps are written measure-then-act
// (defs/manager-key.kit.ts): each reads what the machine holds and each act changes it, so a second
// pass of the same list is answered by what the first pass left. A fixture that replied the same way
// twice would agree with a step that writes every time and with a step that measures first, and the
// property those steps exist for would be untestable here.

/** The key whoever ordered the machine put in its image — the normal state of a fresh cloud server,
 *  and a working way in no run kind of this manager's can remove. It sits in the scripted machine's
 *  authorized_keys from the start, so the reading `install-key` takes has something to report as
 *  foreign: a machine deployed by this manager and never looked at is exactly where such a key goes
 *  unseen. Nothing classifies it by its comment — the reading fingerprints every line and knows this
 *  manager's own by the fingerprints it has sealed.
 *
 *  The blob is the length a real one is, because a shorter one is not a key line at all to that
 *  reading (shared/operator-keys.ts BLOB_RE) and would be counted as a line nobody could read. */
export const IMAGE_KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICloudImageKeyAAAAAAAAAAAAAAAAAAAA someone@example.com";

/** What the scripted machine holds that first contact measures and writes. */
export interface FirstContactScript {
  /** WHETHER THIS MACHINE CARRIES THE STANDING SUDOERS DROP-IN (defs/manager-key.kit.ts
   *  SUDOERS_DROP_IN) — a standing passwordless-root grant for the account this manager logs in as,
   *  and the file `remove-sudoers` really takes off it.
   *
   *  IT DEFAULTS TO `false`, the machine that grants NOTHING without a password. That is what a
   *  first master installed by hostyour-cloud lifecycle/install-machine really is (measured on one on
   *  2026-08-27: a README in /etc/sudoers.d/ and no rule), and it is what every machine a deployment touches is left as —
   *  so a run proven here works on both, and a step that reaches for a standing rule is refused here
   *  instead of months later on somebody's machine. `true` is the machine an OLDER install left the
   *  file on, which is the only reason `remove-sudoers` has anything to remove; no step and no
   *  compensation of this manager's needs it, because every one of them raises its own commands.
   *
   *  A `sudo -S` is answered on either machine, and only when the elevation password really rode on
   *  standard input: what authenticates the account is the password the RUN carries, so a step that
   *  composed the elevation and did not hand the password through is loud here rather than green
   *  here and refused on a real host. */
  adopted: boolean;
  /** WHAT `id -u` ANSWERS for the account this manager logs in as. The default is an ordinary
   *  unprivileged account, which is the machine Servers.tsx calls the normal one and the whole
   *  reason `prove-elevation` exists — `"0"` is the machine whose login IS root, where that step
   *  writes nothing and raises nothing. */
  loginUid: string;
  /** `~/.ssh/authorized_keys` of that account, line by line, or `undefined` for a machine that keeps
   *  no such file at all. `install-key` decides two writes off this — the directory and file being
   *  created, and the append — and the reading right after it is taken from the same lines, so a run
   *  that appended nothing is answered by a file that gained nothing. */
  authorizedKeys: string[] | undefined;
  /** WHETHER THIS MACHINE JUDGES THE KEY A SESSION OFFERS, against the very lines above. `true` is a
   *  real sshd: it refuses every key while no line of this manager's stands in that file, and takes
   *  one the moment `install-key` appends it. That is the machine a reinstall at the hosting provider
   *  hands back — its cluster row still active, this manager's key gone from it — and it is the only
   *  shape in which `openDoor` has anything to decide (defs/manager-key.kit.ts).
   *
   *  `false` is a machine that answers whatever session is opened to it, and it is the default for
   *  the fixture's sake rather than the machine's: most worlds here seal a key credential for a
   *  machine whose file carries no matching line, and a judging one would refuse the FIRST session of
   *  every run kind those worlds drive, on a fact none of them is about. */
  judgesKeys: boolean;
  /** What `timedatectl show -p NTP --value` answers, or `undefined` for a machine that has no
   *  timedatectl at all — the box `enable-ntp` reports as unmeasurable instead of failing the run. */
  ntp: "yes" | "no" | undefined;
  /** What `sshd -T` says about the password door — what the probe reads back and what the disable
   *  act changes. A machine already answering `no` here is answered as one this platform's own
   *  drop-in already states, so the act writes nothing and reloads nothing; the real script settles
   *  that by comparing the drop-in's bytes as well, and only a machine can hold it to that.
   *
   *  The default is a daemon that takes a password from anyone who can reach port 22 — a fresh cloud
   *  image, and the door a deployment shuts. */
  passwordLogin: "yes" | "no";
}

/** The elevation password every approve in these suites carries, and the ONE the scripted machine
 *  answers a `sudo -S` for. Written down once because two values would let a call site hand the
 *  wrong buffer through and still be answered; deliberately unmistakable because the suites also
 *  assert it appears in no command line and in no file the machine was written, and a value that
 *  could occur by accident would make those assertions weaker than they read. */
export const ELEVATION_PASSWORD = "elevation-password-SECRET-0007";

/** HOW THIS MACHINE ANSWERS A ROOT COMMAND: the stderr line it refuses one with, or `undefined`
 *  where it does not refuse. Asked with `includes` and not `startsWith`, because a `sudo -n` can
 *  stand inside a compound line and the machine judges it there just the same.
 *
 *  A `sudo -S` is answered on any machine, and only when the elevation password really rode on
 *  standard input — what authenticates the account is the password the RUN carries, so a step that
 *  composed the elevation and did not hand the password through is loud here rather than green here
 *  and refused on a real host. THE FIRST LINE AND ONLY THE FIRST LINE is compared: `sudo -S` reads
 *  the password up to the first newline and hands everything after it to the command it raises,
 *  which is how a value reaches a root-owned file without standing in an argument list every account
 *  on the machine could read. Demanding that nothing follows would refuse that one shape.
 *
 *  A `sudo -n` is answered only where the machine carries the standing grant, which is what
 *  `adopted` says and what `remove-sudoers` takes away. NOTHING THIS MANAGER SENDS TAKES THAT FORM
 *  any more — the refusal stays because it is what catches a step that reaches for one: the source
 *  census (elevation.test.ts) says none is written, and this says none would be answered. */
export function answerRootCommand(f: FirstContactScript, command: string, stdin?: Buffer): string | undefined {
  if (command.includes("sudo -S ")) {
    if (!stdin?.toString("utf8").startsWith(`${ELEVATION_PASSWORD}\n`)) {
      throw new Error(`sudo -S shipped without the run's elevation password on stdin: ${command}`);
    }
    return undefined;
  }
  if (command.includes("sudo -n ") && !f.adopted) return "sudo: interactive authentication is required";
  return undefined;
}

/** A machine nothing of this platform has touched: an unprivileged login, the image's own key in
 *  authorized_keys, a clock nobody set to synchronise, a door open to any password, and no standing
 *  grant of this manager's. Every world the suites build starts here and overrides what differs. */
export function firstContactDefaults(): FirstContactScript {
  return {
    adopted: false,
    loginUid: "1000",
    authorizedKeys: [IMAGE_KEY_LINE],
    judgesKeys: false,
    ntp: "no",
    passwordLogin: "yes",
  };
}

/** WHETHER A KEY SESSION OPENS ON THIS MACHINE — the first thing `openDoor` finds out, and the
 *  machine answers it out of the same file every act above reads and writes, so a run that has just
 *  appended the line is let in by what it wrote.
 *
 *  A LINE IS THIS MANAGER'S BY ITS COMMENT AND BY NOTHING ELSE, which is the rule the machine and
 *  this manager both go by: `install-key` writes that marker and the removal deletes by it
 *  (shared/operator-keys.ts). So the image's own key is no way in for this manager, and neither is an
 *  operator's — whose marker carries `-operator` before the colon and can therefore never be read as
 *  this one. */
export function takesManagerKey(f: FirstContactScript): boolean {
  return f.judgesKeys ? (f.authorizedKeys ?? []).some((line) => line.includes(MANAGER_KEY_COMMENT)) : true;
}

/** What the scripted machine answers one first-contact command with, or `undefined` where the
 *  command is none of its business and the caller goes on matching.
 *
 *  `bash /tmp/dc-<name>-` and NOT the bare name, because every remoteScript send is followed by an
 *  `rm -f` of the same path: answering that as a second run of the act would let a step appear to
 *  have acted twice, and the acts below change the machine. */
export function answerFirstContactCommand(
  f: FirstContactScript,
  command: string,
): { out: string; code: number } | undefined {
  const ran = (name: string): boolean => command.includes(`bash /tmp/dc-${name}-`);
  const ok = (out = ""): { out: string; code: number } => ({ out, code: 0 });

  // ---- prove-elevation: the account, and the account raised.
  if (command === "id -u") return ok(f.loginUid);
  if (command === "sudo -S -p '' -- /usr/bin/id -u") return ok("0");

  // ---- install-key: two measurements, each deciding one write, and the reading after them.
  if (command === "test -f ~/.ssh/authorized_keys") return { out: "", code: f.authorizedKeys === undefined ? 1 : 0 };
  if (command.startsWith("mkdir -p ~/.ssh")) {
    f.authorizedKeys = [];
    return ok();
  }
  const grepped = /^grep -qF '([^']+)' ~\/\.ssh\/authorized_keys$/.exec(command)?.[1];
  if (grepped !== undefined) return { out: "", code: f.authorizedKeys?.includes(grepped) ? 0 : 1 };
  const appended = /^echo '([^']+)' >> ~\/\.ssh\/authorized_keys$/.exec(command)?.[1];
  if (appended !== undefined) {
    f.authorizedKeys = [...(f.authorizedKeys ?? []), appended];
    return ok();
  }
  // The compensation's own edit, by the marker this manager's key line carries and by nothing else.
  const dropped = /^sed -i '\\#([^#]+)#d' ~\/\.ssh\/authorized_keys$/.exec(command)?.[1];
  if (dropped !== undefined) {
    f.authorizedKeys = (f.authorizedKeys ?? []).filter((l) => !l.includes(dropped));
    return ok();
  }
  if (ran("authorized-keys-probe")) {
    return ok(f.authorizedKeys === undefined
      ? "AKEYS unreadable"
      : ["AKEYS readable", ...f.authorizedKeys.map((l) => `AKEY ${l}`)].join("\n"));
  }

  // ---- enable-ntp: a machine with no timedatectl answers nothing readable, which is the box that
  // step reports as unmeasurable rather than failing the run on.
  if (command === "timedatectl show -p NTP --value") {
    if (f.ntp === undefined) return { out: "", code: 1 };
    return ok(f.ntp);
  }
  if (command === "sudo -S -p '' timedatectl set-ntp true") {
    f.ntp = "yes";
    return ok();
  }

  // ---- remove-sudoers: the verdict arrives as a word, because the measurement is raised too and an
  // exit code could not tell a file that is not there from a question that was refused.
  if (ran("remove-sudoers")) {
    if (!f.adopted) return ok("SUDOERS absent");
    f.adopted = false;
    return ok("SUDOERS removed");
  }

  // ---- the password door: the daemon's own answer, the act that shuts it, and the compensation
  // that opens it again.
  if (ran("password-login-probe")) {
    return ok(["SSHD effective readable", `SSHD password ${f.passwordLogin}`, `SSHD keyboard ${f.passwordLogin}`, "SSHD pubkey yes"].join("\n"));
  }
  if (ran("cluster-password-login-disable")) {
    if (f.passwordLogin === "no") return ok(`${ALREADY_SHUT}: the daemon takes neither password nor keyboard-interactive`);
    f.passwordLogin = "no";
    return ok("password login is off; key login is on");
  }
  if (ran("cluster-password-login-enable")) {
    f.passwordLogin = "yes";
    return ok("password login is on");
  }
  return undefined;
}
