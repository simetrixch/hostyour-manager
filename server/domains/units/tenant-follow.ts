// Tenants that follow releases (hostyour-manager#328). A release moves only the stage pin, and a tenant
// keeps the versions it holds until its Versions run moves them (tenant-versions.ts). A tenant whose
// followReleases is on is moved by the Manager instead: when a release run of a part it renders
// succeeds at its stage, the Manager plans and approves that same Versions run, to the version the
// stage pins. Nothing here writes a version: the run does, with its record in the run list, its
// engine-line refusal and its restore on abort.
//
// A CHECK AND NOT A REPLAY. Every event only asks "does a following tenant lag its stage pins?", so a
// duplicate event changes nothing, and the same check serves the Manager's start (a release that
// finished while it was down) and a switch turned on (the tenant catches up at once).
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import type { Executor } from "../../executor/executor.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RunStatus, Stage } from "../../../shared/enums.ts";
import type { ReleaseRunSucceeded } from "../../adapters/build-plane/port.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { tenantVersionParts, type TenantVersionPart } from "./tenant-versions.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { MEMBERS_CHANGED } from "./tenant-refresh-members.run.ts";

/** How long one wait of a check may last before the log says that every later check waits behind it. */
const LONG_WAIT_MS = 30 * 60_000;

export interface TenantFollowDeps {
  db: Db;
  executor: Pick<Executor, "planStreamed" | "settle" | "approve" | "discard">;
  /** How a run stands once it settled: its status and, where it failed, its error (executor/read.ts getRunEnding). */
  runEnding: (runId: string) => { status: RunStatus; error: string | null } | undefined;
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds">;
  logger: Logger;
}

/** The version each part moves to: its stage pin, where the pins of all its builds name one version
 *  and a member runs another. A part whose builds' pins disagree is left as it is: its release is
 *  still being pinned, and its own event follows. */
export function followedVersions(parts: readonly TenantVersionPart[]): Record<string, string> {
  const moves: Record<string, string> = {};
  for (const part of parts) {
    const pins = [...new Set(part.builds.map((b) => b.pin))];
    if (pins.length !== 1) continue;
    const pin = pins[0]!;
    if (part.running.length === 1 && part.running[0] === pin) continue;
    moves[part.name] = pin;
  }
  return moves;
}

/** Wait until `runId` settles. The checks wait one after another, so a run that never settles holds
 *  every later check back: past LONG_WAIT_MS the log says so. */
async function settle(deps: TenantFollowDeps, runId: string): Promise<void> {
  const warn = setTimeout(() => deps.logger.warn({ runId }, `a check of the tenants that follow releases has waited ${LONG_WAIT_MS / 60_000} minutes for run ${runId}, and every later check waits behind it`), LONG_WAIT_MS);
  warn.unref?.();
  try {
    await deps.executor.settle(runId);
  } finally {
    clearTimeout(warn);
  }
}

/** Approve `runId`. Every tenant run takes the books branch, so a second one waits in the queue for
 *  the run that holds it, however long that takes; said when the wait starts, so the log shows it. */
async function approveInQueue(deps: TenantFollowDeps, runId: string): Promise<void> {
  const { status } = await deps.executor.approve(runId);
  if (status === "queued") deps.logger.info({ runId }, `the Versions run ${runId} waits in the queue for the run that holds the tenant`);
}

/** One check of one tenant, answered as a sentence for the log. A refresh that another run's member
 *  write overtook while it waited for the tenant is planned once more against the members as they then
 *  stand; a refresh that did not succeed is said to have moved nothing, at warn, with its run. */
export async function followTenant(deps: TenantFollowDeps, tenantId: string): Promise<string> {
  const row = deps.db.select({ followReleases: tenants.followReleases, status: tenants.status, suspended: tenants.suspended, subdomain: tenants.subdomain }).from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!row?.followReleases) return `tenant ${tenantId} does not follow releases`;
  if (row.status !== "active" || row.suspended) return `tenant ${row.subdomain} is ${row.suspended ? "suspended" : row.status}, and only an active tenant follows releases`;
  const tc = loadTenantCluster(deps.db, tenantId);
  for (let attempt = 1; ; attempt++) {
    const read = await deps.ports.registrations.readTenant(tc.stage, tc.guid);
    if (!read) return `tenant ${tc.guid} has no registration at ${tc.stage}`;
    const versions = followedVersions(await tenantVersionParts(deps.ports, tc.stage, read.entry.members, read.entry.approvedTags));
    const moves = Object.entries(versions).map(([part, tag]) => `${part} to ${tag}`).join(", ");
    if (moves === "") return `tenant ${tc.subdomain} at ${tc.stage} runs every part at its stage pin`;
    const { runId } = await deps.executor.planStreamed("tenant-refresh-members", { tenantId, versions });
    await settle(deps, runId);
    try {
      await approveInQueue(deps, runId);
    } catch (err) {
      // A plan its gates refused settles its run as failed, and an operator may have cancelled it: in
      // both it is no run to approve, and its record says which.
      if ((err as { code?: unknown }).code === "ILLEGAL_TRANSITION") {
        return `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} moving ${moves} was not approved: its plan was refused or the run was cancelled, and its record says which`;
      }
      // Any other refusal leaves a planned run nobody will approve; it is discarded, so the next event
      // plans afresh instead of adding to a pile.
      await deps.executor.discard(runId).catch((discardErr: unknown) => deps.logger.error({ err: discardErr, runId }, "a planned Versions run could not be discarded"));
      throw err;
    }
    await settle(deps, runId);
    const ending = deps.runEnding(runId);
    if (!ending) {
      const unknown = `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} has no record, so whether it moved ${moves} is unknown`;
      deps.logger.warn({ tenantId, runId }, unknown);
      return unknown;
    }
    const { status, error } = ending;
    if (status === "succeeded") return `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} moved ${moves}`;
    // The plan came before the wait for the tenant, so a run that held it may have rewritten the members.
    if (attempt === 1 && error?.includes(MEMBERS_CHANGED)) continue;
    const missed = `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} did not move ${moves}: it ended ${status}${error ? ` — ${error}` : ""}`;
    deps.logger.warn({ tenantId, runId, status }, missed);
    return missed;
  }
}

/** The follower: one check at a time, in the order they were asked for, so a check always reads the
 *  versions the run before it wrote. */
export function makeTenantFollower(deps: TenantFollowDeps) {
  let queue: Promise<void> = Promise.resolve();
  // Every link catches what it throws: one rejected link would leave every later check unrun.
  const enqueue = (tenantIds: () => string[], cause: string): Promise<void> => {
    queue = queue
      .then(async () => {
        for (const id of tenantIds()) {
          try {
            deps.logger.info({ tenantId: id, cause }, await followTenant(deps, id));
          } catch (err) {
            deps.logger.error({ err, tenantId: id, cause }, "a following tenant could not be moved");
          }
        }
      })
      .catch((err: unknown) => deps.logger.error({ err, cause }, "the tenants that follow releases could not be read"));
    return queue;
  };
  const following = (stage?: Stage): string[] =>
    deps.db.select({ id: tenants.id }).from(tenants).where(stage ? and(eq(tenants.followReleases, true), eq(tenants.stage, stage)) : eq(tenants.followReleases, true)).all().map((r) => r.id);
  return {
    /** A release run succeeded: every following tenant at its stage is checked. */
    releaseSucceeded: (run: ReleaseRunSucceeded): Promise<void> => enqueue(() => following(run.stage as Stage), `${run.unit} ${run.releaseTag} at ${run.stage} (${run.runName})`),
    /** Every following tenant, at the Manager's start. */
    checkAll: (): Promise<void> => enqueue(() => following(), "the Manager started"),
    /** One tenant, when its switch is turned on. */
    checkTenant: (tenantId: string): Promise<void> => enqueue(() => [tenantId], "its switch was turned on"),
  };
}
export type TenantFollower = ReturnType<typeof makeTenantFollower>;
