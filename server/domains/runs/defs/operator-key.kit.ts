import type { Db } from "../../../db/client.ts";
import type { Cleanup, Plan, Step, StepCtx } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { remoteScript } from "../../../executor/stepkit.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import { hasManagerKey, type RunKind } from "../../../../shared/enums.ts";
import { authorizedKeysHold, operatorKeyLine, operatorKeyMarker } from "../../../../shared/operator-keys.ts";
import { loadOperatorKey } from "../../inventory/operator-keys.ts";
import { recordAuthorizedKeysReading, type AuthorizedKeysReadingResult } from "../operator-keys-probe.ts";
import { loadServer } from "./deploy-slave.kit.ts";

// The shared half of the three operator-key run kinds (defs/operator-key.ts): the scripts they ship to
// a host, the steps they are composed of, and the one plan builder they state their target in.
//
// WHAT AN ACT IS ALLOWED TO TOUCH. One line of one file: the line in ~/.ssh/authorized_keys whose
// comment is `hostyour-operator:<label>`. Everything else in that file — this manager's own
// key, another operator's key, a line the cloud image put there — is passed through byte for byte.
//
// FOUR RULES EVERY SCRIPT BELOW KEEPS.
//   1. THE FILTER IS `grep -v` ON THE MARKER, so every line that is not this operator's own survives
//      unchanged BY CONSTRUCTION rather than by care. The pattern is anchored at the end of the
//      line, or removing "pat" would also take "pat-laptop" off the host.
//   2. A READ FAILURE IS NEVER AN EMPTY RESULT. grep exits 1 when it selected nothing, which for an
//      inverted match is a legitimate empty file; it exits 2 or more when it could not read at all,
//      and installing the empty output of THAT would delete every key on the machine, this
//      manager's included. The two are told apart before anything is written.
//   3. THE ARITHMETIC IS CHECKED BEFORE THE WRITE, and it is there for the one hazard the host lock
//      does not cover: a HUMAN on the box. The copy is built from the file as it stood, and the
//      counts are then read from the file again — so a key somebody appended in between (an
//      ssh-copy-id landing mid-run) makes the two disagree, and the install is refused instead of
//      silently dropping their line. The run's `server:<id>` lock keeps other RUNS out; it keeps
//      nobody's shell out.
//   4. THE VERDICT COMES FROM READING THE FILE BACK, never from the exit code of the edit. A key
//      sitting on the host under a comment this platform did not write is not removed by a removal
//      that deletes by marker — and only a re-read says so.
//
// The manager's own key is proven untouched twice over: by rule 1 above, and by the step, which
// reads the file on both sides of the act and fails if a line it classified as this manager's
// own has gone.

/** The pattern an act filters by: whitespace, the marker, and the end of the line. Anchored because
 *  a bare substring match would treat every label that merely STARTS the same way as the same key.
 *  The label charset (shared/operator-keys.ts) holds no regular-expression metacharacter and no
 *  quote, which is what makes interpolating it into this pattern — and into the single-quoted shell
 *  string below — safe rather than merely tidy. */
function markerPattern(label: string): string {
  return `[[:space:]]${operatorKeyMarker(label)}[[:space:]]*$`;
}

/** Everything both acts do before they differ: make sure the file exists with the modes sshd
 *  insists on, filter this operator's own lines out of a copy, and refuse to go on unless exactly
 *  those lines went. Leaves the result in "$tmp" and the original still in place. */
function filterPreamble(label: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
ak="$HOME/.ssh/authorized_keys"
pattern='${markerPattern(label)}'
# grep -c '' counts lines including a final one with no newline, which wc -l does not.
count() { grep -c '' "$1" 2>/dev/null || true; }
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
[ -e "$ak" ] || : > "$ak"
chmod 600 "$ak"
tmp="$(mktemp)"
set +e
grep -v -e "$pattern" "$ak" > "$tmp"
rc=$?
set -e
[ "$rc" -le 1 ] || { rm -f "$tmp"; echo "could not read $ak (grep exit $rc) — NOTHING was written" >&2; exit 1; }
# Read the file AGAIN, after the copy was made. Every line grep -v kept is byte-for-byte the line
# that was there, so the copy can only be missing marker lines — unless somebody wrote to the file
# in between, and then it is missing theirs too. That is what these three numbers catch.
hits="$(grep -c -e "$pattern" "$ak" || true)"
before="$(count "$ak")"
after="$(count "$tmp")"
[ "$((before - hits))" = "$after" ] || {
  rm -f "$tmp"
  echo "the filter would drop $((before - after)) line(s) but only $hits carry this operator's marker — NOTHING was written" >&2
  exit 1
}`;
}

/** Put the operator's key on the host. The marker lines are filtered out first and the current line
 *  appended, so placing the same label twice leaves ONE line: the act states a postcondition — this
 *  label has exactly this key in this file — rather than adding to what is there, and a host whose
 *  file was hand-edited into carrying the marker twice comes out with one line either way.
 *
 *  It is not a rotation path. A label holds one row and a row holds one key (operator_keys_label_uq,
 *  server/db/schema/operator-keys.ts), so the only way a label's key changes is that the row is
 *  forgotten and added again — and forgetting is refused while any reading still finds the old key
 *  on a host. A rotation is therefore: remove everywhere, forget, add, place again.
 *
 *  The append is safe on a file whose last line has no newline: grep terminates every line it
 *  prints, so the filtered copy always ends in one and the new line cannot be joined onto the last
 *  key — which would destroy both. */
function placeScript(publicKey: string, label: string): string {
  return `${filterPreamble(label)}
printf '%s\\n' '${operatorKeyLine(publicKey, label)}' >> "$tmp"
install -m 600 "$tmp" "$ak"
rm -f "$tmp"
grep -q -e "$pattern" "$ak" || { echo "the key is not in $ak after the write" >&2; exit 1; }
echo "the key for '${label}' is in $ak ($(count "$ak") line(s) total)"
`;
}

/** Take the operator's key off the host. Removing a key that was never there is a SUCCESS: the act
 *  states a postcondition — this label has no line in this file — and a host that never carried one
 *  already satisfies it. What it does not do is claim the KEY is gone; that verdict is the step's,
 *  taken from the file read back afterwards. */
function removeScript(label: string): string {
  return `${filterPreamble(label)}
install -m 600 "$tmp" "$ak"
rm -f "$tmp"
grep -q -e "$pattern" "$ak" && { echo "a line carrying this operator's marker is still in $ak" >&2; exit 1; }
echo "no line for '${label}' is in $ak ($hits removed, $(count "$ak") line(s) left)"
`;
}

/** The run kinds this kit builds — every RUN_KIND literal that acts on one operator key, named by the
 *  family rather than listed, so a third one cannot be added to the enum without the maps below
 *  refusing to compile. The read run kind is NOT one of them: it is named for the file because it
 *  reports every key in it, including the ones this platform never placed. */
export type OperatorKeyKind = Extract<RunKind, `cluster-operator-key-${string}`>;

export interface OperatorKeyTarget {
  serverId: string;
  operatorKeyId: string;
}

/** Step 0 of all three, and the reason they are declared mutating: two of them change which humans
 *  a machine lets in, and the third writes a reading onto a row that names one — a reading may only
 *  be recorded about a machine whose identity was proven. */
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

/** How many of the lines a reading found are this manager's own. Undefined when there is no
 *  readable reading at all, which is a different thing from none. */
function managerKeyCount(result: AuthorizedKeysReadingResult | null): number | undefined {
  if (result === null || result.read.kind !== "v0") return undefined;
  return result.read.facts.keys.filter((k) => k.kind === "manager").length;
}

/**
 * The act, for both directions. Read the file, edit it, read it again — and take every verdict from
 * the second reading.
 *
 * BOTH readings go through the one writer, and the second one is taken BEFORE the script's exit code
 * is judged. That is what keeps the card honest in the case that matters: a run whose script failed
 * halfway has changed something, and a row still carrying the pre-state would describe a machine
 * that no longer exists.
 *
 * The first reading also decides the compensation. A place arms `remove-operator-key` unless it
 * MEASURED the key already on the host — only a measurement can say there was nothing to undo, and
 * an unreadable file is not a measurement.
 */
function actStep(kind: OperatorKeyKind, target: OperatorKeyTarget): Step {
  const place = kind === "cluster-operator-key-place";
  return {
    name: place ? "place-operator-key" : "remove-operator-key",
    title: place ? "Put the operator's key in authorized_keys" : "Take the operator's key out of authorized_keys",
    run: async (ctx) => {
      const key = loadOperatorKey(ctx.db, target.operatorKeyId);
      const session = await ctx.ssh();
      const before = await recordAuthorizedKeysReading(ctx, session, target.serverId);
      const held = before !== null && authorizedKeysHold(before.read, key.fingerprint);
      if (place && !held) ctx.registerCleanup(removeOperatorKeyCleanup);
      const script = place ? placeScript(key.publicKey, key.label) : removeScript(key.label);
      const r = await remoteScript(ctx, session, place ? "cluster-operator-key-place" : "cluster-operator-key-remove", script, { timeoutMs: 60_000 });
      const after = await recordAuthorizedKeysReading(ctx, session, target.serverId);

      // The one failure this whole run kind is shaped around: an edit that took this manager's own
      // login identity out of the file would leave nobody able to reach the machine, and it is
      // checked before the script's own exit code because it is the more serious answer.
      const had = managerKeyCount(before);
      const has = managerKeyCount(after);
      if (had !== undefined && had > 0 && has === 0) {
        throw errValidation(
          `refusing to report success: this manager's own key is no longer in the file it was in before this step — the run log holds both readings`,
        );
      }
      if (r.code !== 0) throw errValidation(`the key could not be ${place ? "placed" : "removed"} (exit ${r.code}) — see the run log`);
      if (after === null) throw errValidation("the file could not be read back, so this run cannot say what it did — see the run log");
      const nowHeld = authorizedKeysHold(after.read, key.fingerprint);
      if (place && !nowHeld) throw errValidation(`the key ${key.fingerprint} is not in the file after the write — see the run log`);
      if (!place && nowHeld) {
        throw errValidation(
          `the key ${key.fingerprint} is STILL in the file: a line carries it under a comment this platform did not write, ` +
          `so removing by marker did not reach it — the run log names every line found`,
        );
      }
      ctx.checkpoint({ fingerprint: key.fingerprint, label: key.label, heldBefore: held, heldAfter: nowHeld, state: after.state });
    },
  };
}

/** Put a placed key back off the host. Its script is the REMOVE act itself — the same filter, the
 *  same arithmetic, the same read-back — and the reading is written afterwards, or the card would go
 *  on claiming the state the compensation just undid. */
export const removeOperatorKeyCleanup: Cleanup = {
  name: "remove-operator-key",
  title: "Take the operator's key back off",
  run: async (ctx: StepCtx) => {
    const serverId = String(ctx.params.serverId);
    const key = loadOperatorKey(ctx.db, String(ctx.params.operatorKeyId));
    const session = await ctx.ssh();
    const r = await remoteScript(ctx, session, "cluster-operator-key-remove", removeScript(key.label), { timeoutMs: 60_000 });
    await recordAuthorizedKeysReading(ctx, session, serverId);
    if (r.code !== 0) throw errValidation(`the operator key could not be taken back off (exit ${r.code}) — see the run log`);
  },
};

/** The whole of the read run kind: one probe, one row rewritten. It fails when the probe does not run,
 *  because the reading IS the run — a read that recorded nothing has done nothing. */
function readStep(serverId: string): Step {
  return {
    name: "read-authorized-keys",
    title: "Read the host's authorized_keys",
    run: async (ctx) => {
      const session = await ctx.ssh();
      const result = await recordAuthorizedKeysReading(ctx, session, serverId);
      if (result === null) throw errValidation("the host's authorized_keys could not be read — see the run log");
      ctx.checkpoint({ state: result.state, keys: result.read.kind === "v0" ? result.read.facts.keys.length : 0 });
    },
  };
}

export function operatorKeySteps(kind: OperatorKeyKind, target: OperatorKeyTarget): Step[] {
  return [attestTargetStep(target.serverId), actStep(kind, target)];
}

export function authorizedKeysReadSteps(serverId: string): Step[] {
  return [attestTargetStep(serverId), readStep(serverId)];
}

const SUMMARY: Record<OperatorKeyKind, (o: { label: string; fp: string; name: string; host: string; steps: number }) => string> = {
  "cluster-operator-key-place": (o) =>
    `Put the operator key "${o.label}" (${o.fp}) in ~/.ssh/authorized_keys on "${o.name}" (${o.host}): ${o.steps} steps. ` +
    `The run reads the file, appends ONE line carrying that operator's own marker, and reads the file back to prove the key ` +
    `is there and that this manager's own key still is. Every other line is passed through untouched.`,
  "cluster-operator-key-remove": (o) =>
    `Take the operator key "${o.label}" (${o.fp}) out of ~/.ssh/authorized_keys on "${o.name}" (${o.host}): ${o.steps} steps, ` +
    `deleting only lines carrying that operator's marker. A host that never carried it is left alone and the run still succeeds; ` +
    `a host where the key sits under some other comment FAILS, because removing by marker did not reach it.`,
};

const WARNINGS: Record<OperatorKeyKind, string[]> = {
  "cluster-operator-key-place": [
    "Afterwards this person can log in to the host as the same user this manager uses, with the passwordless sudo the adoption configured.",
  ],
  "cluster-operator-key-remove": [
    "Only the line this platform wrote for that label goes. A copy of the same key placed by hand, under another comment, stays — and the run fails saying so rather than reporting a removal that did not happen.",
  ],
};

function assertReachable(server: { name: string; status: Parameters<typeof hasManagerKey>[0] }): void {
  if (!hasManagerKey(server.status)) {
    // The refusal states the RULE, not a claim about the machine: an adoption that failed part way
    // leaves its row back at 'bare' while the key it installed is still on the host, so a message
    // saying "this manager holds no key for it" would be false exactly there.
    throw errValidation(
      `refusing: "${server.name}" is '${server.status}' — only a server whose adoption finished is reached over this ` +
      `manager's own key. An adoption that stopped part way is retried or aborted from its own run screen.`,
    );
  }
}

/**
 * The plan the two acts are approved on. ONE server per run, which is the answer this platform gives
 * to "across the servers": placement is a PER-SERVER state, and a run never spans hosts. Five hosts
 * that took the key and a sixth that refused are therefore five runs that succeeded and one that
 * failed, each with its own log and its own reading — never one run reporting a single verdict about
 * six machines, where success would be a lie and failure would hide the five that worked.
 *
 * The target OWNS its host, which derives the `server:<id>` lock every host-mutating run takes.
 * Without it, two placements could rewrite the same authorized_keys at once and the second install
 * would drop the first's line — the filter reads the file before the other run's write lands.
 *
 * The MASTER is a legitimate target: it is the machine an operator most needs to reach by hand, and
 * its authorized_keys is a file like any other.
 */
export function operatorKeyPlan(kind: OperatorKeyKind, target: OperatorKeyTarget, db: Db): Plan {
  const server = loadServer(db, target.serverId);
  assertReachable(server);
  const key = loadOperatorKey(db, target.operatorKeyId);
  const steps = operatorKeySteps(kind, target);
  const dialled = resolveTransport(server, "default");
  return {
    kind,
    targetKind: "server",
    targetId: target.serverId,
    summary: SUMMARY[kind]({
      label: key.label, fp: key.fingerprint, name: server.name, host: `${dialled.host}:${server.sshPort}`, steps: steps.length,
    }),
    steps: steps.map((s) => ({ name: s.name, title: s.title })),
    targets: [{ serverId: target.serverId, ownsHost: true, label: server.name }],
    warnings: WARNINGS[kind],
    requiredSecrets: [],
  };
}

/** The plan the read run kind is approved on. It writes nothing on the host and takes the same host lock
 *  anyway: a reading taken while a placement is mid-write would describe a file that existed for no
 *  longer than one `install`. */
export function authorizedKeysReadPlan(serverId: string, db: Db): Plan {
  const server = loadServer(db, serverId);
  assertReachable(server);
  const steps = authorizedKeysReadSteps(serverId);
  const dialled = resolveTransport(server, "default");
  return {
    kind: "cluster-authorized-keys-read",
    targetKind: "server",
    targetId: serverId,
    summary:
      `Read ~/.ssh/authorized_keys on "${server.name}" (${dialled.host}:${server.sshPort}): ${steps.length} steps, changing ` +
      `nothing. Every key line is fingerprinted and named as this manager's own, an operator key placed under a label, or ` +
      `placed by nothing here — which is the only way a key nobody put there on purpose becomes visible.`,
    steps: steps.map((s) => ({ name: s.name, title: s.title })),
    targets: [{ serverId, ownsHost: true, label: server.name }],
    warnings: [],
    requiredSecrets: [],
  };
}
