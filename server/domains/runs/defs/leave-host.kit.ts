import { eq } from "drizzle-orm";
import type { Cleanup, StepCtx } from "../../../executor/types.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx, remoteCmd, remoteScript, remoteScriptCapture, requirePassword } from "../../../executor/stepkit.ts";
import { managerKeyMarker } from "../../../../shared/operator-keys.ts";
import { recordAuthorizedKeysReading } from "../operator-keys-probe.ts";
import { removeScript } from "./operator-key.kit.ts";
import { MACHINE_STATE, PLATFORM_SNAP } from "./machine-state.ts";
import { ANSIWISE_EXECUTABLES, BOOTSTRAP_HOME, PATH_HOME } from "./place-ansiwise.ts";
import { loadServer } from "./deploy-slave.kit.ts";

// LEAVING A MACHINE: putting it back to the state first contact found it in.
//
// A machine that stops being part of an installation keeps whatever was put on it unless something
// takes it off, and what nobody would think to look for is a working way in: this manager's key line
// stands in an authorized_keys file the next owner of the box never reads, while the daemon's
// password door stays shut so nobody else gets in at all. That is what these two compensating
// actions are for, and it is why they are two rather than one — they undo two different kinds of
// act over two different routes, and the order between them is what keeps the second one reachable.
//
//   leave-host          Everything this platform WROTE on the machine: the paths
//                       defs/machine-state.ts names, the two engine executables, the cluster snap
//                       with its data, and the machine's membership of the private network. Raised
//                       whole with the run's own password, because a machine this platform deployed
//                       grants this manager no standing passwordless-root rule.
//   remove-manager-key  The line install-key appended, and the private half sealed beside the row.
//                       It goes LAST of everything, because it is the route every act above travels.
//
// THE ORDER IS THE REVERSE OF THE ARMING, AND THAT IS WHERE IT COMES FROM. The executor runs
// compensating actions in reverse registration order (executor/executor.ts abortWithCleanup), and
// the steps that arm these stand in the list in the order a machine acquires what they undo:
// install-key first, then disable-password-login, then place-ansiwise. So an abort strips the
// machine while both routes to it are still open, then opens the password door, then takes the key
// line off — and nothing here has to state an order of its own.
//
// THREE THINGS A LEAVE CANNOT PUT BACK, and each is said out loud rather than passed over:
//   - the bootstrap password `purge-bootstrap-password` destroyed. It is deleted with the value
//     behind it and nothing can mint it again, so a person sets a new one at the machine.
//   - the packages deploy-host installed (git, openssl, curl, jq, apache2-utils). Nothing recorded
//     which of them the machine was missing beforehand, and most Ubuntu images carry them, so
//     removing them would leave the machine other than as it was found rather than as it was found.
//   - the time sources deploy-host wrote and the clock service it started. The same reading: the row
//     that enabled the service recorded nothing about what the machine had before it.

/** The words the leave prints for a thing it took off, a thing it could not, and its verdict. Named
 *  here because the script writes them and the compensating action reads them back. */
const LEFT = "LEFT";
const KEPT = "KEPT";
const CLEAN = "LEAVE clean";

/** Child before parent, so a directory is named before the one it stands inside. `rm -rf` on a
 *  parent takes its children with it, and a report naming the parent first would say a child was
 *  gone without ever having asked about it. [MACHINE_STATE] is written parent-first, which is what
 *  its own handover walk needs, so the reversal belongs here rather than there. */
const STATE_PATHS = [...MACHINE_STATE].reverse().map((e) => e.path);

/** The four places the two engine executables stand: the home directory they are transferred into
 *  and the PATH they are raised onto (defs/place-ansiwise.ts). */
const ENGINE_BINARIES = [BOOTSTRAP_HOME, PATH_HOME]
  .flatMap((home) => ANSIWISE_EXECUTABLES.map((name) => `${home}${name}`));

/**
 * Take everything this platform WROTE off the machine.
 *
 * RAISED WHOLE, so every act below already runs as root: one `sudo -S` per thing sent, and a second
 * one inside this file would read an input that is already at end of file
 * (executor/stepkit.ts `raised`).
 *
 * NO `set -e`, and that is the one shape decision in this script. Each act prints its own verdict
 * and the step reads all of them, so a machine that refuses one still gets told about the rest — and
 * a leave that stopped at the first refusal would report a half-left machine without saying which
 * half. The count at the foot is what turns "some of it stayed" into a failure.
 *
 * EACH ACT MEASURES FIRST. A machine with no tailnet client, no snap and no state has nothing to
 * take off and says so, which is what lets this run against a machine that never got past first
 * contact as readily as against one that finished a whole install.
 */
export const LEAVE_HOST_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
kept=0
gone() { echo "${LEFT} $1"; }
stays() { echo "${KEPT} $1"; kept=$((kept + 1)); }

# The private network. A LOGOUT and not a disconnect: a disconnect leaves the client holding its node
# key and its coordinator, which is a credential for an installation this machine is leaving.
if command -v tailscale >/dev/null 2>&1; then
  if tailscale logout >/dev/null 2>&1; then gone "the private network membership"
  else stays "the private network membership — the client would not log out"; fi
else
  gone "the private network membership (this machine carries no tailscale client)"
fi

# The cluster distribution and everything it holds. --purge is what stops snapd saving a snapshot of
# the snap's data before deleting it.
if command -v snap >/dev/null 2>&1 && snap list ${PLATFORM_SNAP} >/dev/null 2>&1; then
  if snap remove --purge ${PLATFORM_SNAP} >/dev/null 2>&1; then gone "the ${PLATFORM_SNAP} snap and its data"
  else stays "the ${PLATFORM_SNAP} snap"; fi
else
  gone "the ${PLATFORM_SNAP} snap (this machine carries none)"
fi

${STATE_PATHS.map((path) => `rm -rf "${path}"
if [ -e "${path}" ]; then stays "${path}"; else gone "${path}"; fi`).join("\n")}

[ "$kept" -eq 0 ] || { echo "$kept thing(s) this platform put on this machine are still there — the lines above name each one" >&2; exit 1; }
echo "${CLEAN}"
`;

/**
 * `leave-host` — the machine put back, for everything this platform wrote on it.
 *
 * TWO SENDS AND NOT ONE, because the executables come off the route they were PLACED by. The script
 * above carries only paths defs/machine-state.ts declares, which is what lets the ownership check
 * (machine-state.test.ts) answer every absolute path in it; the two executables are deliberately
 * outside that registry — root owns them because a raised run executes them — and they reach the
 * machine as words of a command line rather than as a script, so they leave it the same way.
 *
 * Registered by `place-ansiwise`, the step that puts the executables and brings the catalogue. It
 * stands before the first deployment program, so a run that died anywhere in the machine layer has
 * this armed.
 */
export function leaveHostCleanup(secretName: string): Cleanup {
  return {
    name: "leave-host",
    title: "Take everything this platform wrote off the machine",
    run: async (ctx: StepCtx) => {
      const elevation = requirePassword(ctx, secretName);
      const server = loadServer(ctx.db, String(ctx.params.serverId));
      const session = await ctx.ssh();
      const cap = await remoteScriptCapture(ctx, session, "leave-host", LEAVE_HOST_SCRIPT, { timeoutMs: 5 * 60_000, elevation });
      await remoteCmd(ctx, session, `rm -f ${ENGINE_BINARIES.join(" ")}`, { elevation });
      const kept = cap.stdout.split("\n").filter((l) => l.startsWith(KEPT));
      ctx.checkpoint({ leave: cap.stdout.includes(CLEAN) ? "clean" : "incomplete", kept: kept.length });
      if (cap.result.code !== 0) {
        throw errValidation(
          `${server.name} was not put back: the leave reported ${kept.length} thing(s) it could not take off — the run ` +
          "log names each one, and aborting again finishes what is left",
        );
      }
      ctx.log("meta",
        `${server.name} carries nothing this platform wrote any more. What no compensation puts back: the packages ` +
        "deploy-host installed (git, openssl, curl, jq, apache2-utils) and the clock sources it wrote stay, because " +
        "nothing recorded what the machine had before them.");
    },
  };
}

/**
 * `remove-manager-key` — the key line off the machine, and the private half out of the store.
 *
 * IT GOES LAST, and this file's ordering exists for that: this is the route every other compensating
 * action reaches the machine over, so taking it off first would strip a machine nothing could then
 * finish stripping.
 *
 * IT NEEDS NO PASSWORD, unlike everything else an abort of a deployment does. The file is the login
 * account's own `~/.ssh/authorized_keys`, so the edit runs unraised — which is also what keeps this
 * last act from being the one that fails for want of a secret nobody re-supplied.
 *
 * THE EDIT IS THE OPERATOR-KEY FILTER, aimed at this manager's own marker instead of an operator's.
 * One filter for both, because what makes it safe is what this act needs too: a read failure is told
 * apart from an empty result, so a file that could not be read is never installed as an empty one;
 * and the line arithmetic is checked against the file read a second time, so a key somebody appended
 * while the abort was running makes the two disagree and nothing is written at all.
 *
 * THE ROW AND THE CREDENTIAL FOLLOW THE ACT, in the compensating action that performed it. A machine
 * that no longer carries the line is one `ctx.ssh()` cannot open a session to, so a stored key and an
 * `adoptedAt` stamp left standing would have this manager offering run kinds that die at their first
 * session and a card claiming a login last proven against a file that no longer holds it. The status
 * goes to `bare`, which is what a machine nothing has reached is and what a fresh first contact
 * treats it as.
 */
export const removeManagerKeyCleanup: Cleanup = {
  name: "remove-manager-key",
  title: "Take this manager's key off the machine and out of the store",
  run: async (ctx: StepCtx) => {
    const serverId = String(ctx.params.serverId);
    const server = loadServer(ctx.db, serverId);
    const session = await ctx.ssh();
    const r = await remoteScript(ctx, session, "leave-manager-key", removeManagerKeyScript(server.name), { timeoutMs: 60_000 });
    const after = await recordAuthorizedKeysReading(ctx, session, serverId);
    if (r.code !== 0) throw errValidation(`this manager's key could not be taken off ${server.name} (exit ${r.code}) — see the run log`);
    const held = await ctx.creds.list({ serverId, kind: "ssh_key", excludeRotated: true });
    for (const key of held) await ctx.creds.purge(key.id);
    localTx(ctx, (tx) => tx.update(servers).set({ status: "bare", adoptedAt: null }).where(eq(servers.id, serverId)).run());
    ctx.checkpoint({ keysPurged: held.length, authorizedKeysState: after?.state ?? null });
    ctx.log("meta",
      `${server.name} takes no key of this manager's any more and its row stands at bare. The one thing this abort ` +
      "cannot put back is the bootstrap password: this run's purge-bootstrap-password destroyed it with the value " +
      `behind it, so set a new password for "${server.sshUser}" at ${server.name} itself before anything reaches it again.`);
  },
};

/** The edit itself, aimed at the marker `generate-key` put on the key it drew for this machine. Its
 *  own symbol rather than a `removeScript` call written at the send, so a real `bash` reads THESE
 *  bytes before a machine does: the operator-key entry in remote-scripts.fixture.ts renders the same
 *  function with an operator's marker, and the two markers are two different patterns in the file
 *  this manager's own way in stands in. */
export function removeManagerKeyScript(serverName: string): string {
  return removeScript(managerKeyMarker(serverName));
}
