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
import type { Stage } from "../../../shared/enums.ts";
import type { ReleaseRunSucceeded } from "../../adapters/build-plane/port.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { tenantVersionParts, type TenantVersionPart } from "./tenant-versions.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

export interface TenantFollowDeps {
  db: Db;
  executor: Pick<Executor, "planStreamed" | "settle" | "approve">;
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

/** The run that holds the lock `err` was refused on, or null where `err` is no busy refusal. */
function busyHolder(err: unknown): string | null {
  const e = err as { code?: unknown; detail?: { holderRunId?: unknown } };
  return e.code === "RESOURCE_BUSY" && typeof e.detail?.holderRunId === "string" ? e.detail.holderRunId : null;
}

/** Approve `runId` once no other run holds its locks. Every tenant run takes the books branch, so a
 *  second one waits for the run that holds it to end, however long that takes. */
async function approveWhenFree(executor: TenantFollowDeps["executor"], runId: string): Promise<void> {
  let waitedFor: string | null = null;
  for (;;) {
    try {
      await executor.approve(runId);
      return;
    } catch (err) {
      const holder = busyHolder(err);
      // The same holder twice is a run this process does not execute (settle returned at once), and
      // waiting on it again would spin.
      if (holder === null || holder === waitedFor) throw err;
      waitedFor = holder;
      await executor.settle(holder);
    }
  }
}

/** One check of one tenant, answered as a sentence for the log. */
export async function followTenant(deps: TenantFollowDeps, tenantId: string): Promise<string> {
  const row = deps.db.select({ followReleases: tenants.followReleases, status: tenants.status, suspended: tenants.suspended, subdomain: tenants.subdomain }).from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!row?.followReleases) return `tenant ${tenantId} does not follow releases`;
  if (row.status !== "active" || row.suspended) return `tenant ${row.subdomain} is ${row.suspended ? "suspended" : row.status}, and only an active tenant follows releases`;
  const tc = loadTenantCluster(deps.db, tenantId);
  const read = await deps.ports.registrations.readTenant(tc.stage, tc.guid);
  if (!read) return `tenant ${tc.guid} has no registration at ${tc.stage}`;
  const versions = followedVersions(await tenantVersionParts(deps.ports, tc.stage, read.entry.members, read.entry.approvedTags));
  const moves = Object.entries(versions).map(([part, tag]) => `${part} to ${tag}`).join(", ");
  if (moves === "") return `tenant ${tc.subdomain} at ${tc.stage} runs every part at its stage pin`;
  const { runId } = await deps.executor.planStreamed("tenant-refresh-members", { tenantId, versions });
  await deps.executor.settle(runId);
  try {
    await approveWhenFree(deps.executor, runId);
  } catch (err) {
    // A plan its gates refused settles its run as failed, and a failed run is no run to approve.
    if ((err as { code?: unknown }).code !== "ILLEGAL_TRANSITION") throw err;
    return `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} moving ${moves} was not planned, and its record says why`;
  }
  await deps.executor.settle(runId);
  return `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} moved ${moves}`;
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
