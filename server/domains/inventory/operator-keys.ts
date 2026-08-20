import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { operatorKeys } from "../../db/schema/operator-keys.ts";
import { servers } from "../../db/schema/inventory.ts";
import { opkId } from "../../kernel/ids.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";
import {
  isOperatorKeyLabel, normalizeOperatorPublicKey, readServerAuthorizedKeys, type OperatorKeyIdentity,
} from "../../../shared/operator-keys.ts";
import type { OperatorKeyView } from "../../../shared/api-types.ts";
import type { AuthorizedKeyKind } from "../../../shared/enums.ts";

// The ONE writer of `operator_keys`: a human operator's own SSH public key, so the platform can
// place it on a machine and take it off again.
//
// Nothing here is a secret. The row is a public key line and a label, the label is what a host's
// authorized_keys comment carries, and the private half stays with the person whose key it is.
//
// The audit rows below file under targetKind "credential" — the TARGET_KIND member for a thing that
// grants access to a machine — beside the credential-store's own entries. The two never blur: an
// operator key's id is prefixed `opk_` and a store row's `cred_`.

/** The one key type this controller refuses to store. OpenSSH has disabled `ssh-dss` by default
 *  since 7.0, so a host would accept the line into the file and then never authenticate anyone with
 *  it — a key that looks placed and grants nothing. */
const REFUSED_TYPE = "ssh-dss";

export const CreateOperatorKeyInput = z.object({
  label: z.string().min(1).max(63),
  /** The public key as the operator pasted it — one line, comment optional and dropped. */
  publicKey: z.string().min(1).max(20_000),
});
export type CreateOperatorKeyInput = z.infer<typeof CreateOperatorKeyInput>;

/** One operator-key row, or a NOT_FOUND. The run definitions load the key through this, so a run
 *  planned against a key that has since been deleted fails at plan time with the key's id in the
 *  message rather than placing nothing and reporting success. */
export function loadOperatorKey(db: Db, id: string): typeof operatorKeys.$inferSelect {
  const row = db.select().from(operatorKeys).where(eq(operatorKeys.id, id)).get();
  if (!row) throw errNotFound(`operator key ${id} not found`);
  return row;
}

/** What every server's stored reading says about one fingerprint. THREE outcomes, because they are
 *  three different facts and the middle one is not the absence of the other two:
 *   - `holding`  — a readable reading found the key. The KIND comes along, because the two cases need
 *                  different words: a line under this platform's own marker is one the removal run kind
 *                  can take off, and a line under any other comment is one only a hand edit can.
 *   - `undecided` — a reading EXISTS on the row and this build cannot decode it (a document written by
 *                  a newer controller, or one that fails its own schema). Whether the key is on that
 *                  host is unknown, which is not the same as no.
 *   - neither    — a readable reading that did not find the key, or no reading at all. A server
 *                  nothing has read contributes nothing; its card already says the reading is missing.
 *
 *  Derived from the readings and from nothing else: a placement ledger would go on claiming a key that
 *  a reinstall, a restored home directory or somebody's editor took off the box. */
function serversHolding(db: Db, fingerprint: string): {
  holding: { id: string; name: string; kind: AuthorizedKeyKind }[];
  undecided: string[];
} {
  const holding: { id: string; name: string; kind: AuthorizedKeyKind }[] = [];
  const undecided: string[] = [];
  for (const r of db.select({ id: servers.id, name: servers.name, doc: servers.authorizedKeysJson }).from(servers).all()) {
    const read = readServerAuthorizedKeys(r.doc);
    if (read.kind === "unsupported" || read.kind === "unreadable") {
      undecided.push(r.name);
      continue;
    }
    if (read.kind !== "v0") continue;
    const found = read.facts.keys.find((k) => k.fingerprint === fingerprint);
    if (found) holding.push({ id: r.id, name: r.name, kind: found.kind });
  }
  return { holding, undecided };
}

export function listOperatorKeys(db: Db): OperatorKeyView[] {
  return db
    .select()
    .from(operatorKeys)
    .all()
    .map((r): OperatorKeyView => ({
      id: r.id,
      label: r.label,
      type: r.type,
      fingerprint: r.fingerprint,
      createdAt: r.createdAt.getTime(),
      // Only the servers a READABLE reading found it on — this is a presence claim, and an
      // undecided host is not one. Its own row on the page says so (web/src/authorizedKeysState.ts
      // operatorKeyPlacement returns "unread" for exactly those documents).
      onServerIds: serversHolding(db, r.fingerprint).holding.map((s) => s.id),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every operator key this controller holds, as the pair a reading classifies lines against: the
 *  label a placed line carries in its comment, and the fingerprint that label stands for. The
 *  authorized-keys reading takes it on every run, so a key added or forgotten since the last one is
 *  already accounted for. */
export function listOperatorKeyIdentities(db: Db): OperatorKeyIdentity[] {
  return db.select({ label: operatorKeys.label, fingerprint: operatorKeys.fingerprint }).from(operatorKeys).all();
}

/** Store an operator's public key. The pasted text is normalized to `<type> <base64>` — the comment
 *  the operator's own key carries is dropped, because the comment on the placed line is the marker a
 *  removal keys on and a line may only have one. */
export function createOperatorKey(db: Db, actor: string, input: CreateOperatorKeyInput): OperatorKeyView {
  const label = input.label.trim();
  if (!isOperatorKeyLabel(label)) {
    throw errValidation(
      `"${label}" is not a usable label — lowercase letters, digits and hyphens only, starting with a letter or digit. ` +
      `The label is written into every host's authorized_keys and is what a removal matches on, so it may hold nothing else.`,
    );
  }
  const normalized = normalizeOperatorPublicKey(input.publicKey);
  if (!normalized) {
    throw errValidation("that is not a single OpenSSH public key line — paste one line of the form \"ssh-ed25519 AAAA… you@example.com\"");
  }
  if (normalized.type === REFUSED_TYPE) {
    throw errValidation(`${REFUSED_TYPE} keys are disabled by default in OpenSSH, so this host would accept the line and still refuse the login`);
  }
  const fingerprint = fingerprintPublicKey(normalized.publicKey);
  const id = opkId();
  try {
    db.insert(operatorKeys)
      .values({ id, label, publicKey: normalized.publicKey, type: normalized.type, fingerprint, createdBy: actor })
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) {
      throw errValidation(`an operator key labelled "${label}", or carrying the fingerprint ${fingerprint}, is already stored`);
    }
    throw err;
  }
  writeAudit(db, { actor, action: "operator_key.created", targetKind: "credential", targetId: id, detail: { label, fingerprint } });
  const view = listOperatorKeys(db).find((k) => k.id === id);
  if (!view) throw errValidation("operator key not found immediately after creation");
  return view;
}

/**
 * Forget an operator's key.
 *
 * REFUSED while a stored reading still finds it on a host. Deleting the row does not touch a single
 * machine, and the removal run kind needs the row to know which line to delete — so a row deleted while
 * the key is still out there would leave a working key on the estate that nothing here can take off
 * again: the remove run kind keys on `hostyour-operator:<label>`, and the label goes with the row.
 *
 * The refusal names what clears each host, and it is not the same thing on every host. Where the
 * key sits under this platform's marker, an operator-key-remove run takes it off. Where it sits
 * under any other comment — a colleague's own `ssh-copy-id` line carrying the same key — no run
 * here reaches it, and a message saying "remove it from those servers" would name something this
 * platform cannot do: that line goes by hand on the machine, and the row stays until it has.
 *
 * A host whose reading this build CANNOT DECODE refuses the delete just the same. A host nobody has
 * read is genuinely out of the answer, but a document that exists and does not parse is a reading
 * whose content is unknown — and treating unknown as "the key is not there" is the one reading of it
 * that cannot be taken back, because the row is what the removal needs.
 */
export function deleteOperatorKey(db: Db, actor: string, id: string): void {
  const row = loadOperatorKey(db, id);
  const { holding, undecided } = serversHolding(db, row.fingerprint);
  if (holding.length > 0 || undecided.length > 0) {
    const byRun = holding.filter((s) => s.kind === "operator").map((s) => s.name);
    const byHand = holding.filter((s) => s.kind !== "operator").map((s) => s.name);
    throw errValidation([
      ...(holding.length > 0
        ? [`refusing: the last reading of ${holding.map((s) => s.name).join(", ")} still found this key — once the row is gone, ` +
           `nothing here can name the line to delete.`]
        : [`refusing: whether this key is on ${undecided.join(", ")} cannot be established from here.`]),
      ...(byRun.length > 0 ? [`Take it off ${byRun.join(", ")} with an operator-key-remove run first.`] : []),
      ...(byHand.length > 0
        ? [`On ${byHand.join(", ")} it sits under a comment this platform did not write, so no run here reaches it — that ` +
           `line has to be deleted on the host itself, and the server read again.`]
        : []),
      ...(undecided.length > 0
        ? [`The stored authorized-keys reading of ${undecided.join(", ")} is one this controller cannot read, so it can neither ` +
           `find this key nor rule it out — read ${undecided.length === 1 ? "that server" : "those servers"} again first.`]
        : []),
    ].join(" "));
  }
  db.delete(operatorKeys).where(eq(operatorKeys.id, id)).run();
  writeAudit(db, { actor, action: "operator_key.deleted", targetKind: "credential", targetId: id, detail: { label: row.label, fingerprint: row.fingerprint } });
}
