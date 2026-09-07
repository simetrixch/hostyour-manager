import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import type { Db } from "../db/client.ts";
import type { Config } from "../kernel/config.ts";
import type { CredentialStore } from "../security/store.ts";
import type { Logger } from "../kernel/logger.ts";
import { servers, clusters } from "../db/schema/inventory.ts";
import { srvId, clsId } from "../kernel/ids.ts";
import { writeAudit } from "../db/audit-writer.ts";
import { derivePublicKey } from "../adapters/ssh/keygen.ts";
import { clusterShortName } from "../domains/inventory/cluster-marking.ts";
import { MASTER_ROLES } from "../../shared/enums.ts";

// Boot-time master self-registration (platform architecture).
//
// Big picture: deploy-slave is a two-host Run — it installs MicroK8s on the slave AND builds
// the per-slave management plane ON THE MASTER (this control host). loadMaster()
// (defs/deploy-slave.kit.ts) demands exactly one role=master server row, and ctx.ssh(master)
// (executor/context.ts) needs a sealed ssh_key credential + a pinned host key for it, because
// the Manager SSHes to its OWN host over the LAN. createServer ALWAYS makes role=slave and
// nothing else ever sets role=master, so a freshly re-provisioned Manager has no master and
// no path to one. This seed closes that gap from config the installer supplies (MASTER_* env +
// an ESO-materialized private key + the host-key fingerprint), so a fresh DB self-heals with
// zero manual SQL.
//
// Idempotent + degrade-friendly: safe to run on every boot. If the dedicated secret (hence the
// key file / host-key fp) is not present yet on first boot, the row is still seeded and a
// background reconcile keeps retrying the pin+seal IN-PROCESS until the secret materializes.
// Waiting for "a later boot" is not a strategy: nothing restarts the pod on its own, and the prod
// ESO/Vault-role ordering race (secret lands minutes after boot) leaves the master unpinned +
// unsealed forever. The fp is therefore also read from a FILE — kubelet refreshes secret-volume
// files in a running pod, while an env var never does; that file is what makes restart-free
// convergence possible.

const MASTER_KEY_LABEL = "master SSH key (self)";

// The reconcile's schedule: the FIRST wait, and the ceiling every later wait grows toward by
// doubling. 20s ≈ converge within one attempt of the material landing (ESO retry + kubelet volume
// sync are each O(1min)) without hammering sqlite/Vault. Three minutes is the ceiling, so a Manager
// that has been failing for an hour is still asking, and the failure it logs each time arrives at
// most 20 times an hour — the growing wait IS the rate limit, and nothing else throttles the log.
//
// IT HAS NO DEADLINE, and that is the shape of it. A Manager whose master key is not sealed can
// deploy nothing at all: ctx.ssh(master) has no credential, so deploy-slave refuses at its first
// step. Giving up therefore does not leave the Manager doing less work, it leaves it doing NONE of
// its work, in a state only an operator who reads the log and restarts the pod can leave. That
// happened: on an installation issuing from an authority it minted for itself, every seal failed
// TLS verification, 64 attempts were logged over 20 minutes, the window closed, and the certificate
// the process would have trusted was in place four minutes later with nothing left running to see
// it.
const RECONCILE_FIRST_WAIT_MS = 20_000;
const RECONCILE_MAX_WAIT_MS = 3 * 60_000;

type MasterConfig = NonNullable<Config["master"]>;

let reconcileTimer: NodeJS.Timeout | undefined; // module-level single-flight: one reconcile per process

/** Stop a pending background reconcile. Exported for tests (afterEach) and for the reset route,
 *  which stops it before re-seeding a running pod — the timer is unref()'d, so production shutdown
 *  never needs it. */
export function stopMasterReconcile(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = undefined;
  }
}

/** The host-key fingerprint, read FRESH on every attempt: prefer the mounted file (refreshes in
 *  a running pod), fall back to the static env (fixed at container start; kept for chart/image
 *  skew and dev). Both are trimmed (secret writers often append a newline) and must look like
 *  the shape ssh2-session computes ("SHA256:…") — anything else (e.g. full `ssh-keygen -lf`
 *  output) is treated as "not there yet" so garbage never burns a pin or the fallback chain. */
function readHostKeyFp(m: MasterConfig): { fp: string; fromFile: boolean } | undefined {
  if (m.hostKeyFpFile) {
    try {
      const fp = readFileSync(m.hostKeyFpFile, "utf8").trim();
      if (fp.startsWith("SHA256:")) return { fp, fromFile: true };
      // present but empty/malformed — fall through to the env fallback
    } catch {
      // not materialized yet — fall through to the env fallback
    }
  }
  const env = m.hostKeyFp?.trim();
  if (env && env.startsWith("SHA256:")) return { fp: env, fromFile: false };
  return undefined;
}

/** Insert/reconcile the role=master row, pin its host key, and seal/rotate the self-SSH key.
 *  No-op when config.master is unset (dev/tests). Never throws for an operational miss
 *  (unreadable/rotated key, name collision, drift) — it logs and returns so boot proceeds; only
 *  a genuine DB fault propagates. If the secret material is not there yet, or the credential store
 *  refuses the seal, an unref'd background reconcile retries pin+seal in-process until it converges
 *  (no pod restart needed). */
export async function seedMaster(db: Db, creds: CredentialStore, config: Config, logger: Logger): Promise<void> {
  const m = config.master;
  if (!m) return; // no MASTER_FQDN → nothing to seed

  // ---- 1. Upsert the one role=master row (servers_one_master_uq keeps it singular/race-safe).
  let master = db.select().from(servers).where(inArray(servers.role, [...MASTER_ROLES])).get();
  if (!master) {
    const id = srvId();
    const name = clusterShortName(m.fqdn);
    try {
      db.insert(servers)
        .values({
          id,
          name,
          host: m.fqdn,
          lanHost: m.lanHost ?? null,
          sshPort: m.sshPort,
          sshUser: m.sshUser,
          role: "master",
          status: "healthy", // the master is this running control host, not a box to deploy onto
        })
        .run();
    } catch (err) {
      // A stray inventory row already holds this name or host:port (e.g. someone added
      // "m1" as a slave). Degrade loudly — never crash boot; the operator resolves the
      // conflict and restarts. A genuine DB fault (not a UNIQUE clash) still propagates.
      if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) {
        logger.error(
          { name, host: m.fqdn },
          "cannot seed the role=master row — a server with this name or host:port already exists (a stray slave?); resolve the inventory conflict, then restart the Manager",
        );
        return;
      }
      throw err;
    }
    writeAudit(db, { actor: "system", action: "server.master_seeded", targetKind: "server", targetId: id, detail: { name, host: m.fqdn } });
    logger.info({ id, name, host: m.fqdn, sshUser: m.sshUser }, "seeded the role=master server row (this control host)");
    master = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!master) return; // unreachable in practice; keeps the type narrow
  } else {
    // Reconcile config drift onto the existing row (host/user/lan can change across installs).
    const nextLan = m.lanHost ?? null;
    const drift = master.host !== m.fqdn || master.sshUser !== m.sshUser || (master.lanHost ?? null) !== nextLan || master.sshPort !== m.sshPort;
    if (drift) {
      db.update(servers)
        .set({ host: m.fqdn, sshUser: m.sshUser, lanHost: nextLan, sshPort: m.sshPort })
        .where(eq(servers.id, master.id))
        .run();
      writeAudit(db, { actor: "system", action: "server.master_reconciled", targetKind: "server", targetId: master.id, detail: { host: m.fqdn, sshUser: m.sshUser } });
      logger.warn({ id: master.id, host: m.fqdn, sshUser: m.sshUser }, "reconciled the role=master row to the configured MASTER_* values");
      master = db.select().from(servers).where(eq(servers.id, master.id)).get() ?? master;
    }
  }

  // ---- 1b. Upsert the master self-cluster row. The control host is ALSO a cluster in the
  // inventory (the master hosts the manager pod + a master ArgoCD): consumers may onboard to it, so
  // it must appear in the clusters table like the slaves, with slaveId=NULL (the schema comment marks
  // NULL as the master) and the default planeState. Keyed by serverId (clusters_server_uq: one VM =
  // one cluster) so it is idempotent across boots. Degrade-friendly: a UNIQUE clash on the domain
  // (a stray clusters row already owns m.fqdn) logs + returns, exactly like the server-row handler.
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, master.id)).get();
  if (!cluster) {
    const cid = clsId();
    try {
      db.insert(clusters)
        .values({ id: cid, serverId: master.id, stage: m.stage, domain: m.fqdn, status: "active", slaveId: null })
        .run();
      // Audit + log ONLY on a real insert (inside the try) so a clash below never writes a false
      // "seeded" record.
      writeAudit(db, { actor: "system", action: "cluster.master_seeded", targetKind: "cluster", targetId: cid, detail: { serverId: master.id, domain: m.fqdn, stage: m.stage } });
      logger.info({ id: cid, serverId: master.id, domain: m.fqdn, stage: m.stage }, "seeded the master self-cluster row (this control host)");
    } catch (err) {
      // A stray clusters row already owns this domain (clusters_domain_uq). Degrade loudly — never
      // crash boot; the operator resolves the conflict and restarts. Do NOT return: the master
      // key pin/seal (convergeMaster below) must STILL run — the self-cluster row is a target-picker
      // convenience, not a prerequisite for deploy-slave reaching the master. A genuine DB fault propagates.
      if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) {
        logger.error(
          { serverId: master.id, domain: m.fqdn },
          "cannot seed the master self-cluster row — a cluster with this domain already exists; resolve the inventory conflict, then restart the Manager",
        );
      } else {
        throw err;
      }
    }
  } else if (cluster.stage !== m.stage || cluster.domain !== m.fqdn) {
    // Reconcile config drift onto the existing self-cluster row (stage/domain can change across
    // installs), mirroring the role=master server-row reconcile above.
    db.update(clusters).set({ stage: m.stage, domain: m.fqdn }).where(eq(clusters.id, cluster.id)).run();
    writeAudit(db, { actor: "system", action: "cluster.master_reconciled", targetKind: "cluster", targetId: cluster.id, detail: { domain: m.fqdn, stage: m.stage } });
    logger.warn({ id: cluster.id, domain: m.fqdn, stage: m.stage }, "reconciled the master self-cluster row to the configured MASTER_* values");
  }

  // ---- 2+3. Pin the host key + seal the self-SSH key — factored into the re-runnable
  // convergeMaster() so the background reconcile can retry it when the ESO secret materializes
  // only after boot. Scheduled only when a key file is configured (without one, retrying can
  // never seal anything). It runs until it converges; nothing else can make the Manager usable.
  const converged = await convergeMaster(db, creds, master.id, m, logger);
  if (!converged && m.keyFile) scheduleMasterReconcile(db, creds, master.id, m, logger);
}

/** Re-runnable pin+seal unit (steps 2+3), plus the one thing the master's row is made to say about
 *  the result. Returns true when there is nothing left THIS process can converge — normally: host
 *  key pinned AND the mounted key sealed. Never throws for an operational miss; a genuine DB fault
 *  propagates to the caller (boot fails loud; the reconcile catches + logs instead of crashing a
 *  running server). */
async function convergeMaster(db: Db, creds: CredentialStore, masterId: string, m: MasterConfig, logger: Logger): Promise<boolean> {
  const done = await pinAndSeal(db, creds, masterId, m, logger);
  await stateMasterKey(db, creds, masterId, logger);
  return done;
}

/** What the master's row says while its self-SSH key is not sealed, and what it says once it is.
 *  Read out of the store rather than tracked in a flag, because the store is what deploy-slave asks.
 *
 *  `healthy` on an unsealed master is a claim the process cannot make: the Manager cannot open an
 *  SSH session to its own host, so every deploy-slave onto this installation refuses at its first
 *  step. The operator's screen then shows the machine carrying `degraded` and, beside it, no "key
 *  installed" chip — which is the reason, on the one page the question is asked from.
 *
 *  ONLY these two literals are ever written here. A row a run parked at `provisioning`, `ready`,
 *  `bare` or `undeployed` is that run's own account of the machine, and this seed does not overwrite
 *  it. */
async function stateMasterKey(db: Db, creds: CredentialStore, masterId: string, logger: Logger): Promise<void> {
  const sealed = (await creds.list({ serverId: masterId, kind: "ssh_key", excludeRotated: true })).length > 0;
  const row = db.select().from(servers).where(eq(servers.id, masterId)).get();
  if (!row) return;
  const want = sealed ? "healthy" : "degraded";
  if (row.status === want || (row.status !== "healthy" && row.status !== "degraded")) return;
  db.update(servers).set({ status: want }).where(eq(servers.id, masterId)).run();
  if (sealed) {
    logger.info({ id: masterId }, "master row back to healthy — its self-SSH key is sealed, so deploy-slave can reach this host");
  } else {
    logger.warn({ id: masterId }, "master row set to degraded — its self-SSH key is NOT sealed yet, so deploy-slave to this host refuses; the reconcile keeps trying and logs why each attempt failed");
  }
}

async function pinAndSeal(db: Db, creds: CredentialStore, masterId: string, m: MasterConfig, logger: Logger): Promise<boolean> {
  let master = db.select().from(servers).where(eq(servers.id, masterId)).get();
  if (!master) {
    logger.warn({ id: masterId }, "role=master row vanished while converging — stopping (the next boot re-seeds it)");
    return true; // retrying cannot help
  }

  // ---- 2. Pin the host key (SAME shape a deployment writes: preflightJson.hostKey — getSsh reads it
  // and passes it as hostKeyFingerprint, so the SSH-to-self is authenticated, not MITM-able).
  // The fp is read FRESH each attempt (file first, env fallback) — see readHostKeyFp.
  const fpRead = readHostKeyFp(m);
  if (fpRead) {
    const pf = (master.preflightJson as Record<string, unknown> | null) ?? {};
    // When an fp FILE is configured, the static env may only FILL an absent pin, never
    // OVERWRITE one: a transient file-read miss must not downgrade a file-written pin back to
    // the (possibly rotated-out) boot-time env value. Without a file configured the env keeps
    // its full legacy behavior (fill + update on change).
    const mayWrite = pf.hostKey === undefined || fpRead.fromFile || !m.hostKeyFpFile;
    if (pf.hostKey !== fpRead.fp && mayWrite) {
      db.update(servers).set({ preflightJson: { ...pf, hostKey: fpRead.fp } }).where(eq(servers.id, master.id)).run();
      logger.info({ id: master.id, hostKey: fpRead.fp }, "pinned the master sshd host-key fingerprint on the master row");
      master = db.select().from(servers).where(eq(servers.id, master.id)).get() ?? master;
    }
  }

  // ---- 3. Seal (or rotate) the self-SSH key so ctx.ssh(master) works.
  // excludeRotated ⇒ `current` is the newest ACTIVE key (a rotated-out key is never "current").
  const existing = await creds.list({ serverId: master.id, kind: "ssh_key", excludeRotated: true });
  const current = existing[existing.length - 1]; // newest active (createdAt order)

  if (!m.keyFile) {
    if (!current) {
      logger.warn({ id: master.id }, "MASTER_SSH_KEY_FILE is not set and no key is sealed — deploy-slave cannot reach the master until one is provisioned");
    } else {
      logger.debug({ id: master.id }, "no MASTER_SSH_KEY_FILE — keeping the already-sealed master key");
    }
    return true; // nothing more THIS process can converge without a key file
  }

  let priv: Buffer;
  try {
    priv = readFileSync(m.keyFile);
  } catch {
    // The dedicated secret may not be materialized yet — degrade, don't crash; the background
    // reconcile (or a later boot) retries once the file exists.
    logger.warn({ id: master.id, keyFile: m.keyFile }, "master SSH key file not readable yet (ESO secret pending?) — will retry (background reconcile / a later boot)");
    return false;
  }
  try {
    if (priv.length === 0) {
      logger.warn({ id: master.id, keyFile: m.keyFile }, "master SSH key file is empty (ESO secret pending?) — will retry (background reconcile / a later boot)");
      return false;
    }

    // ENFORCE the pin invariant: a sealed master key ⇒ a host-key pin exists on the row. The
    // key file and the fp come from the same secret but can land at different times; sealing
    // without a pin would let getSsh connect trust-on-first-use (MITM-able). Refuse until the
    // pin is present — the reconcile retries once the fp file (or env, on a restart) arrives.
    // (getSsh also hard-fails an unpinned master, so this is belt-and-braces — but keeping the
    // DB honest matters.)
    const pin = (master.preflightJson as { hostKey?: string } | null)?.hostKey;
    if (!pin) {
      logger.warn({ id: master.id }, "master key file present but no host-key pin — refusing to seal an unpinned key (MITM risk); will retry once the fp (MASTER_SSH_HOST_KEY_FP_FILE / MASTER_SSH_HOST_KEY_FP) is present");
      return false;
    }

    // Parse first (a bad key is an operational miss — distinguish it from a store failure).
    let pub: { publicLine: string; fingerprint: string };
    try {
      pub = derivePublicKey(priv); // reads the bytes BEFORE seal()/rotate() zero them
    } catch (err) {
      logger.warn({ id: master.id, err: err instanceof Error ? err.message : String(err) }, "master SSH key file is not a valid OpenSSH private key — deploy-slave will fail until it is fixed (the reconcile keeps retrying)");
      return false;
    }

    if (current && current.fingerprint === pub.fingerprint) {
      logger.debug({ id: master.id, fingerprint: pub.fingerprint }, "master self-SSH key already sealed (same fingerprint) — nothing to do");
      return true;
    }
    if (current) {
      // The mounted key changed (a FORCE rotation on the host) — rotate in place so the old
      // credential is superseded (rotated_at) and ctx.ssh picks up the new one (list order).
      const ref = await creds.rotate(current.id, { plaintext: priv, fingerprint: pub.fingerprint, publicKey: pub.publicLine });
      logger.info({ id: master.id, from: current.fingerprint, to: pub.fingerprint, credentialId: ref.id }, "master SSH key changed — rotated the sealed credential in place");
      return true;
    }
    await creds.seal({
      kind: "ssh_key",
      label: MASTER_KEY_LABEL,
      plaintext: priv, // seal() memzeroes this buffer
      fingerprint: pub.fingerprint,
      serverId: master.id,
      publicKey: pub.publicLine,
    });
    logger.info({ id: master.id, fingerprint: pub.fingerprint }, "sealed the master self-SSH key — the Manager can now SSH to its own host for deploy-slave");
    return true;
  } catch (err) {
    // seal()/rotate() failed (credential store / Vault) — Vault may still be warming up on a
    // fresh install, so this is retryable, not fatal.
    logger.error({ id: master.id, err: err instanceof Error ? err.message : String(err) }, "could not seal/rotate the master SSH key in the credential store — will retry (background reconcile / a later boot)");
    return false;
  } finally {
    priv.fill(0); // EVERY post-read exit: empty/no-pin/parse-fail/no-op/rotate/seal/store-fail (no-op where seal()/rotate() already zeroed)
  }
}

/** Restart-free self-heal that does not give up: retry convergeMaster after RECONCILE_FIRST_WAIT_MS,
 *  then after twice the wait before it, up to RECONCILE_MAX_WAIT_MS, until it converges. unref()'d —
 *  never keeps the process alive.
 *
 *  A CHAIN OF TIMEOUTS AND NOT AN INTERVAL, because the next wait is armed only once the attempt
 *  before it has settled. That is what makes the growing wait real, and it removes the overlap guard
 *  an interval needed: a slow Vault call can no longer meet the next tick. What is left excluding
 *  overlap is the module-level single-flight below and the single-replica deployment (RWO sqlite ⇒
 *  no cross-pod concurrency).
 *
 *  An attempt must NEVER crash the server: even a DB fault only logs here. */
function scheduleMasterReconcile(db: Db, creds: CredentialStore, masterId: string, m: MasterConfig, logger: Logger): void {
  if (reconcileTimer) return; // single-flight (seedMaster runs once per boot; belt-and-braces)
  let wait = RECONCILE_FIRST_WAIT_MS;
  const arm = (): void => {
    reconcileTimer = setTimeout(attempt, wait);
    reconcileTimer.unref();
  };
  const attempt = (): void => {
    void (async () => {
      try {
        if (await convergeMaster(db, creds, masterId, m, logger)) {
          stopMasterReconcile();
          logger.info({ id: masterId }, "master background reconcile finished — nothing left to converge (normally: host key pinned + self-SSH key sealed)");
          return;
        }
      } catch (err) {
        logger.error({ id: masterId, err: err instanceof Error ? err.message : String(err) }, "master background reconcile attempt failed");
      }
      // A stop that landed while this attempt was awaiting must not be re-armed: the reset route
      // stops the reconcile before it re-seeds, and a test stops it between cases.
      if (reconcileTimer === undefined) return;
      wait = Math.min(wait * 2, RECONCILE_MAX_WAIT_MS);
      arm();
    })();
  };
  logger.info(
    { id: masterId, firstWaitSeconds: RECONCILE_FIRST_WAIT_MS / 1000, maxWaitSeconds: RECONCILE_MAX_WAIT_MS / 1000 },
    "master not fully converged (host-key pin and/or sealed key pending, ESO secret late?) — starting the background reconcile; it doubles its wait up to the ceiling and stops only once it converges",
  );
  arm();
}
