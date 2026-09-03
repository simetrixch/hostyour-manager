import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { srvId } from "../../kernel/ids.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { CredentialStore } from "../../security/store.ts";
import { getServer, type ServerCredFlags } from "./read.ts";
import type { ServerView } from "../../../shared/api-types.ts";
import { isMasterRole } from "../../../shared/enums.ts";

// Inventory writes for the server lifecycle's entry point.
//
// NOTHING HERE SEALS A PASSWORD, and adding a server takes none. The password of the machine account
// is a run secret the operator enters on the approve card of the run that needs it, held in memory
// for that run and never written down (executor/secrets.ts) — so a machine this manager has never
// reached carries no credential of any kind in the store.
//
// WHAT `purgeBootstrapPassword` IS FOR is the rows sealed before that was true. Such a blob is a
// working way into the machine that survives the machine's own configuration, so the two run kinds
// that shut a password door destroy it in the same breath as the daemon's setting
// (runs/defs/password-login.kit.ts purgeBootstrapPasswordStep): turning sshd's door off and leaving
// this one open would close one of two doors.

const BOOTSTRAP_FP = "bootstrap-password";

export const CreateServerInput = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens only"),
  host: z.string().min(1),
  lanHost: z.string().min(1).optional(),
  /** The address the master's in-cluster components will dial this machine's kube-apiserver on once
   *  it is a slave — the cluster map's apiHost. OPTIONAL, and on a first deployment it is normally
   *  left empty: the address is assigned when the machine registers at the coordinator, which is a
   *  step of the deployment itself, so nobody can state it here beforehand. `declare-tailnet-address`
   *  (runs/defs/deploy-slave.address.ts) fills it from the coordinator's own node list. Stated here
   *  it still wins until that reading runs, which is what an installation with addresses of its own
   *  choosing wants — and mark-slave, which writes the cluster map two steps before the host joins,
   *  reads whatever stands here at that moment (deploy-slave.kit.ts `slaveApiHost`). */
  tailnetHost: z.string().min(1).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1),
  notes: z.string().max(2000).optional(),
  // STRICT, so a field this schema does not name is a refusal and not a silent drop. Adding a server
  // records where a machine is and nothing else; a caller still sending a credential with it is
  // told so rather than watching it disappear.
}).strict();
export type CreateServerInput = z.infer<typeof CreateServerInput>;

/**
 * Destroy the stored bootstrap password for a server, if it holds one. Returns whether there was
 * one to destroy, so the caller's log line can say what happened rather than claiming a removal
 * either way.
 *
 * PURGE and not revoke: revoke keeps the encrypted blob on the row for audit, and the blob IS the
 * password — a door that stays open to anyone who can read the store. purge deletes the row and,
 * on a Vault-backed store, the value behind it, and is idempotent on a server that has none.
 */
export async function purgeBootstrapPassword(creds: CredentialStore, serverId: string): Promise<boolean> {
  const stored = (await creds.list({ serverId, kind: "other" })).filter((c) => c.fingerprint === BOOTSTRAP_FP);
  for (const c of stored) await creds.purge(c.id);
  return stored.length > 0;
}

/** Build the per-server credential flags (hasPassword/hasKey) from the store (the sanctioned
 *  reader — inventory may not import the credentials schema).
 *
 *  `hasKey` EXCLUDES ROTATED KEYS, so it means exactly the door `ctx.ssh()` would open
 *  (executor/context.ts lists with the same filter): a rotated-out key is one the machine has
 *  already stopped taking, and a card claiming a key on its strength would offer run kinds that die
 *  at their first session. The password flag counts every unrevoked row, because a superseded
 *  password is still a password sealed beside the row and the chip exists to say one is there. */
export async function serverCredFlags(creds: CredentialStore): Promise<Map<string, ServerCredFlags>> {
  const map = new Map<string, ServerCredFlags>();
  const flags = (serverId: string): ServerCredFlags => {
    const f = map.get(serverId) ?? { hasPassword: false, hasKey: false };
    map.set(serverId, f);
    return f;
  };
  for (const c of await creds.list({ kind: "ssh_key", excludeRotated: true })) {
    if (c.serverId) flags(c.serverId).hasKey = true;
  }
  for (const c of await creds.list({ kind: "other" })) {
    if (c.serverId && c.fingerprint === BOOTSTRAP_FP) flags(c.serverId).hasPassword = true;
  }
  return map;
}

/** Insert a `bare` server + audit; returns its view. Synchronous, because adding a server writes two
 *  rows of this database and reaches no credential store: a machine nobody has reached yet holds no
 *  credential to seal. */
export function createServer(db: Db, actor: string, input: CreateServerInput): ServerView {
  const id = srvId();
  try {
    db.insert(servers)
      .values({
        id,
        name: input.name,
        host: input.host,
        lanHost: input.lanHost ?? null,
        tailnetHost: input.tailnetHost ?? null,
        sshPort: input.sshPort ?? 22,
        sshUser: input.sshUser,
        notes: input.notes ?? null,
      })
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) {
      throw errValidation(`A server named "${input.name}" or at ${input.host}:${input.sshPort ?? 22} already exists.`);
    }
    throw err;
  }
  writeAudit(db, { actor, action: "server.created", targetKind: "server", targetId: id, detail: { name: input.name, host: input.host } });
  const view = getServer(db, id, new Map([[id, { hasPassword: false, hasKey: false }]]));
  if (!view) throw errValidation("server not found immediately after creation");
  return view;
}

/** Delete a not-yet-clustered server: purge its credentials (hard) then remove the row. Refuses
 *  once a cluster exists (that is a rebuild/remove Run, not a delete). */
export async function deleteServer(db: Db, creds: CredentialStore, actor: string, id: string): Promise<void> {
  const row = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!row) throw errValidation(`server ${id} not found`);
  if (isMasterRole(row.role)) throw errValidation("The master (this manager) cannot be deleted.");
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, id)).get();
  if (cluster) throw errValidation("This server has a cluster — remove the cluster first (a rebuild/remove Run), not delete.");
  for (const c of await creds.list({ serverId: id })) await creds.purge(c.id);
  db.delete(servers).where(eq(servers.id, id)).run();
  writeAudit(db, { actor, action: "server.deleted", targetKind: "server", targetId: id, detail: { name: row.name } });
}
