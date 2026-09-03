import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import type { ServerClusterView, ServerView } from "../../../shared/api-types.ts";
import { MASTER_ROLES, isMasterRole } from "../../../shared/enums.ts";
import { readServerTailnet } from "../../../shared/tailnet.ts";
import { readServerPasswordLogin } from "../../../shared/password-login.ts";
import { readServerAuthorizedKeys } from "../../../shared/operator-keys.ts";

/** Per-server credential presence (never values). Computed in the API layer from the store
 *  (only-store-writes-creds forbids inventory touching the credentials schema). */
export interface ServerCredFlags {
  hasPassword: boolean;
  hasKey: boolean;
}

/**
 * Inventory read projections. Map DB rows to the wire ServerView — projection is
 * the trust boundary: machineId and notes never leave the server, and of preflightJson only the one
 * field named below does.
 * Sorted master-first (the one-master index is the sort key), then by name.
 *
 * The tailnet pair DOES cross: the stored document is parsed here, through the version-narrowing
 * reader, so the browser receives a named outcome instead of raw JSON it would have to trust. Its
 * one address field is an internal address of the same kind as `lanHost`, which this projection has
 * always carried, and the run id it names is already public on the runs list. `tailnetHost` crosses
 * for the same reason and one more: it is what the card has to show for the operator to see WHICH
 * address the master will dial, which is the whole question the card exists to answer.
 *
 * The password-login pair crosses through the same version-narrowing reader. It carries three
 * `sshd -T` values and no secret: what a daemon answers to a stranger who connects to port 22 is
 * already public to that stranger, and this projection is what lets the operator learn it first.
 *
 * The authorized-keys pair crosses too, and carries fingerprints and comments rather than key
 * bodies. A fingerprint is this codebase's public, non-secret identifier for a key; the browser is
 * where the operator finds out that a machine lets somebody in, so withholding the reading would
 * defeat the only surface the question has.
 *
 * The machine's own CLUSTER crosses as three fields — the branch, the stage and the row's status.
 * A domain is the cluster's FQDN, which every certificate and every DNS record already publishes;
 * the other two are inventory facts the Clusters page carries. They cross because a card that
 * offers a run over the machine's own cluster has to state the branch and the stage that run will
 * act on: a person approves the act on those two words, and asking them to re-type values the row
 * already holds is how a run gets aimed at a branch its cluster does not stand on.
 *
 * `hostKeyPinned` is the ONE field of preflightJson that crosses, and it crosses on the same
 * reasoning: an sshd presents its host key to everyone who opens a connection to its port, so the
 * fingerprint is public to every stranger before it is public here. It crosses because a person who
 * rebuilt a machine has to compare the recorded number with the one they read on its console, and
 * saying which machine identity this manager holds is what makes that comparison possible
 * (domains/inventory/machine-identity.ts). The rest of the document — the preflight checks and the
 * timestamps — stays on this side.
 *
 * The machine-id crosses as `machineIdRecorded`, a BOOLEAN and never the value: the identity that
 * statement replaces is two numbers, and the card offers it only where one of them is there to
 * replace. What a machine's /etc/machine-id IS stays on this side, because unlike a host key no
 * machine presents it to anybody who connects.
 */
/** The three fields of a machine's own cluster row that cross to its card, or null for a machine
 *  that keeps no cluster. */
function clusterView(row: typeof clusters.$inferSelect | undefined): ServerClusterView | null {
  return row ? { domain: row.domain, stage: row.stage, status: row.status } : null;
}

export function listServers(db: Db, flags: Map<string, ServerCredFlags> | undefined): ServerView[] {
  // A machine keeps ONE cluster (clusters_server_uq), so the table is read once and indexed by
  // machine rather than looked up per row.
  const clusterOf = new Map(db.select().from(clusters).all().map((c) => [c.serverId, c]));
  return db
    .select()
    .from(servers)
    .all()
    .map(
      (r): ServerView => ({
        id: r.id,
        name: r.name,
        host: r.host,
        lanHost: r.lanHost ?? null,
        tailnetHost: r.tailnetHost ?? null,
        sshPort: r.sshPort,
        sshUser: r.sshUser,
        role: r.role,
        status: r.status,
        cluster: clusterView(clusterOf.get(r.id)),
        tailnetState: r.tailnetState,
        tailnet: readServerTailnet(r.tailnetJson),
        passwordLoginState: r.passwordLoginState,
        passwordLogin: readServerPasswordLogin(r.passwordLoginJson),
        authorizedKeysState: r.authorizedKeysState,
        authorizedKeys: readServerAuthorizedKeys(r.authorizedKeysJson),
        hostKeyPinned: (r.preflightJson as { hostKey?: string } | null)?.hostKey ?? null,
        machineIdRecorded: r.machineId !== null,
        createdAt: r.createdAt.getTime(),
        adoptedAt: r.adoptedAt ? r.adoptedAt.getTime() : null,
        hasPassword: flags?.get(r.id)?.hasPassword ?? false,
        hasKey: flags?.get(r.id)?.hasKey ?? false,
      }),
    )
    .sort((a, b) => Number(isMasterRole(b.role)) - Number(isMasterRole(a.role)) || a.name.localeCompare(b.name));
}

/** One server's wire projection, or undefined. Same trust-boundary rules as listServers. */
export function getServer(db: Db, id: string, flags: Map<string, ServerCredFlags> | undefined): ServerView | undefined {
  return listServers(db, flags).find((s) => s.id === id);
}

/** The master's FQDN, derived — never typed (derive-dont-type). Authoritative source is the
 *  master's own cluster row (domain == its install branch == its FQDN); servers.host is the
 *  fallback (the master is registered by name, not IP) — the same precedence as
 *  masterFqdnOf in runs/defs/deploy-slave.kit.ts. Undefined when no master row exists yet. */
export function masterFqdn(db: Db): string | undefined {
  const master = db.select().from(servers).where(inArray(servers.role, [...MASTER_ROLES])).get();
  if (!master) return undefined;
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, master.id)).get();
  return cluster?.domain ?? master.host;
}

/**
 * The branch this installation keeps its BOOKS on — its cluster maps, its consumer registrations and
 * its tenant registrations (shared/branches.ts). It is the install branch of the cluster holding the
 * master role, so the value IS that cluster's FQDN: the schema states the equivalence on the column
 * this reads (db/schema/inventory.ts, clusters.domain == install branch), and the deployment
 * programs derive the same name for their own writes (the books-cluster answer).
 *
 * MASTER_FQDN wins over the row, and the order is the point rather than a preference. seedMaster
 * REWRITES clusters.domain to the configured value on every boot (boot/seed-master.ts), so the row is
 * a copy of it and never a second opinion — but this value is resolved while the ports are built,
 * which happens BEFORE that rewrite. Reading the row first would bind a whole process to the
 * PREVIOUS master's FQDN after a master replacement: every registration and every cluster map would
 * be committed onto a branch no generator reads, while the runs that lock on the master's FQDN at
 * plan time (runs/defs/deploy-slave.kit.ts, masterFqdnOf) already name the new one. Taking the
 * configured value first makes the two agree at every moment, before and after the seed. The row
 * still answers where nothing is configured.
 *
 * A Manager-side job with no database of its own (the registry reaper, on an emptyDir) has only
 * the configured value in the first place.
 *
 * Undefined when neither exists: there is then no answer to "where do this installation's books
 * stand", and every caller must refuse rather than fall back to the trunk — a registration written to
 * the trunk is one no cluster reads and every future installation inherits.
 */
export function booksBranch(db: Db, configuredMasterFqdn: string | undefined): string | undefined {
  return configuredMasterFqdn ?? masterFqdn(db);
}
