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

// Inventory writes for the server lifecycle's entry point. Under the
// operator's choice a bootstrap password may be STORED with the
// server (sealed in the credential store, kind "other", marked "bootstrap-password") so the
// list offers 1-click adopt. This is a deliberate deviation from the
// never-stored default — accepted under "security later" (plaintext store).
//
// The deviation lasts exactly as long as the adoption: a sealed bootstrap password is a way into
// the machine that survives the machine's own configuration, so adopt destroys it (purgeBootstrap
// Password below, called from the run's purge-bootstrap-password step, beside the one that shuts
// the daemon's door). Turning sshd's password door off and leaving this one open would close one of
// two doors. It is sealed at ONE moment only — when a server is added — so there is no route that
// re-arms it on a machine that has been adopted.

const BOOTSTRAP_FP = "bootstrap-password";

export const CreateServerInput = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens only"),
  host: z.string().min(1),
  lanHost: z.string().min(1).optional(),
  /** The address the master's in-cluster components will dial this machine's kube-apiserver on once
   *  it is a slave — the cluster map's apiHost. Stated here, never probed: deploy-slave writes the
   *  cluster map two steps before the host joins the private network, so there is nothing to read
   *  off the host at the moment the address is needed. */
  tailnetHost: z.string().min(1).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1),
  notes: z.string().max(2000).optional(),
  /** Optional stored bootstrap password. Sealed, never returned. */
  password: z.string().min(1).optional(),
});
export type CreateServerInput = z.infer<typeof CreateServerInput>;

async function sealBootstrapPassword(creds: CredentialStore, serverId: string, name: string, password: string): Promise<void> {
  // Replace any existing bootstrap password for this server (rotate-in-place via revoke+seal).
  for (const c of await creds.list({ serverId, kind: "other" })) {
    if (c.fingerprint === BOOTSTRAP_FP) await creds.revoke(c.id, "replaced");
  }
  await creds.seal({
    kind: "other",
    label: `adopt password for ${name}`,
    plaintext: Buffer.from(password, "utf8"),
    fingerprint: BOOTSTRAP_FP,
    serverId,
  });
}

/** The bootstrap password buffer for a server, or undefined. Caller zeroes it (withOpened). */
export async function openBootstrapPassword(creds: CredentialStore, serverId: string, runId: string): Promise<Buffer | undefined> {
  const c = (await creds.list({ serverId, kind: "other" })).find((x) => x.fingerprint === BOOTSTRAP_FP);
  if (!c) return undefined;
  return creds.open(c.id, { purpose: "cluster-adopt:bootstrap-password", runId });
}

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
 *  reader — inventory may not import the credentials schema). */
export async function serverCredFlags(creds: CredentialStore): Promise<Map<string, ServerCredFlags>> {
  const map = new Map<string, ServerCredFlags>();
  for (const c of await creds.list()) {
    if (!c.serverId) continue;
    const f = map.get(c.serverId) ?? { hasPassword: false, hasKey: false };
    if (c.kind === "ssh_key") f.hasKey = true;
    if (c.kind === "other" && c.fingerprint === BOOTSTRAP_FP) f.hasPassword = true;
    map.set(c.serverId, f);
  }
  return map;
}

/** Insert a `bare` server (+ optionally seal its bootstrap password) + audit; returns its view. */
export async function createServer(db: Db, creds: CredentialStore, actor: string, input: CreateServerInput): Promise<ServerView> {
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
  if (input.password) await sealBootstrapPassword(creds, id, input.name, input.password);
  writeAudit(db, { actor, action: "server.created", targetKind: "server", targetId: id, detail: { name: input.name, host: input.host } });
  // No cluster map is read here, and none states anything about this row yet: a server is registered
  // before it is a cluster, so its projection's release reads "not a cluster yet" either way.
  const view = getServer(db, id, new Map([[id, { hasPassword: Boolean(input.password), hasKey: false }]]), {
    ok: false,
    reason: "the cluster maps are not read when a server is created",
  });
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
