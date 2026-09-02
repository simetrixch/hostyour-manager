import type { Db } from "../../../db/client.ts";
import type { Cleanup, Plan, Step, StepCtx } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { remoteCmd, remoteScript } from "../../../executor/stepkit.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import { hasManagerKey, type RunKind } from "../../../../shared/enums.ts";
import { purgeBootstrapPassword } from "../../inventory/write.ts";
import { recordPasswordLoginReading, SSHD_HELPERS } from "../password-login-probe.ts";
import { loadServer } from "./deploy-slave.kit.ts";

// The shared half of the two password-login run kinds (defs/password-login.ts) and of the adoption step
// that shuts the door in the first place: the scripts they ship to a host, the steps they are
// composed of, and the one plan builder they state their target in.
//
// WHY THIS IS A RUN KIND AND NOT A CHECKBOX. Nothing this manager stores changes what a daemon
// answers on port 22. A switch that flipped a column would be the same shape as the file that
// caused this work — a thing that looks like protection, is inert, and stops the next reader
// looking. The switch is a run because only a run can write the drop-in, validate it, reload the
// daemon and read back what the daemon resolved.
//
// FOUR RULES EVERY SCRIPT BELOW KEEPS. The first is the one that goes wrong in practice; the other
// three are what keeps the act from producing a machine nobody can reach.
//   1. ONE drop-in, and it SORTS FIRST. sshd takes the FIRST occurrence of a keyword and reads
//      /etc/ssh/sshd_config.d in alphabetical order. A file named `99-disable-passwords.conf`,
//      saying `PasswordAuthentication no` on its face, therefore does nothing while
//      `50-cloud-init.conf` says `yes` before it — and it is worse than nothing, because the next
//      reader sees the filename and stops looking. A `00-` file wins over every drop-in in both
//      directions, including the one cloud-init rewrites on every boot, which is why the fix
//      belongs here rather than in editing cloud-init's file.
//   2. VALIDATE BEFORE RELOADING, and RELOAD rather than restart. `sshd -t` refuses a
//      configuration the daemon could not start on; reload re-reads the configuration and leaves
//      established sessions alone, so a mistake does not disconnect the operator — or this run —
//      mid-change.
//   3. THE VERDICT IS `sshd -T`, never the file just written. Only the daemon knows what every
//      Include and every ordering rule resolved to. A script that trusts its own write
//      reports success on exactly the host described above.
//   4. THE KEY DOOR IS PROVEN OPEN BEFORE THE PASSWORD DOOR SHUTS. A host that refuses both
//      answers nobody, and shutting the password door is the change that can produce that. Two
//      keywords decide it and both are read: `pubkeyauthentication`, and `authenticationmethods`,
//      which on a two-factor host names a password method a key alone cannot stand in for.
//
// The session survives the change: `systemctl reload` never drops an established connection, so
// the run goes on talking to the host it just reconfigured. That is what makes reading the result
// back part of the same step.

/** The ONE file this platform states the password door in, in both directions. The `00-` prefix is
 *  the whole point of the name: it is what makes the file sort — and therefore be read — before
 *  every other drop-in, including cloud-init's. */
export const DROP_IN = "/etc/ssh/sshd_config.d/00-hostyour-passwords.conf";

/** The two keywords that are the SAME door: sshd's own, and PAM's, which serves passwords through
 *  keyboard-interactive. Turning off only the first leaves the door open. */
function dropInContent(value: "yes" | "no"): string {
  return [
    "# Written by hostyour.",
    "# sshd takes the first occurrence of a keyword and reads this directory in alphabetical order,",
    "# so this file has to sort before every other drop-in to decide anything.",
    `PasswordAuthentication ${value}`,
    `KbdInteractiveAuthentication ${value}`,
    "",
  ].join("\n");
}

/** Read the daemon's own answer into `pw`, `kbd`, `pubkey` and `methods`. Returns non-zero when the
 *  configuration cannot be read at all, which every caller treats as a failure — an act that
 *  cannot check its own effect has not been performed.
 *
 *  `kbd` is matched under BOTH spellings. OpenSSH 8.7 renamed the dumped keyword: 8.6 and earlier
 *  print `challengeresponseauthentication` and no kbdinteractive line at all, so a host on
 *  OpenSSH 8.2 (Ubuntu 20.04, which the preflight only warns about, and the seeded master row,
 *  which is never preflighted) would read as absent — and the verdict below would call a door that
 *  did shut still open. The config keyword this platform WRITES needs no such pair: 8.2 already
 *  accepts `KbdInteractiveAuthentication` as an alias, it only dumps it under the old name. */
const READ_EFFECTIVE = `read_effective() {
  local config
  config="$(effective)" || return 1
  pw="$(printf '%s\\n' "$config" | awk '$1 == "passwordauthentication" { print $2; exit }')"
  kbd="$(printf '%s\\n' "$config" | awk '$1 == "kbdinteractiveauthentication" || $1 == "challengeresponseauthentication" { print $2; exit }')"
  pubkey="$(printf '%s\\n' "$config" | awk '$1 == "pubkeyauthentication" { print $2; exit }')"
  methods="$(printf '%s\\n' "$config" | awk '$1 == "authenticationmethods" { $1 = ""; sub(/^ /, ""); print; exit }')"
  echo "sshd -T: passwordauthentication \${pw:-(absent)}, kbdinteractiveauthentication \${kbd:-(absent)}, pubkeyauthentication \${pubkey:-(absent)}, authenticationmethods \${methods:-(absent)}"
}`;

/** Would any login still be able to complete once both password keywords say no?
 *
 *  `AuthenticationMethods` holds space-separated LISTS, each a comma-separated set of methods a
 *  login must complete ALL of. sshd skips a list that names a method the configuration has
 *  disabled, and a host whose every list is skipped authenticates nobody — it logs "contains
 *  disabled method, skipping" and has nothing left to try. So a host carrying
 *  `publickey,keyboard-interactive` (the usual PAM two-factor setup) or `publickey,password` is
 *  shut out by the very change this run kind makes, and neither `sshd -t` nor the read-back would say
 *  so: the file is valid, `passwordauthentication no` is exactly what was asked for, and OpenSSH
 *  only meets the contradiction at the next login attempt. This is the one check that has to run
 *  BEFORE anything is written. */
const SURVIVES = `survives_without_passwords() {
  # "any" is sshd's own word for its default: every enabled method stands on its own, so removing
  # the password methods leaves publickey answering by itself.
  if [ -z "$methods" ] || [ "$methods" = "any" ]; then return 0; fi
  local list item
  for list in $methods; do
    for item in $(printf '%s' "$list" | tr ',' ' '); do
      case "$item" in
        password|password:*|keyboard-interactive|keyboard-interactive:*) continue 2 ;;
      esac
    done
    return 0
  done
  return 1
}`;

/** Print every file that STATES either keyword, in the order sshd reads them, so a drop-in that
 *  disagrees with the verdict above is visible instead of being believed. Reported and never
 *  edited: a file this platform did not write carries settings far beyond these two keywords, and
 *  the drop-in above already wins over all of them.
 *
 *  TWO GREPS, AND THE ELEVATED ONE NAMES ITS PATTERNS OUTRIGHT. The sudoers rule this command runs
 *  under matches the whole argument string, so a rule carrying `*` where a pattern belongs lets the
 *  account put `-f /etc/shadow` there instead — grep reads its patterns from a file only root may
 *  read and prints the lines that match. Two fixed `-e` patterns leave the rule with no wildcard at
 *  all, and the anchoring an ERE would do runs afterwards over grep's own `file:line:text`
 *  output, where it needs no elevation. `-H` is what makes that output shape a fact rather than a
 *  coincidence: grep prints the file name only when it was given more than one operand, so a host
 *  without /etc/ssh/sshd_config.d would otherwise print bare `line:text` and the anchor would drop
 *  every match. */
const INVENTORY = `inventory() {
  echo "files stating either keyword, in the order sshd reads them:"
  as_root grep -rniH -e PasswordAuthentication -e KbdInteractiveAuthentication \\
    /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null \\
    | grep -iE '^[^:]+:[0-9]+:[[:space:]]*(PasswordAuthentication|KbdInteractiveAuthentication)[[:space:]]' \\
    | sort || echo "  (none)"
}`;

/** Make the RUNNING daemon re-read its configuration, and say so honestly when there is nothing to
 *  re-read. Reload and never restart: a restart drops every established session, this run's own
 *  included.
 *
 *  Three shapes, in the order they are tried. The unit is `ssh` on Debian and Ubuntu and `sshd`
 *  elsewhere. Ubuntu 24.04 — the release the preflight asks for — runs sshd from `ssh.socket`
 *  instead: `ssh.service` is inactive and no `sshd` unit exists, so both reloads fail while nothing
 *  is wrong. There is genuinely nothing to reload there, because the socket starts a fresh sshd per
 *  connection and that one reads the files as they stand. */
const RELOAD = `reload_sshd() {
  as_root systemctl reload ssh 2>/dev/null && return 0
  as_root systemctl reload sshd 2>/dev/null && return 0
  if as_root systemctl is-active --quiet ssh.socket 2>/dev/null; then
    echo "sshd is socket-activated: every new connection starts a daemon that reads this file as it stands, so there is nothing to reload"
    return 0
  fi
  return 1
}`;

/** Write the drop-in, validate, reload — and put the previous file back unless BOTH succeeded.
 *
 *  The validation half is the obvious one: a drop-in the daemon cannot parse would take sshd down
 *  at its next start, and the reload is the moment that would happen.
 *
 *  The reload half is the one that keeps every later reading honest. `sshd -T` execs a new sshd that
 *  parses the FILES; it has no channel to the running process, so it cannot tell "the daemon
 *  reloaded" from "the file changed". A drop-in left on disk that the running daemon never read
 *  would make the probe report a shut door while the daemon goes on taking passwords — the same
 *  class of mistake the `99-` file made, from the other end.
 *
 *  THE ROOT WRITE NAMES NO SOURCE PATH, and that is what keeps the standing sudoers grant from
 *  being a way to read the machine. A copier takes a source the account picks, so a rule for it can
 *  only say `*` where that source stands — and the account owns whatever path the pattern allows
 *  and can point a symlink from it at /etc/shadow, which the copier follows as root into a
 *  destination it is then free to read. There is no sudoers form that permits such a copy and
 *  refuses that read. So the write is split into two commands that carry no path of the account's
 *  choosing at all, and both rules are pinned with no wildcard: `install` copies /dev/null onto the
 *  drop-in, which creates or resets it root-owned at mode 0644, and `tee` fills it from THIS
 *  script's stdin. Measured with coreutils 9.4 on Ubuntu 24.04: `install -m 0644 /dev/null target`
 *  leaves an empty 0644 file, and a following `tee` writes it without changing that mode.
 *
 *  The mode is set by `install` rather than left to `tee` alone, because a file `tee` creates takes
 *  whatever the elevating process's umask happens to be, and that is a setting of the machine and
 *  not of this script.
 *
 *  What no rule can narrow is the CONTENT: the account still chooses the bytes of the drop-in that
 *  sorts before every other sshd file, and that is the thing this call site exists to do. The
 *  operator is told about that one in the summary they approve. */
const APPLY = `write_drop_in() {
  as_root install -m 0644 -o root -g root /dev/null "${DROP_IN}"
  as_root tee "${DROP_IN}" > /dev/null
}
apply() {
  local value="$1" tmp prev=""
  tmp="$(mktemp)"
  cat > "$tmp"
  if as_root test -e "${DROP_IN}"; then prev="$(mktemp)"; as_root cat "${DROP_IN}" > "$prev"; fi
  write_drop_in < "$tmp"
  rm -f "$tmp"
  if ! as_root "$(sshd_bin)" -t; then
    put_back "$prev"
    echo "the sshd configuration does not validate with PasswordAuthentication $value — the drop-in was put back and NOTHING was reloaded" >&2
    return 1
  fi
  if ! reload_sshd; then
    put_back "$prev"
    echo "the configuration is valid but the running daemon could not be told to re-read it — the drop-in was put back, because sshd -T reads these files and a reading of the new one would claim a door the daemon still opens" >&2
    return 1
  fi
  [ -z "$prev" ] || rm -f "$prev"
}
put_back() {
  if [ -n "$1" ]; then write_drop_in < "$1"; rm -f "$1"
  else as_root rm -f "${DROP_IN}"; fi
}`;

const PREAMBLE = `#!/usr/bin/env bash
set -euo pipefail
${SSHD_HELPERS}
${READ_EFFECTIVE}
${INVENTORY}
${RELOAD}
${APPLY}
pw=""; kbd=""; pubkey=""; methods=""`;

// SURVIVES belongs to this script alone: opening a door cannot leave a host with no way in.
// Both scripts are exported so a real `bash` can parse the bytes this kit ships (remote-syntax.test.ts):
// nothing else on the way to a machine reads them, so a typo would first be met by the host.
export const DISABLE_SCRIPT = `${PREAMBLE}
${SURVIVES}
read_effective || { echo "the effective sshd configuration cannot be read, so no change may claim an effect" >&2; exit 1; }
# The key door has to be open BEFORE the password door shuts, or this host answers nobody.
[ "$pubkey" = "yes" ] || { echo "sshd reports pubkeyauthentication '\${pubkey:-(absent)}' — shutting the password door here would leave nothing to log in with" >&2; exit 1; }
# And a key alone has to be ENOUGH. On a host that requires two factors, every method list names a
# password method, so turning both keywords off leaves sshd with no list it can complete.
survives_without_passwords || { echo "sshd requires authenticationmethods '\${methods}' — every list it accepts names a password method, so with passwords off no login could complete on this host. Change AuthenticationMethods first; NOTHING was written" >&2; exit 1; }
printf '%s' '${dropInContent("no")}' | apply no
inventory
read_effective || { echo "the effective sshd configuration cannot be read after the reload" >&2; exit 1; }
[ "$pw" = "no" ] && [ "$kbd" = "no" ] || { echo "the daemon still takes a password after the reload — a file listed above states the keyword before ${DROP_IN} does, or /etc/ssh/sshd_config states it before its Include line" >&2; exit 1; }
[ "$pubkey" = "yes" ] || { echo "pubkeyauthentication is no longer yes — this host would answer nobody" >&2; exit 1; }
echo "password login is off; key login is on"
`;

export const ENABLE_SCRIPT = `${PREAMBLE}
printf '%s' '${dropInContent("yes")}' | apply yes
inventory
read_effective || { echo "the effective sshd configuration cannot be read after the reload" >&2; exit 1; }
[ "$pw" = "yes" ] || { echo "the daemon still refuses passwords after the reload — a file listed above states the keyword before ${DROP_IN} does, or /etc/ssh/sshd_config states it before its Include line" >&2; exit 1; }
echo "password login is on"
`;

/** Put the password door back. Registered by the step that shut it, and its script is the ENABLE
 *  act itself — the same file, the same validation, the same read-back.
 *
 *  It reproduces the DOOR that was open, not the byte-for-byte configuration that was there: the
 *  step registers it only when it measured the door open or could not measure at all, so the one
 *  case it would overshoot is the one case it is never registered in. The reading is written back
 *  afterwards, or the card would go on claiming the state the compensation just undid. */
export const restorePasswordLoginCleanup: Cleanup = {
  name: "restore-password-login",
  title: "Put password login back on",
  run: async (ctx: StepCtx) => {
    const session = await ctx.ssh();
    const r = await remoteScript(ctx, session, "cluster-password-login-enable", ENABLE_SCRIPT, { timeoutMs: 2 * 60_000 });
    await recordPasswordLoginReading(ctx, session, String(ctx.params.serverId));
    if (r.code !== 0) throw errValidation(`password login could not be put back (exit ${r.code}) — see the run log`);
  },
};

/** Step 0 of both run kinds, and the reason they are declared mutating: the run changes which
 *  credentials a machine accepts, so it proves the box answering the address is the box that was
 *  adopted before it changes anything on it. */
function attestTargetStep(serverId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the machine answering this address",
    run: async (ctx) => {
      const session = await ctx.ssh();
      const outcome = await attestMachineId({ db: ctx.db, session, serverId, signal: ctx.signal, log: (l) => ctx.log("meta", l) });
      ctx.checkpoint({ machineId: outcome.machineId, machineIdAction: outcome.action });
    },
  };
}

/** The disable run kind's own key-login proof, spelled as its own step so the operator sees it in the
 *  plan before approving. The session it opens IS a key session — ctx.ssh() authenticates with the
 *  sealed ssh_key credential and nothing else — so reaching the two commands is the proof; the
 *  daemon-side half of the same question (`pubkeyauthentication yes`) is asserted by the act script
 *  before and after it writes anything. adopt needs no such step: its own verify-key-login already
 *  ran, which is why its disable step sits directly after it. */
function verifyKeyLoginStep(): Step {
  return {
    name: "verify-key-login",
    title: "Verify key-only login still works",
    run: async (ctx) => {
      const session = await ctx.ssh();
      await remoteCmd(ctx, session, "echo key-ok");
      await remoteCmd(ctx, session, "sudo -n true");
    },
  };
}

/**
 * Shut the password door on the host: read what the daemon answers now, arm the compensation, then
 * write, validate, reload — and read the daemon again.
 *
 * BOTH readings go through the one writer, and the second one is taken BEFORE the act's exit code
 * is judged. That is what keeps the card honest in the case that matters: a run whose script failed
 * halfway has changed something, and a row still carrying the pre-state would describe a host that
 * no longer exists. A separate reading step could not do this — a failed step ends the run.
 *
 * What makes that second reading trustworthy is `apply`: it puts the previous drop-in back unless
 * the daemon both accepted the new one and re-read it. `sshd -T` parses the files, so a file the
 * running daemon never read would be reported here as a shut door.
 *
 * The first reading also decides the compensation. `restore-password-login` is armed unless this
 * run MEASURED the door already shut, because only a measurement can say there is nothing to put
 * back; an unreadable reading arms it, since an unmeasured door is not a shut one.
 *
 * Shared with adopt, which is where a host meets it first: there is no state in which password
 * login should survive an adoption.
 */
export function disablePasswordLoginStep(serverId: string): Step {
  return {
    name: "disable-password-login",
    title: "Turn password login off at the daemon",
    run: async (ctx) => {
      const session = await ctx.ssh();
      const before = await recordPasswordLoginReading(ctx, session, serverId);
      if (before !== "off") ctx.registerCleanup(restorePasswordLoginCleanup);
      const r = await remoteScript(ctx, session, "cluster-password-login-disable", DISABLE_SCRIPT, { timeoutMs: 2 * 60_000 });
      const after = await recordPasswordLoginReading(ctx, session, serverId);
      if (r.code !== 0) throw errValidation(`password login could not be turned off (exit ${r.code}) — see the run log`);
      ctx.checkpoint({ passwordLoginBefore: before, passwordLoginAfter: after });
    },
  };
}

/** Open the password door again, and record what the daemon answers afterwards. No key-login proof
 *  and no compensation: opening a door cannot lock anybody out, and there is nothing to undo that
 *  leaving it open would not already be. */
function enablePasswordLoginStep(serverId: string): Step {
  return {
    name: "enable-password-login",
    title: "Turn password login on at the daemon",
    run: async (ctx) => {
      const session = await ctx.ssh();
      const r = await remoteScript(ctx, session, "cluster-password-login-enable", ENABLE_SCRIPT, { timeoutMs: 2 * 60_000 });
      const after = await recordPasswordLoginReading(ctx, session, serverId);
      if (r.code !== 0) throw errValidation(`password login could not be turned on (exit ${r.code}) — see the run log`);
      ctx.checkpoint({ passwordLoginAfter: after });
    },
  };
}

/**
 * The SECOND door, and the one that outlives the machine's configuration: the bootstrap password
 * sealed beside the server row so the list can offer one-click adopt. sshd's door is a setting a
 * reinstall or a cloud-init rewrite can reopen; this one is a working credential this manager
 * holds, and nothing but this step takes it away.
 *
 * A step of its own rather than a line inside the act above, because the two doors fail
 * independently: a host whose daemon refuses the change must still not be left with a stored
 * password, and the run log has to say which of the two happened.
 *
 * Shared with adopt for the same reason the step above is: the two doors are shut by one pair of
 * steps wherever that happens.
 */
export function purgeBootstrapPasswordStep(serverId: string): Step {
  return {
    name: "purge-bootstrap-password",
    title: "Destroy the stored bootstrap password",
    run: async (ctx) => {
      const had = await purgeBootstrapPassword(ctx.creds, serverId);
      ctx.log("meta", had
        ? "The bootstrap password sealed for this server is destroyed — one-click adopt will ask for one again."
        : "No bootstrap password was stored for this server.");
      ctx.checkpoint({ purgedBootstrapPassword: had });
    },
  };
}

/** The run kinds this kit builds — every RUN_KIND literal in the family, named by the family rather
 *  than listed, so a third one cannot be added to the enum without the maps below refusing to
 *  compile. */
export type PasswordLoginKind = Extract<RunKind, `cluster-password-login-${string}`>;

export function passwordLoginSteps(kind: PasswordLoginKind, serverId: string): Step[] {
  if (kind === "cluster-password-login-disable") {
    return [attestTargetStep(serverId), verifyKeyLoginStep(), disablePasswordLoginStep(serverId), purgeBootstrapPasswordStep(serverId)];
  }
  return [attestTargetStep(serverId), enablePasswordLoginStep(serverId)];
}

const SUMMARY: Record<PasswordLoginKind, (o: { name: string; steps: number; host: string }) => string> = {
  "cluster-password-login-disable": (o) =>
    `Turn password login off on "${o.name}" (${o.host}): ${o.steps} steps. The run proves key login works first, ` +
    `writes one drop-in that sorts before every other, validates the configuration, reloads the daemon without ` +
    `dropping a session, and reads the result back out of sshd -T. It also destroys the bootstrap password stored ` +
    `for this server, which is the second way in.`,
  "cluster-password-login-enable": (o) =>
    `Turn password login back on for "${o.name}" (${o.host}): ${o.steps} steps, through the same drop-in and the ` +
    `same read-back. For a repair — an adopted server needs no password login.`,
};

const WARNINGS: Record<PasswordLoginKind, string[]> = {
  "cluster-password-login-disable": [
    "Afterwards this host takes key logins only. Anyone who reaches it by password today — a console session that is not this manager, a script, a colleague — will not afterwards.",
    "The stored bootstrap password is destroyed, so one-click adopt asks for a password again.",
  ],
  "cluster-password-login-enable": [
    "Afterwards this host takes a password from anyone who can reach its SSH port, which on an internet-facing machine means every scanner that finds it.",
  ],
};

/**
 * The plan both run kinds are approved on. Nothing exotic: the host is reached on its usual address,
 * because unlike the tailnet run kinds this act does not travel over the thing it changes — reload
 * leaves the established session alone.
 *
 * The target OWNS its host, which derives the `server:<id>` lock every host-mutating run takes.
 * Without it, this could shut the password door on a machine an adopt in flight was still using a
 * password on.
 *
 * The MASTER is a legitimate target, unlike in the tailnet run kinds: their reason for refusing it is
 * that it runs the coordinator the others log in to, and nothing here has a counterpart to that.
 * The master is an internet-facing machine with an sshd like any other.
 */
export function passwordLoginPlan(kind: PasswordLoginKind, serverId: string, db: Db): Plan {
  const server = loadServer(db, serverId);
  if (!hasManagerKey(server.status)) {
    // What the refusal states is the RULE, not a claim about the machine: an adoption that failed
    // part way leaves its row back at 'bare' while the key it installed is still on the host, so a
    // message saying "this manager holds no key for it" would be false exactly there. That run
    // is retried or aborted from its own run screen, which is where the key is accounted for.
    throw errValidation(
      `refusing: "${server.name}" is '${server.status}' — only a server whose adoption finished is driven over this manager's own key. ` +
      `An adoption that stopped part way is retried or aborted from its own run screen.`,
    );
  }
  const steps = passwordLoginSteps(kind, serverId);
  const dialled = resolveTransport(server, "default");
  return {
    kind,
    targetKind: "server",
    targetId: serverId,
    summary: SUMMARY[kind]({ name: server.name, steps: steps.length, host: `${dialled.host}:${server.sshPort}` }),
    steps: steps.map((s) => ({ name: s.name, title: s.title })),
    targets: [{ serverId, ownsHost: true, label: server.name }],
    warnings: WARNINGS[kind],
    requiredSecrets: [],
  };
}
