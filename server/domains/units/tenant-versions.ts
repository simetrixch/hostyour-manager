// The versions a tenant runs (hostyour-manager#296). A release only makes a version AVAILABLE: it moves
// the stage pin (charts/<chart>/pins-<stage>.yaml on the books branch). Every tenant holds its own fixed
// version of every build its members render (tenant.approvedTags, #283), so no tenant renders the stage
// pin and a release moves none. Three writers set those versions: create-tenant and add-app (the newest
// available when the member is created), the tenant's upgrade (the newest available now), and the boot,
// which fixes a build a tenant does not hold yet at the version it runs.
import { and, eq } from "drizzle-orm";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { approvedImageTag, type TenantMemberRecord } from "../../../shared/tenant.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import type { Logger } from "../../kernel/logger.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { rendersApproval } from "./tenant-approved-tag.run.ts";
import { memberApplication } from "./tenant-fanout.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

export type Approvals = Record<string, Record<string, string>>;

/** The stage pin of every build the members' charts pin, per member: `<member> -> <build> -> <tag>`.
 *  A pin that names no released image (a chart's placeholder before its first release) is left out. */
export async function stagePinsOf(pinned: (chart: string) => Promise<{ name: string; tag: string }[]>, members: readonly TenantMemberRecord[]): Promise<Approvals> {
  const pins: Approvals = {};
  for (const m of members) {
    for (const source of m.sources) {
      for (const pin of await pinned(source.chart)) {
        if (approvedImageTag.safeParse(pin.tag).success) (pins[m.name] ??= {})[pin.name] = pin.tag;
      }
    }
  }
  return pins;
}

/** `current` with every build of `pins` it does not hold yet added at the pin; what it holds stays. */
export function withMissingPins(current: Approvals, pins: Approvals): Approvals {
  const next: Approvals = Object.fromEntries(Object.entries(current).map(([m, b]) => [m, { ...b }]));
  for (const [member, builds] of Object.entries(pins)) {
    for (const [build, tag] of Object.entries(builds)) {
      if (next[member]?.[build] === undefined) (next[member] ??= {})[build] = tag;
    }
  }
  return next;
}

/** `current` with every build of `pins` moved onto the pin; a build no pin names keeps what it holds. */
export function withNewestPins(current: Approvals, pins: Approvals): Approvals {
  const next: Approvals = Object.fromEntries(Object.entries(current).map(([m, b]) => [m, { ...b }]));
  for (const [member, builds] of Object.entries(pins)) next[member] = { ...next[member], ...builds };
  return next;
}

export const sameApprovals = (a: Approvals, b: Approvals): boolean =>
  JSON.stringify(Object.entries(a).sort().map(([m, x]) => [m, Object.entries(x).sort()])) === JSON.stringify(Object.entries(b).sort().map(([m, x]) => [m, Object.entries(x).sort()]));

/** At boot: every standing tenant at every stage gets each build it does not hold yet fixed at the
 *  version it runs now, the stage pin, so the next release moves none of them. Nothing it runs changes.
 *  NEVER rejects: boot starts it unawaited behind the listener, and every failure is logged. */
export async function fixTenantVersions(deps: { registrations: TenantRegistrations; db: Db; version: string; logger: Logger }): Promise<void> {
  for (const stage of STAGE) {
    try {
      const { pointers } = await deps.registrations.listTenantPointers(stage);
      for (const { guid } of pointers) {
        const read = await deps.registrations.readTenant(stage, guid);
        if (!read) continue;
        const current = read.entry.approvedTags;
        const next = withMissingPins(current, await stagePinsOf((chart) => deps.registrations.listPinnedBuilds(stage, chart), read.entry.members));
        if (sameApprovals(current, next)) continue;
        const { commit } = await deps.registrations.setApprovedTags(stage, guid, next, `boot ${deps.version}`);
        deps.db.update(tenants).set({ approvedTags: next, updatedAt: new Date() }).where(and(eq(tenants.guid, guid), eq(tenants.stage, stage))).run();
        deps.logger.info({ guid, stage, commit }, "tenant versions fixed at the versions it runs — a release no longer moves this tenant");
      }
    } catch (e) {
      deps.logger.error({ stage, err: e instanceof Error ? e.message : String(e) }, "the tenant versions of this stage could not be fixed — a tenant missing one keeps following the stage pin for it until a boot succeeds");
    }
  }
}

/** What the version steps of a tenant run read off its params. */
export interface TenantVersionsParams {
  tenantId: string;
  guid: string;
  stage: Stage;
  clusterId: string;
  members: TenantMemberRecord[];
  /** The tenant's versions when this was planned; an abort writes them back. */
  previousApproved: Approvals;
}

/** On abort: the tenant's versions as they stood when this was planned. */
export function restoreVersionsCleanup(ports: TenantOnboardPorts, p: TenantVersionsParams): Cleanup {
  return {
    name: "restore-versions",
    title: "Record the tenant's previous versions again",
    run: async (ctx) => {
      const { commit } = await ports.registrations.setApprovedTags(p.stage, p.guid, p.previousApproved, ctx.runId);
      ctx.db.update(tenants).set({ approvedTags: p.previousApproved, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
      ctx.log("meta", `tenant ${p.guid}: versions back to what they were (${commit})`);
    },
  };
}

/** Write the newest available versions as the tenant's own, on the registration and the row: the stage
 *  pins as they stand when the step runs, so a build unit this run released first is among them. */
export function writeVersionsStep(ports: TenantOnboardPorts, p: TenantVersionsParams): Step {
  return {
    name: "write-versions",
    title: "Record the newest available versions as the tenant's own",
    run: async (ctx: StepCtx) => {
      ctx.registerCleanup(restoreVersionsCleanup(ports, p));
      const read = await ports.registrations.readTenant(p.stage, p.guid);
      if (!read) throw errValidation(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
      const approved = withNewestPins(read.entry.approvedTags, await stagePinsOf((chart) => ports.registrations.listPinnedBuilds(p.stage, chart), p.members));
      const { commit } = await ports.registrations.setApprovedTags(p.stage, p.guid, approved, ctx.runId);
      ctx.db.update(tenants).set({ approvedTags: approved, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
      ctx.checkpoint({ commit });
      ctx.log("meta", `tenant ${p.guid}: versions recorded (${commit})`);
    },
  };
}

/** Wait until every member is Synced + Healthy rendering the tenant's versions as they stand now. */
export function watchVersionsStep(ports: TenantOnboardPorts, p: TenantVersionsParams): Step {
  return {
    name: "watch-versions",
    title: "Wait until every member runs the tenant's versions",
    run: async (ctx) => {
      const current = await ports.registrations.readTenant(p.stage, p.guid);
      if (!current) throw errValidation(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
      const approved = current.entry.approvedTags;
      const apps = p.members.map((m) => memberApplication(p.guid, m.name, p.stage));
      const renders = (byName: ArgoAppStatusMap): boolean => p.members.every((m, i) =>
        Object.entries(approved[m.name] ?? {}).every(([build, tag]) => rendersApproval(byName.get(apps[i]!), ports.catalogRepoUrl, m.name, build, tag)));
      const until = (byName: ArgoAppStatusMap): boolean => syncedAt(apps)(byName) && renders(byName);
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const byName = await argoReader.watchApplicationSet(argoNamespace, apps, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${p.guid}` });
      if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${p.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
      if (!renders(byName)) throw errValidation(`tenant ${p.guid}'s members are Synced + Healthy, and ArgoCD has not rendered their versions yet — retry this step once the ApplicationSet has regenerated them`);
      ctx.log("meta", `tenant ${p.guid}: every member runs its versions`);
    },
  };
}

