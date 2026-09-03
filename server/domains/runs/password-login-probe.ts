// Reading what a host's sshd RESOLVED about password login, and recording it on the server row.
//
// WHY `sshd -T` AND NOTHING ELSE. sshd takes the FIRST occurrence of a keyword, and the drop-in
// directory `/etc/ssh/sshd_config.d` is read in alphabetical order. A file called
// `99-disable-passwords.conf` saying `PasswordAuthentication no` therefore does nothing at all when
// `50-cloud-init.conf` said `yes` before it — and a check that greps the file confirms a door is
// shut while the daemon goes on opening it. `sshd -T` prints the configuration the daemon actually
// arrived at, after every Include and every ordering rule, which is the one place the question is
// already answered.
//
// TWO KEYWORDS, ONE DOOR. `passwordauthentication` is the obvious one; PAM also serves passwords
// through keyboard-interactive, so `kbdinteractiveauthentication` has to be read with it — under
// both of its names, because OpenSSH 8.7 renamed it and 8.6 and earlier dump it as
// `challengeresponseauthentication`. The third value, `pubkeyauthentication`, is read because it
// says whether the host is reachable at all: a machine with every door shut answers nobody.
//
// The reading has ONE limit worth knowing: `sshd -T` without `-C` prints the GLOBAL configuration,
// so a `Match` block that re-opens passwords for one user or one address does not show up in it.
// The act scripts print every file that states either keyword beside this reading, which is where
// such a block would be visible.
import { eq } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import { servers } from "../../db/schema/inventory.ts";
import { remoteScriptCapture, localTx } from "../../executor/stepkit.ts";
import { passwordLoginReading, type PasswordLoginProbe } from "../../../shared/password-login.ts";
import type { ServerPasswordLoginState } from "../../../shared/enums.ts";

/** How every script here reaches the daemon's own configuration. Two things make it necessary:
 *  `sshd -T` may only be run by root, and the binary lives in /usr/sbin, which is on the PATH of a
 *  root shell on Ubuntu but not of every host — so the PATH lookup happens first and the well-known
 *  path is probed with `test` where it found nothing.
 *
 *  `as_root` ASSERTS THE SHELL IS ALREADY ROOT and then runs the command; it elevates nothing. Every
 *  step shipping one of these scripts raises the WHOLE script with the password its run carries
 *  (executor/stepkit.ts `raised`), because one `sudo -S` per thing sent is all the password stretches
 *  to. So the helper's job is to name, at each call site, the lines that need root — and to refuse
 *  loudly in the one case that would otherwise be silent: a script sent unraised, where every root
 *  line would fail one at a time with the daemon's own words and read as a broken host. The route it
 *  deliberately does NOT take is `sudo -n`, which answers only on a machine carrying a standing
 *  passwordless-root rule; no run kind here writes one, and the deployment's `remove-sudoers` takes
 *  it off a machine that still has one. */
export const SSHD_HELPERS = `as_root() { [ "$(id -u)" = 0 ] || { echo "this script reaches root through the password its run carries and was sent unraised — nothing was read and nothing was written" >&2; return 1; }; "$@"; }
sshd_bin() {
  local found
  found="$(command -v sshd 2>/dev/null || true)"
  if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  if as_root test -x /usr/sbin/sshd 2>/dev/null; then printf '%s' /usr/sbin/sshd; return 0; fi
  return 1
}
effective() { as_root "$(sshd_bin)" -T; }`;

/**
 * The probe. Emits `SSHD <key> <value>` lines; an ABSENT line is the absence of the fact, so a
 * branch that cannot produce a value simply prints none. Every path exits 0 — a non-zero exit means
 * the reading never happened, and recordPasswordLoginReading keeps the stored reading in that case
 * rather than replacing a measurement with a guess.
 */
export const PASSWORD_LOGIN_PROBE_SCRIPT = `#!/usr/bin/env bash
${SSHD_HELPERS}
config="$(effective 2>/dev/null || true)"
if [ -z "$config" ]; then
  echo "SSHD effective unreadable"
  exit 0
fi
echo "SSHD effective readable"
# One sshd prints ONE of the two keyboard-interactive spellings — 8.7 and later the first, earlier
# ones the second — so the pair can never disagree with itself here.
printf '%s\\n' "$config" | awk '
  $1 == "passwordauthentication"            { print "SSHD password " $2 }
  $1 == "kbdinteractiveauthentication"      { print "SSHD keyboard " $2 }
  $1 == "challengeresponseauthentication"   { print "SSHD keyboard " $2 }
  $1 == "pubkeyauthentication"              { print "SSHD pubkey " $2 }'
`;

/** Turn the probe's stdout into the facts. A key whose value came out empty produces a line with
 *  nothing after the key, which matches no `SSHD <key> <value>` pair and lands here as an absent
 *  key — the same as a branch that never ran. */
export function parsePasswordLoginProbe(stdout: string): PasswordLoginProbe {
  const seen: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^SSHD (\S+) (.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) seen[m[1]] = m[2].trim();
  }
  return {
    readable: seen["effective"] === "readable",
    passwordAuthentication: seen["password"] ?? null,
    kbdInteractiveAuthentication: seen["keyboard"] ?? null,
    pubkeyAuthentication: seen["pubkey"] ?? null,
  };
}

/**
 * Read the host and write the pair. State and document go down in ONE statement, so a reading can
 * never be stored without the moment and the run that produced it.
 *
 * RAISED WITH THE PASSWORD THE CALLER HOLDS, because `sshd -T` is a root command and a machine this
 * platform has deployed carries no standing rule granting it: the deployment takes the sudoers
 * drop-in off (defs/manager-key.kit.ts `remove-sudoers`), so a probe sent unraised would answer
 * "the effective configuration cannot be read" on every host and every reading after it would be a
 * guess.
 *
 * Returns the state it wrote, or null when the probe itself did not run — in which case NOTHING is
 * written and the row keeps what it had. The reading never fails its step: the caller that needs an
 * effective value to be a certain way asserts that itself, loudly, and a reading that could not be
 * taken must not be the thing that ends a run.
 */
export async function recordPasswordLoginReading(
  ctx: StepCtx,
  session: SshSession,
  serverId: string,
  elevation: string,
): Promise<ServerPasswordLoginState | null> {
  const cap = await remoteScriptCapture(ctx, session, "password-login-probe", PASSWORD_LOGIN_PROBE_SCRIPT, { timeoutMs: 60_000, elevation });
  if (cap.result.code !== 0) {
    ctx.log("meta", `Password login: the probe did not run (exit ${cap.result.code}) — this server's stored reading is unchanged.`);
    return null;
  }
  const reading = passwordLoginReading(parsePasswordLoginProbe(cap.stdout), { runId: ctx.runId, observedAt: Date.now() });
  localTx(ctx, (tx) =>
    tx.update(servers).set({ passwordLoginState: reading.state, passwordLoginJson: reading.doc }).where(eq(servers.id, serverId)).run(),
  );
  ctx.log(
    "meta",
    `Password login: ${reading.state} — sshd -T says passwordauthentication ` +
    `${reading.doc.passwordAuthentication ?? "(absent)"}, kbdinteractiveauthentication ` +
    `${reading.doc.kbdInteractiveAuthentication ?? "(absent)"}, pubkeyauthentication ` +
    `${reading.doc.pubkeyAuthentication ?? "(absent)"}; only a run takes a new reading.`,
  );
  return reading.state;
}
