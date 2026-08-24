// Reading WHO a host lets in, and recording it on the server row.
//
// WHAT IS READ. `~/.ssh/authorized_keys` of the login user this manager connects as — the same
// file the adopt run appends the manager's own key to, and the same file the two operator-key
// acts edit. It is sshd's default and every host this platform installs uses it.
//
// WHAT IS THEREFORE NOT READ, and it is a real limit rather than an oversight: sshd can be told to
// take keys from somewhere else entirely (`AuthorizedKeysFile` naming another path, or
// `AuthorizedKeysCommand` producing them from a program), and a key granted that way is invisible
// here. This reading describes the file, and the card says so; it does not claim to enumerate every
// way into the machine.
//
// THE HOST SENDS LINES, THE CONSOLE DECIDES WHAT THEY ARE. The script prints the file verbatim and
// makes no judgement at all: fingerprints are taken here with node's own crypto (the same function
// that produced every fingerprint this manager has ever stored), and each line is classified
// against two things only this side knows — the fingerprints of the ssh_key credentials sealed for
// this server, and the operator keys this manager holds. A host-side classification would have
// to be handed both, which is how a script ends up carrying the answer it was supposed to measure.
//
// No line is classified by its comment: a comment is text on the machine, and anyone who can
// append to authorized_keys can write either marker into it. The markers exist for the removal
// grep, never for this reading.
import { eq } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import { servers } from "../../db/schema/inventory.ts";
import { remoteScriptCapture, localTx } from "../../executor/stepkit.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";
import { errNotFound } from "../../kernel/errors.ts";
import {
  authorizedKeysReading, classifyAuthorizedKey, isAuthorizedKeysEntry,
  parseAuthorizedKeysLine, readServerAuthorizedKeys,
  type AuthorizedKeysProbe, type OperatorKeyIdentity,
} from "../../../shared/operator-keys.ts";
import { listOperatorKeyIdentities } from "../inventory/operator-keys.ts";
import type { AuthorizedKeyFact, ServerAuthorizedKeysRead } from "../../../shared/api-types.ts";
import type { ServerAuthorizedKeysState } from "../../../shared/enums.ts";

/**
 * The probe. `AKEYS readable|unreadable` first, then one `AKEY <line>` per line of the file,
 * verbatim. Every path exits 0 — a non-zero exit means the reading never happened, and
 * recordAuthorizedKeysReading keeps the stored reading in that case rather than replacing a
 * measurement with a guess.
 *
 * No sudo anywhere: the file belongs to the user this session authenticated as, and a probe that
 * escalated could read a file the login it is describing would never use.
 */
export const AUTHORIZED_KEYS_PROBE_SCRIPT = `#!/usr/bin/env bash
ak="$HOME/.ssh/authorized_keys"
if [ ! -f "$ak" ] || [ ! -r "$ak" ]; then
  echo "AKEYS unreadable"
  exit 0
fi
echo "AKEYS readable"
# The last line of a hand-edited file often has no terminating newline; the '|| [ -n "$line" ]'
# is what stops read dropping it, and a dropped line here is a key nobody would ever be shown.
while IFS= read -r line || [ -n "$line" ]; do
  printf 'AKEY %s\\n' "$line"
done < "$ak"
exit 0
`;

/**
 * Turn the probe's stdout into the facts: fingerprint every key line, classify each one, and count
 * the lines that are neither blank, nor a `#` comment, nor parsable as a key.
 *
 * `managerFingerprints` are the fingerprints of the ssh_key credentials sealed for THIS server —
 * rotated ones included, because a superseded key can still be sitting in the file and reporting it
 * as a stranger's would be false. They are the ONLY thing that makes a line "manager": the
 * marker comment adopt writes is not consulted (anyone with a shell can type it into the file).
 * `operatorKeys` is every operator key this manager holds, which is what makes an operator line
 * a fact rather than a comment somebody typed.
 */
export function parseAuthorizedKeysProbe(
  stdout: string,
  ctx: { managerFingerprints: readonly string[]; operatorKeys: readonly OperatorKeyIdentity[] },
): AuthorizedKeysProbe {
  const lines = stdout.split("\n").map((l) => l.trimEnd());
  const keys: AuthorizedKeyFact[] = [];
  let unparsed = 0;
  for (const line of lines) {
    const m = /^AKEY (.*)$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const entry = m[1];
    if (!isAuthorizedKeysEntry(entry)) continue;
    const parsed = parseAuthorizedKeysLine(entry);
    if (!parsed) {
      unparsed += 1;
      continue;
    }
    const fingerprint = fingerprintPublicKey(`${parsed.type} ${parsed.blob}`);
    const { kind, label } = classifyAuthorizedKey({ fingerprint, comment: parsed.comment }, ctx);
    keys.push({ fingerprint, type: parsed.type, comment: parsed.comment, kind, label });
  }
  return { readable: lines.includes("AKEYS readable"), keys, unparsed };
}

/** What the caller gets back: the state written, and the document behind it, so a step can take its
 *  own verdict from what the host actually holds instead of from the exit code of the edit it made.
 *  `null` when the probe did not run at all — nothing is written and the row keeps what it had. */
export interface AuthorizedKeysReadingResult {
  state: ServerAuthorizedKeysState;
  read: ServerAuthorizedKeysRead;
}

/**
 * Read the host and write the pair. State and document go down in ONE statement, so a reading can
 * never be stored without the moment and the run that produced it.
 *
 * The reading never fails its own step. A caller that needs the file to hold (or not hold) a
 * particular key asserts that itself, loudly, against the document returned here — a reading that
 * could not be taken must not be the thing that ends a run.
 */
export async function recordAuthorizedKeysReading(
  ctx: StepCtx,
  session: SshSession,
  serverId: string,
): Promise<AuthorizedKeysReadingResult | null> {
  const row = ctx.db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).get();
  if (!row) throw errNotFound(`server ${serverId} not found`);
  const sealed = await ctx.creds.list({ serverId, kind: "ssh_key" });
  const cap = await remoteScriptCapture(ctx, session, "authorized-keys-probe", AUTHORIZED_KEYS_PROBE_SCRIPT, { timeoutMs: 60_000 });
  if (cap.result.code !== 0) {
    ctx.log("meta", `Authorized keys: the probe did not run (exit ${cap.result.code}) — this server's stored reading is unchanged.`);
    return null;
  }
  const probe = parseAuthorizedKeysProbe(cap.stdout, {
    managerFingerprints: sealed.map((c) => c.fingerprint),
    operatorKeys: listOperatorKeyIdentities(ctx.db),
  });
  const reading = authorizedKeysReading(probe, { runId: ctx.runId, observedAt: Date.now() });
  localTx(ctx, (tx) =>
    tx.update(servers).set({ authorizedKeysState: reading.state, authorizedKeysJson: reading.doc }).where(eq(servers.id, serverId)).run(),
  );
  const byKind = (kind: string): number => reading.doc.keys.filter((k) => k.kind === kind).length;
  ctx.log(
    "meta",
    `Authorized keys: ${reading.state} — ${reading.doc.keys.length} key(s) in ~/.ssh/authorized_keys ` +
    `(${byKind("manager")} this manager's, ${byKind("operator")} operator, ${byKind("foreign")} placed by nothing here` +
    `${reading.doc.unparsed > 0 ? `, ${reading.doc.unparsed} line(s) this manager could not read as a key` : ""}); only a run takes a new reading.`,
  );
  for (const k of reading.doc.keys.filter((x) => x.kind === "foreign")) {
    ctx.log("meta", `  foreign key ${k.fingerprint} (${k.type})${k.comment ? ` — comment: ${k.comment}` : " — no comment"}`);
  }
  return { state: reading.state, read: readServerAuthorizedKeys(reading.doc) };
}
