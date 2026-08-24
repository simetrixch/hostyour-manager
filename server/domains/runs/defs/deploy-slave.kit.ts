import { eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../../../db/client.ts";
import type { StepCtx, Cleanup } from "../../../executor/types.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { errValidation, errNotFound } from "../../../kernel/errors.ts";
import { remoteCmd } from "../../../executor/stepkit.ts";
import { MASTER_ROLES, type Stage, type ClusterTier } from "../../../../shared/enums.ts";
import { errNotConfigured } from "../../../kernel/errors.ts";
import type { PlatformRepo } from "../../../adapters/git/port.ts";
import { removeSlaveMarkingPart, clusterMarkingPath } from "../../inventory/cluster-marking.ts";

// The deploy-slave step-kit: the db lookups, credential idioms,
// timing helpers and compensating actions the steps share. Split out of deploy-slave.ts
// (files ≤400 lines) — the def composes these; nothing here is a step.

/** The platform repo: the WRITER through which the run marks the slave reachable in
 *  clusters/active/<fqdn>.yaml on the books branch — the install branch of the cluster holding the
 *  master role, which is where install.sh put the map — and the reader the pinned ansiwise version is
 *  taken off. Optional because the run is registered unconditionally while the platform repo needs
 *  GITHUB_REPO + GITHUB_WRITE_PAT — absent, the map step fails LOUD with what to configure rather
 *  than deploying a slave the master can never reach.
 *
 *  THE CLONE ADDRESS IS GONE FROM HERE, and it is worth saying why rather than leaving a hole. This
 *  port used to carry the address a MACHINE clones the platform tree from, because place-ansiwise
 *  cloned it with composed bash. Nothing in this manager clones a tree onto a machine any more — a
 *  clone is a `git_clone` row of a program, which reads its origin and its credential out of the
 *  machine's own settings files by NAME (digita-deploy ansiwise/programs/deploy-platform-services.yaml) rather
 *  than taking either through a caller. */
export interface DeploySlavePorts {
  platformRepo?: PlatformRepo;
}

/** WHICH run kind is driving the shared slave step list. The steps are the same either way — what
 *  differs is what a failure means. `deploy` installs a slave that is not live yet, so every step
 *  that creates something arms the compensating action that undoes it. `redeploy` reconciles a slave
 *  that IS live, and arms none of them: `snap remove --purge microk8s`, `--slave-remove` and dropping
 *  the slave part of the cluster map each undo a WORKING slave rather than a half-finished install. */
export type SlaveInstallMode = "deploy" | "redeploy";

/** WHAT the shared slave step list acts on, and when it may know it. The server is always named by
 *  the operator; the FQDN and the stage are not. A redeploy names only the server and reads both off
 *  the cluster row that server already carries — and a run definition's steps() is handed the
 *  persisted params and no database. So the two arrive as a lookup the steps run against ctx.db,
 *  never as strings frozen into the step closures. */
export interface SlaveTarget {
  serverId: string;
  resolve(db: Db): { domain: string; stage: Stage };
}

/** deploy-slave's target: the operator named the FQDN and the stage, so the lookup is a constant. */
export function statedTarget(serverId: string, domain: string, stage: Stage): SlaveTarget {
  return { serverId, resolve: () => ({ domain, stage }) };
}

/** redeploy's target: the ACTIVE cluster the server already carries states both. The lookup is at the
 *  same time the run kind's guard — a server with no active cluster has no machine layer to rebuild — so
 *  the two run kinds can never aim at the same cluster state. */
export function activeClusterTarget(serverId: string): SlaveTarget {
  return {
    serverId,
    resolve: (db) => {
      const server = loadServer(db, serverId);
      const cluster = db.select().from(clusters).where(eq(clusters.serverId, serverId)).get();
      if (!cluster) throw errValidation(`server ${server.name} carries no cluster — there is no machine layer to rebuild; deploy it first`);
      if (cluster.status !== "active") {
        throw errValidation(`cluster ${cluster.id} for ${cluster.domain} is '${cluster.status}' — redeploy rebuilds a LIVE cluster; a planned or provisioning one is deploy-slave's to finish`);
      }
      return { domain: cluster.domain, stage: cluster.stage };
    },
  };
}

/** What the shared slave step list needs beyond its ports. `slaveId`/`tier` describe the cluster ROW
 *  the attest step inserts, so they are deploy-only: a redeploy finds the row already there. */
export interface SlaveInstallInput {
  target: SlaveTarget;
  mode: SlaveInstallMode;
  slaveId?: number | undefined;
  tier?: ClusterTier | undefined;
}

export function requirePlatformRepo(ports: DeploySlavePorts): PlatformRepo {
  if (!ports.platformRepo) {
    throw errNotConfigured(
      "the platform repo is not configured — deploy-slave cannot mark the slave reachable in its cluster map, and without that mark the master's slaves ApplicationSet never generates its management plane. Two settings build it: GITHUB_REPO + GITHUB_WRITE_PAT, and MASTER_FQDN, which names the branch this installation keeps its cluster maps on",
    );
  }
  return ports.platformRepo;
}

/** Bounded wait for the slaves-appset to generate + sync Application <name>-apps (step 5).
 *  The appset's own sync retry backoff maxes at 3m (slaves-appset.yaml); 10 min covers a
 *  cold-bootstrap ArgoCD with margin. Poll cadence keeps the run log readable. */
export const APP_SYNC_TIMEOUT_MS = 10 * 60_000;
export const APP_SYNC_POLL_MS = 10_000;

export function loadServer(db: Db, id: string): typeof servers.$inferSelect {
  const row = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!row) throw errNotFound(`server ${id} not found`);
  return row;
}

/** The address the MASTER's in-cluster components will dial this slave's kube-apiserver on, resolved
 *  ONCE per run and used by everything that states it: the cluster map's apiHost field (prepare-branch),
 *  the `--api-host` the slave composes its own credentials blob on (create-mgmt), the check that the
 *  blob came back carrying that same address, and the plane the register step writes.
 *
 *  Resolved in ONE place because the two sources are independent: the map feeds the ArgoCD cluster
 *  Secret through git, the blob feeds Vault's kubernetes_host, the shared dashboard's kubeconfig and
 *  this process's per-slave kube client. Two resolutions that drift leave the master reaching a slave
 *  for some things and not for others, which reads as a network fault.
 *
 *  `tailnet_host` first — the private network is what makes a slave outside the master's own network
 *  reachable at all — then `lan_host` for a slave that sits in it, then the public `host`. */
export function slaveApiHost(server: typeof servers.$inferSelect): string {
  return server.tailnetHost ?? server.lanHost ?? server.host;
}

/** The one-master invariant (servers_one_master_uq guarantees ≤1; we require exactly 1):
 *  the master hosts the slave-management plane, so deploying a slave without one is
 *  meaningless. A master+slave carries that part and is found here too. */
export function loadMaster(db: Db): typeof servers.$inferSelect {
  const row = db.select().from(servers).where(inArray(servers.role, [...MASTER_ROLES])).get();
  if (!row) throw errValidation("no master server registered — the platform needs exactly one role=master server (this manager's host) before a slave can be deployed");
  return row;
}

/** The master's FQDN (for `--master <fqdn>` and vault.<fqdn>): authoritative source is the
 *  master's own cluster row (domain == its install branch == its FQDN); servers.host is the
 *  fallback — the master is registered by name (m1.example.com), not by IP. */
export function masterFqdnOf(db: Db, master: typeof servers.$inferSelect): string {
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, master.id)).get();
  return cluster?.domain ?? master.host;
}

/** The cluster row is the cross-step channel (attest-target's tx allocated the ordinal onto
 *  it). Returns the FULL row (register keeps provisionedAt stable across re-runs), with
 *  slaveId narrowed to number. */
export function requireSlaveCluster(db: Db, domain: string): Omit<typeof clusters.$inferSelect, "slaveId"> & { slaveId: number } {
  const row = db.select().from(clusters).where(eq(clusters.domain, domain)).get();
  if (!row || row.slaveId === null) throw errValidation(`no cluster row with a slaveId for ${domain} — attest-target must run first`);
  return { ...row, slaveId: row.slaveId };
}

/** The deterministic labels of the two durable slave credentials: step 4 seals under them,
 *  step 7 (and later remove-/rebuild-slave Runs) find them again by kind+label. Keyed on the
 *  slave NAME (unique per servers_name_uq), never the internal ordinal. */
export function credLabels(name: string): { bearer: string; reviewer: string } {
  return {
    bearer: `${name} cluster bearer (argocd-manager)`,
    reviewer: `${name} vault reviewer JWT`,
  };
}

/** Seal a harvested token once, retry-robust. Three paths, each logged (the create-mgmt
 *  incident law: every outcome must be visible in the run log):
 *   - reuse    — an unrevoked credential with the same kind+label+fingerprint (same token
 *                bytes) exists ⇒ a re-run/retry of step 4 never piles up duplicates;
 *   - rotate   — a credential with the same kind+label but a DIFFERENT fingerprint exists
 *                (the token changed: a rebuilt slave, a re-minted emit) ⇒ rotate it in
 *                place (new row, old row marked rotated_at) instead of blind-inserting,
 *                so later remove-/rebuild-slave Runs still find the newest (list order,
 *                adopt's idiom) and provenance stays on the superseded row;
 *   - seal     — no row for this kind+label yet ⇒ a fresh credential. */
export async function sealTokenOnce(ctx: StepCtx, o: { kind: "kubeconfig" | "other"; label: string; serverId: string; token: string }): Promise<string> {
  const fingerprint = "sha256:" + createHash("sha256").update(o.token, "utf8").digest("hex");
  const existing = await ctx.creds.list({ serverId: o.serverId, kind: o.kind });
  const sameLabel = existing.filter((c) => c.label === o.label);
  const match = sameLabel.find((c) => c.fingerprint === fingerprint);
  if (match) {
    ctx.log("meta", `credential "${o.label}" already sealed (${match.id}) — reusing`);
    return match.id;
  }
  const current = sameLabel.at(-1); // the newest row for this kind+label (list order)
  if (current) {
    const ref = await ctx.creds.rotate(current.id, { plaintext: Buffer.from(o.token, "utf8"), fingerprint });
    ctx.log("meta", `credential "${o.label}" carries a changed token — rotated in place (${current.id} → ${ref.id})`);
    return ref.id;
  }
  const ref = await ctx.creds.seal({ kind: o.kind, label: o.label, plaintext: Buffer.from(o.token, "utf8"), fingerprint, serverId: o.serverId });
  ctx.log("meta", `credential "${o.label}" sealed (${ref.id})`);
  return ref.id;
}

/** Find the NEWEST sealed credential for kind+label on this server (adopt's list-order
 *  idiom — a rebuilt slave sealed a fresh row; the last one wins). Step 7's resolver: the
 *  credential store is the sanctioned cross-step channel for the step-4 IDs (a step never
 *  reads another step's checkpoint row — the runs schema is executor-owned). */
export async function newestCredId(ctx: StepCtx, o: { serverId: string; kind: "kubeconfig" | "other"; label: string }): Promise<string | undefined> {
  const list = await ctx.creds.list({ serverId: o.serverId, kind: o.kind });
  return list.filter((c) => c.label === o.label).at(-1)?.id;
}

/** Abortable sleep for the bounded remote waits (steps 5-6). Rejects with name "AbortError"
 *  so the executor records a cancel (not a failure) when the operator aborts mid-wait. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (): void => {
      const e = new Error("aborted while waiting for a remote condition to converge");
      e.name = "AbortError";
      reject(e);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      fail();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Compensating actions. Registered at runtime by the step that creates the resource —
// BEFORE its mutating remote call, because a step that dies halfway leaves a partial
// resource only the cleanup can compensate (all three tolerate already-absent state, so
// early registration is safe). The executor resolves the persisted __cleanups names against
// cleanups() (the adopt.ts pattern); they run ONLY on an explicit
// abort-with-cleanup, never automatically — microk8s-reset-slave is destructive by design.

export const microk8sResetSlaveCleanup: Cleanup = {
  name: "microk8s-reset-slave",
  title: "Remove MicroK8s from the slave (DESTRUCTIVE)",
  run: async (ctx: StepCtx) => {
    const session = await ctx.ssh(); // the slave (the run's ownsHost target)
    // Only the snap goes. The two checkouts — the platform tree at /srv/hostyour-cloud and the
    // catalogue at /srv/ansiwise-catalog — and the binary beside them are what a retry of the run
    // resumes onto, all three placed idempotently by place-ansiwise, so removing them would buy a
    // second download and two more clones and nothing else.
    await remoteCmd(ctx, session, "if snap list microk8s >/dev/null 2>&1; then sudo -n snap remove --purge microk8s; fi", { timeoutMs: 10 * 60_000 });
  },
};

/** The git-side inverse of the map write: drop the slave part again, which takes the cluster out of the
 *  master's slaves ApplicationSet and cascades the teardown of its management plane. The map itself
 *  stays — the cluster keeps its role, stage and build plane. Idempotent by contract: an absent map and
 *  an already-stripped one are both a no-op. Built per run because a cleanup carries no ports of its
 *  own; the def hands it the same PlatformRepo the step wrote through. */
export function removeSlaveMarkingCleanup(ports: DeploySlavePorts): Cleanup {
  return {
    name: "remove-slave-marking",
    title: "Drop the slave part of the cluster map on master",
    run: async (ctx: StepCtx) => {
      const domain = String(ctx.params.domain);
      const { changed } = await removeSlaveMarkingPart(requirePlatformRepo(ports), domain, ctx.runId);
      ctx.log("meta", changed
        ? `dropped the slave part of ${clusterMarkingPath(domain)} on master`
        : `${clusterMarkingPath(domain)} carries no slave part — nothing to drop`);
    },
  };
}
