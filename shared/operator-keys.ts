// An operator's own SSH key, and what a host's ~/.ssh/authorized_keys holds — the half both ends
// read.
//
// THE TWO MARKERS ARE THE WHOLE SAFETY PROPERTY. Every line this platform writes into an
// authorized_keys file carries a comment that says who put it there, and a removal deletes lines by
// that comment and by nothing else:
//
//   hostyour:<server name>          the MANAGER's own login identity for that one host,
//                                        written by `install-key` and deleted by the compensation
//                                        a first install arms (manager-key.kit.ts).
//   hostyour-operator:<label>       ONE human's key, placed under the label it was added
//                                        under, and deleted by the operator-key-remove run.
//
// They cannot collide in either direction, and that is by construction rather than by care: the
// manager marker is `hostyour` followed immediately by a colon, the operator marker is
// `hostyour` followed by `-operator`, and a label may not contain a colon at all. So a removal
// aimed at an operator can never match the manager's line — which would take this platform's own
// way into the machine away — and that compensation can never strip a human's key.
//
// A LABEL IS ALSO WHAT MAKES THE PATTERN SAFE. The removal is a `grep` pattern built from the
// label, and the label charset below (lowercase, digits, hyphen) contains no regular-expression
// metacharacter and no shell quote, so no label can widen the pattern past the one line it names.
// Validating the label is therefore not input hygiene, it is what keeps the pattern from matching
// something it was never aimed at.
import { z } from "zod";
import type { AuthorizedKeyFact, ServerAuthorizedKeysFacts, ServerAuthorizedKeysRead } from "./api-types.ts";
import { AUTHORIZED_KEY_KIND, type AuthorizedKeyKind, type ServerAuthorizedKeysState } from "./enums.ts";

/** The comment `generate-key` puts on the key it draws for a server, and the pattern the removal
 *  deletes by. Named here so the two sides of that pair, and the operator marker that must never
 *  match it, are stated in one place. */
export function managerKeyMarker(serverName: string): string {
  return `hostyour:${serverName}`;
}

/** What every operator-key comment starts with. The `-operator` is what keeps it out of the
 *  manager marker above: `hostyour:` never appears in it. */
export const OPERATOR_MARKER_PREFIX = "hostyour-operator:";

export function operatorKeyMarker(label: string): string {
  return `${OPERATOR_MARKER_PREFIX}${label}`;
}

/** Lowercase letters, digits and hyphens — the same shape a server name takes, and for a stronger
 *  reason: this string is interpolated into the grep pattern a removal runs on the host. */
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isOperatorKeyLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

/** The shape of an OpenSSH key-type field. A SHAPE and not a list of the types OpenSSH ships,
 *  because the reading has to describe whatever is in the file — including a type this build has
 *  never heard of — and a list would quietly report such a line as unparsable garbage. */
const KEY_TYPE_RE = /^(ssh-[a-z0-9]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/;

const BLOB_RE = /^[A-Za-z0-9+/]{40,}={0,3}$/;

export interface ParsedAuthorizedKey {
  type: string;
  /** The base64 key body — what a fingerprint is taken over. */
  blob: string;
  /** Everything after the blob, verbatim and possibly empty. */
  comment: string;
}

/**
 * Split one authorized_keys line into type, blob and comment, or null when it is not a key line.
 *
 * The type is found by SHAPE rather than by position, because a line may legitimately start with an
 * options list — `command="…",no-pty ssh-ed25519 AAAA… someone@somewhere` is a valid entry, and
 * taking the second whitespace-separated field as the blob (which is what a naive split does) would
 * fingerprint the string "ssh-ed25519" for it and report a key that is not there.
 *
 * The shape is a PAIR — a type field with a blob straight after it — and the search runs on past a
 * field that only looks like a type. An options value may contain the words themselves
 * (`command="echo ssh-ed25519 denied" ssh-ed25519 AAAA… x` is one line sshd accepts and
 * authenticates with), and stopping at the first match would report that line as unreadable while
 * the key on it goes on granting access.
 */
export function parseAuthorizedKeysLine(line: string): ParsedAuthorizedKey | null {
  const fields = line.trim().split(/\s+/);
  for (const [at, field] of fields.entries()) {
    const blob = fields[at + 1];
    if (!KEY_TYPE_RE.test(field) || blob === undefined || !BLOB_RE.test(blob)) continue;
    return { type: field, blob, comment: fields.slice(at + 2).join(" ") };
  }
  return null;
}

/** Is this line one sshd would even look at? Blank lines and `#` comments are neither keys nor
 *  broken keys, so they are counted as nothing at all. */
export function isAuthorizedKeysEntry(line: string): boolean {
  const text = line.trim();
  return text !== "" && !text.startsWith("#");
}

/**
 * Normalize an operator's pasted public key to the line this manager stores: `<type> <blob>`,
 * with whatever comment the operator pasted DROPPED.
 *
 * The comment is dropped rather than kept because the placed line's comment is the marker, and a
 * key whose stored line already carried `pat@laptop` would end up on the host with two comments —
 * the second one is where the marker would sit, and the removal pattern is anchored at the end of
 * the line. Returns null when the text is not a single public key.
 */
export function normalizeOperatorPublicKey(pasted: string): { publicKey: string; type: string } | null {
  const lines = pasted.split("\n").filter((l) => isAuthorizedKeysEntry(l));
  if (lines.length !== 1) return null;
  const parsed = parseAuthorizedKeysLine(lines[0] ?? "");
  if (!parsed) return null;
  return { publicKey: `${parsed.type} ${parsed.blob}`, type: parsed.type };
}

/** The full line an operator key is placed as: the normalized key, then the marker as its comment.
 *  The marker is LAST on the line, which is what lets the removal anchor its pattern at the end and
 *  so refuse to match a label that merely starts the same way. */
export function operatorKeyLine(publicKey: string, label: string): string {
  return `${publicKey} ${operatorKeyMarker(label)}`;
}

/** What this manager knows about one operator key it holds: the label the line on a host carries
 *  and the fingerprint of the key that label stands for. */
export interface OperatorKeyIdentity {
  label: string;
  fingerprint: string;
}

/**
 * Who a key line belongs to. The FINGERPRINT decides, never the comment: a comment is text on the
 * host, and anyone who can append to the file can type either marker into it.
 *
 * "manager" is a fingerprint match against the ssh_key credentials sealed for this server. That
 * one signal covers both ways a manager key gets onto a host: `generate-key` seals the key it draws
 * before it installs the line, and the boot seed seals the master's key it reads from a file — so
 * every line this manager can log in with is one whose fingerprint it holds. The marker comment
 * `generate-key` writes is for the REMOVAL grep, not for classification: honoring it here would let a
 * stranger's key reading `ssh-ed25519 <their key> hostyour:s1` report as the manager's own,
 * fold the file to "accounted", and hide a working way into the machine behind the very card that
 * exists to surface it.
 *
 * "operator" takes BOTH its marker and a stored key: the label names which row, and the fingerprint
 * must be the one this manager stores under that very label. Anything else is a key nothing here
 * placed, which is exactly what "foreign" means. Passing no keys at all (a manager that holds
 * none) therefore makes every marker line foreign, which is the truth about such a host.
 */
export function classifyAuthorizedKey(
  key: { fingerprint: string; comment: string },
  ctx: { managerFingerprints: readonly string[]; operatorKeys: readonly OperatorKeyIdentity[] },
): { kind: AuthorizedKeyKind; label: string | null } {
  if (ctx.managerFingerprints.includes(key.fingerprint)) {
    return { kind: "manager", label: null };
  }
  if (key.comment.startsWith(OPERATOR_MARKER_PREFIX)) {
    const label = key.comment.slice(OPERATOR_MARKER_PREFIX.length);
    const held = ctx.operatorKeys.find((k) => k.label === label);
    if (held && held.fingerprint === key.fingerprint) return { kind: "operator", label };
  }
  return { kind: "foreign", label: null };
}

/**
 * ServerAuthorizedKeys **v0** — one reading of a host's authorized_keys file.
 *
 * `satisfies z.ZodType<ServerAuthorizedKeysFacts>` pins the parsed shape to the ONE wire
 * declaration (shared/api-types.ts), so the two cannot drift apart in a green build.
 */
const ServerAuthorizedKeysV0 = z.object({
  v: z.literal(0),
  observedAt: z.number().int().positive(),
  runId: z.string().min(1),
  keys: z.array(z.object({
    fingerprint: z.string().min(1),
    type: z.string().min(1),
    comment: z.string(),
    kind: z.enum(AUTHORIZED_KEY_KIND),
    label: z.string().min(1).nullable(),
  })),
  unparsed: z.number().int().nonnegative(),
}) satisfies z.ZodType<ServerAuthorizedKeysFacts>;

/** Just the version, read on its own so an unknown version is answered as such instead of failing
 *  the whole body's schema and reading as corruption. */
const Versioned = z.object({ v: z.number().int() });

/** Read a stored authorized-keys document: narrow on `v` FIRST, parse the body only for a version
 *  this build knows, and name every other outcome instead of collapsing it to null. */
export function readServerAuthorizedKeys(stored: unknown): ServerAuthorizedKeysRead {
  if (stored === null || stored === undefined) return { kind: "none" };
  const versioned = Versioned.safeParse(stored);
  if (!versioned.success) return { kind: "unreadable", reason: "no version field" };
  if (versioned.data.v !== 0) return { kind: "unsupported", v: versioned.data.v };
  const parsed = ServerAuthorizedKeysV0.safeParse(stored);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { kind: "v0", facts: parsed.data };
}

/** What the host said about its own file, straight off the probe. `readable` is separate from the
 *  lines because a run that could not open the file has measured NOTHING, and reporting that
 *  silence as "no keys found" would state as fact the exact thing the run failed to measure. */
export interface AuthorizedKeysProbe {
  readable: boolean;
  keys: AuthorizedKeyFact[];
  unparsed: number;
}

/** Fold one probe into the pair the row stores: the state the card keys on, and the document that
 *  says where that state came from. Written together, in one statement, by one step.
 *
 *  "accounted" is claimed only when the file was READ and every line in it is one this platform can
 *  name. Three things break that claim and all three land on "unaccounted": a file that could not
 *  be opened at all (an unread file is not a clean one), a key line placed by nothing here, and a
 *  line this parser could not read. The last one counts because the two parsers are not the same
 *  one: a certificate line, or a key type this build has never heard of, is unreadable HERE and
 *  authenticates on the host — so a line nobody can name must not be folded into a file where
 *  everything is named. */
export function authorizedKeysReading(
  probe: AuthorizedKeysProbe,
  meta: { runId: string; observedAt: number },
): { state: ServerAuthorizedKeysState; doc: ServerAuthorizedKeysFacts } {
  const state: ServerAuthorizedKeysState = !probe.readable
    ? "unreadable"
    : probe.keys.some((k) => k.kind === "foreign") || probe.unparsed > 0
      ? "unaccounted"
      : "accounted";
  return {
    state,
    doc: { v: 0, observedAt: meta.observedAt, runId: meta.runId, keys: probe.keys, unparsed: probe.unparsed },
  };
}

/** Does this reading show the key with `fingerprint` on the host? Used by the two acts to take
 *  their verdict from the host's own file rather than from the exit code of the edit they just
 *  made — a key sitting under a comment this platform did not write is not removed by a removal
 *  that deletes by marker, and only the read-back says so. */
export function authorizedKeysHold(read: ServerAuthorizedKeysRead, fingerprint: string): boolean {
  return read.kind === "v0" && read.facts.keys.some((k) => k.fingerprint === fingerprint);
}
