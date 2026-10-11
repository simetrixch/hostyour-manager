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
import type { AppsEngine } from "../../../shared/apps-manifest.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { bundleReleaseTag, repositoryEngine, versionLine } from "./engine-line.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { tenantVersionParts, type TenantVersionPart } from "./tenant-versions.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { MEMBERS_CHANGED } from "./tenant-refresh-members.run.ts";

/** How long one wait of a check may last before the log says that every later check waits behind it. */
const LONG_WAIT_MS = 30 * 60_000;

export interface TenantFollowDeps {
  db: Db;
  executor: Pick<Executor, "planStreamed" | "settle" | "approve" | "discard" | "listQueue">;
  /** How a run stands once it settled: its status and, where it failed, its error (executor/read.ts getRunEnding). */
  runEnding: (runId: string) => { status: RunStatus; error: string | null } | undefined;
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds" | "repo" | "deployCredentialId">;
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

/** The moves of `versions` that keep the tenant on the engine line of the bundle it runs, and why each
 *  other one is left out. The line binds two parts: the one that renders the bundle's engine build,
 *  whose pin must be on that line, and the bundle, whose pinned release must declare it. The Versions
 *  run refuses a pairing across lines (engine-line.ts), and a move to another line takes both parts at
 *  once, through tenant-line-move. `engineOf` reads the engine a bundle tag's release declares; it is
 *  asked only where a move may leave the line: the bundle moves, or a part's pin is on another version
 *  line than a version it runs. A bundle that declares no engine is judged by nobody, so every move stays. */
export async function movesInsideLine(
  versions: Readonly<Record<string, string>>,
  parts: readonly TenantVersionPart[],
  bundle: { part: string; tag: string } | undefined,
  engineOf: (appsImageTag: string) => Promise<AppsEngine | undefined>,
): Promise<{ versions: Record<string, string>; leftOut: string[] }> {
  const kept = { ...versions };
  const leftOut: string[] = [];
  const mayLeaveLine = Object.entries(versions).some(([name, pin]) =>
    name === bundle?.part || (parts.find((p) => p.name === name)?.running ?? []).some((tag) => versionLine(tag) !== versionLine(pin)));
  if (!bundle || !mayLeaveLine) return { versions: kept, leftOut };
  const engine = await engineOf(bundle.tag);
  if (!engine) return { versions: kept, leftOut };
  for (const [name, pin] of Object.entries(versions)) {
    const pinLine = name === bundle.part ? (await engineOf(pin))?.line
      : parts.find((p) => p.name === name)?.builds.some((b) => b.name === engine.build) ? versionLine(pin) : undefined;
    if (pinLine === undefined || pinLine === engine.line) continue;
    delete kept[name];
    leftOut.push(`${name} pin ${pin} is on line ${pinLine} and the bundle runs line ${engine.line}, so Move to line moves it`);
  }
  return { versions: kept, leftOut };
}

/** The tenant's bundle as movesInsideLine takes it, and the reader of the engine a tag of it declares;
 *  no bundle where the tenant runs none. The bundle's pin file names its one build after its image
 *  (tenant-versions.ts bundlePart). */
function tenantBundle(deps: TenantFollowDeps, entry: TenantRegistration, parts: readonly TenantVersionPart[], tenantId: string) {
  const { appsRepo, appsImage, appsImageTag } = entry;
  const part = parts.find((p) => p.builds.some((b) => b.name === appsImage));
  const read = { repo: deps.ports.repo, ...(deps.ports.deployCredentialId ? { deployCredentialId: deps.ports.deployCredentialId } : {}) };
  // A check has no abort: it runs to its end like the run it plans.
  const ctx = { log: (line: string) => deps.logger.info({ tenantId }, line), signal: new AbortController().signal };
  return {
    bundle: appsRepo && appsImage && appsImageTag ? { part: part?.name ?? appsImage, tag: appsImageTag } : undefined,
    engineOf: (tag: string) => repositoryEngine(read, { repoURL: appsRepo!, ref: bundleReleaseTag(tag) }, ctx),
  };
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

/** The Versions run of this tenant that waits in the queue, if one does. */
function queuedVersionsRun(deps: TenantFollowDeps, tenantId: string): { runId: string; place: number } | undefined {
  return deps.executor.listQueue().find((q) => q.kind === "tenant-refresh-members" && q.targetId === tenantId);
}

/** One check of one tenant, answered as a sentence for the log. A refresh that another run's member
 *  write overtook while it waited for the tenant is planned once more against the members as they then
 *  stand; a refresh that did not succeed is said to have moved nothing, at warn, with its run. */
export async function followTenant(deps: TenantFollowDeps, tenantId: string): Promise<string> {
  const row = deps.db.select({ followReleases: tenants.followReleases, status: tenants.status, suspended: tenants.suspended, subdomain: tenants.subdomain }).from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!row?.followReleases) return `tenant ${tenantId} does not follow releases`;
  if (row.status !== "active" || row.suspended) return `tenant ${row.subdomain} is ${row.suspended ? "suspended" : row.status}, and only an active tenant follows releases`;
  // A run that holds the tenant may stay failed or cancelled until a person acts, and the queue keeps
  // the tenant's Versions run behind it. The check does not wait for it, so the other tenants go on;
  // the follower checks this tenant again once that run ends.
  const waiting = queuedVersionsRun(deps, tenantId);
  if (waiting) return `tenant ${row.subdomain}: the Versions run ${waiting.runId} waits in the queue at place ${waiting.place}, and the tenant is checked again once it ends`;
  const tc = loadTenantCluster(deps.db, tenantId);
  for (let attempt = 1; ; attempt++) {
    const read = await deps.ports.registrations.readTenant(tc.stage, tc.guid);
    if (!read) return `tenant ${tc.guid} has no registration at ${tc.stage}`;
    const parts = await tenantVersionParts(deps.ports, tc.stage, read.entry.members, read.entry.approvedTags, read.entry);
    const { bundle, engineOf } = tenantBundle(deps, read.entry, parts, tenantId);
    const { versions, leftOut } = await movesInsideLine(followedVersions(parts), parts, bundle, engineOf);
    const moves = Object.entries(versions).map(([part, tag]) => `${part} to ${tag}`).join(", ");
    const outside = leftOut.join("; ");
    if (moves === "") return outside === "" ? `tenant ${tc.subdomain} at ${tc.stage} runs every part at its stage pin` : `tenant ${tc.subdomain} at ${tc.stage} moves no part inside its engine line: ${outside}`;
    if (outside !== "" && attempt === 1) deps.logger.info({ tenantId }, `tenant ${tc.subdomain} at ${tc.stage} follows inside its engine line only: ${outside}`);
    const { runId } = await deps.executor.planStreamed("tenant-refresh-members", { tenantId, versions });
    await settle(deps, runId);
    try {
      const { status } = await deps.executor.approve(runId);
      if (status === "queued") return `tenant ${tc.subdomain} at ${tc.stage}: the Versions run ${runId} moving ${moves} waits in the queue for the run that holds the tenant, and the tenant is checked again once it ends`;
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
  const watched = new Set<string>();
  // A tenant whose Versions run waits in the queue is checked again once that run ends, as one more
  // check in line, so what the run moved or missed is read like any other check's.
  const recheckWhenItEnds = (tenantId: string): void => {
    const waiting = queuedVersionsRun(deps, tenantId);
    if (!waiting || watched.has(waiting.runId)) return;
    watched.add(waiting.runId);
    void deps.executor.settle(waiting.runId)
      .catch((err: unknown) => deps.logger.error({ err, runId: waiting.runId }, "a queued Versions run could not be waited for"))
      .then(() => {
        watched.delete(waiting.runId);
        return enqueue(() => [tenantId], `its queued Versions run ${waiting.runId} ended`);
      });
  };
  // Every link catches what it throws: one rejected link would leave every later check unrun.
  const enqueue = (tenantIds: () => string[], cause: string): Promise<void> => {
    queue = queue
      .then(async () => {
        for (const id of tenantIds()) {
          try {
            deps.logger.info({ tenantId: id, cause }, await followTenant(deps, id));
            recheckWhenItEnds(id);
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
