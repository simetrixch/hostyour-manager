// The versions a tenant runs (hostyour-manager#296). A release only makes a version AVAILABLE: it moves
// the stage pin (charts/<chart>/pins-<stage>.yaml on the books branch). Every tenant holds its own fixed
// version of every build its members render (tenant.approvedTags, #283), so no tenant renders the stage
// pin and a release moves none. Three writers set those versions: create-tenant and add-app (the newest
// available when the member is created), the tenant's Versions run (the version chosen per part), and
// the boot, which fixes a build a tenant does not hold yet at the version it runs.
//
// A PART is the set of builds one unit releases together (its build registration), so one release tag
// names every image of it and a choice moves them all: a tenant never runs the engine of one release
// beside the app of another.
import { and, eq } from "drizzle-orm";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { approvedImageTag, isOlderRelease, type TenantMemberRecord } from "../../../shared/tenant.ts";
import type { ReleaseChannel } from "../../../shared/release.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import type { Logger } from "../../kernel/logger.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import type { ChannelStages } from "../inventory/channel-stages.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { memberApplication } from "./tenant-fanout.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

export type Approvals = Record<string, Record<string, string>>;

/** The channel and the ts14 of an image tag `<x.y.z>-<channel>-<ts14>-<sha7>`. */
const channelOf = (tag: string): ReleaseChannel => tag.split("-")[1] as ReleaseChannel;
const ts14Of = (tag: string): string => tag.split("-")[2]!;
/** Newest first: the ts14 orders releases whatever their x.y.z says. */
const byNewest = (a: string, b: string): number => ts14Of(b).localeCompare(ts14Of(a));

/** A build a member renders, as its chart's stage pin names it. */
export interface PinnedBuild {
  name: string;
  /** The repository of its image in the registry. */
  image: string;
  pin: string;
}

/** One part of a tenant: the builds one unit releases together, and the versions its members run of
 *  them now, newest first (one where every member runs the same). */
export interface TenantVersionPart {
  name: string;
  builds: PinnedBuild[];
  running: string[];
}

/** The tenant's parts: every build its members' charts pin at the stage, grouped by the unit whose build
 *  registration claims it; a build no unit claims is a part of its own. A pin that names no released
 *  image (a chart's placeholder) is left out, as stagePinsOf leaves it out. */
export async function tenantVersionParts(
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds">,
  stage: Stage,
  members: readonly TenantMemberRecord[],
  approved: Approvals,
): Promise<TenantVersionPart[]> {
  const unitOf = new Map((await ports.attestedBuilds()).map((a) => [a.build, a.unit]));
  const pinsOf = new Map<string, Promise<{ name: string; image: string; tag: string }[]>>();
  const parts = new Map<string, { builds: Map<string, PinnedBuild>; running: Set<string> }>();
  for (const m of members) {
    for (const { chart } of m.sources) {
      if (!pinsOf.has(chart)) pinsOf.set(chart, ports.registrations.listPinnedBuilds(stage, chart));
      for (const b of await pinsOf.get(chart)!) {
        if (!approvedImageTag.safeParse(b.tag).success) continue;
        const name = unitOf.get(b.name) ?? b.name;
        const part = parts.get(name) ?? { builds: new Map<string, PinnedBuild>(), running: new Set<string>() };
        part.builds.set(b.name, { name: b.name, image: b.image, pin: b.tag });
        part.running.add(approved[m.name]?.[b.name] ?? b.tag);
        parts.set(name, part);
      }
    }
  }
  return [...parts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => ({ name, builds: [...p.builds.values()], running: [...p.running].sort(byNewest) }));
}

/** Why a tenant at `stage` cannot be put on `tag` for `part`, or null where it can: the tag must be an
 *  image tag, on a channel the stage takes (global.channelStages, which the release pipeline enforces
 *  where it pins), and no newer than the part's stage pin, the newest version a release has made
 *  available at this stage. */
export function versionRefusal(tag: string, part: TenantVersionPart, channels: ChannelStages, stage: Stage): string | null {
  if (!approvedImageTag.safeParse(tag).success) return `${tag} is not an image tag <x.y.z>-<channel>-<ts14>-<sha7>`;
  const reaches = channels[channelOf(tag)] ?? [];
  if (!reaches.includes(stage)) return `the ${channelOf(tag)} channel reaches ${reaches.join(", ") || "no stage"} (global.channelStages), not ${stage}`;
  const available = part.builds.map((b) => b.pin).sort(byNewest).at(-1)!;
  if (ts14Of(tag) > ts14Of(available)) return `${tag} is newer than ${available}, the newest version a release has made available at ${stage}`;
  return null;
}

/** GET /api/tenants/:id/versions — per part, the versions every image of it stands at in the registry
 *  and that the stage takes, newest first, each marked where choosing it moves the part back. */
export async function readTenantVersions(
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds" | "resolveClusterValueFiles" | "registryProbe" | "channelStages">,
  db: Db,
  tenantId: string,
  signal?: AbortSignal,
): Promise<VersionsView> {
  const tc = loadTenantCluster(db, tenantId);
  const read = await ports.registrations.readTenant(tc.stage, tc.guid);
  if (!read) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
  const registryHost = registryHostFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage));
  const channels = await ports.channelStages();
  const parts = await tenantVersionParts(ports, tc.stage, read.entry.members, read.entry.approvedTags);
  return {
    stage: tc.stage,
    parts: await Promise.all(parts.map(async (part) => {
      const lists = await Promise.all(part.builds.map((b) => ports.registryProbe.listTags({ registryHost, repo: b.image }, signal ? { signal } : {})));
      const tags = lists
        .reduce((common, list) => common.filter((t) => list.includes(t)))
        .filter((t) => versionRefusal(t, part, channels, tc.stage) === null)
        .sort(byNewest);
      const newest = part.running[0];
      return {
        name: part.name,
        builds: part.builds.map((b) => b.name),
        running: part.running,
        versions: tags.map((tag) => ({ tag, older: newest !== undefined && isOlderRelease(tag, newest) })),
      };
    })),
  };
}

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

/** `current` with every build of `pins` it does not hold yet added at the pin, and every build `chosen`
 *  names (build -> tag) moved onto its chosen version; any other build keeps what it holds. */
export function withChosenVersions(current: Approvals, pins: Approvals, chosen: Readonly<Record<string, string>>): Approvals {
  const next = withMissingPins(current, pins);
  for (const [member, builds] of Object.entries(pins)) {
    for (const build of Object.keys(builds)) {
      const tag = chosen[build];
      if (tag !== undefined) next[member]![build] = tag;
    }
  }
  return next;
}

/** Whether a member Application's last comparison renders `tag` for app and build. */
export function rendersApproval(status: ArgoAppStatus | undefined, deployRepoUrl: string, app: string, build: string, tag: string): boolean {
  const charts = (status?.syncSources ?? []).filter((src) => src.repoURL === deployRepoUrl && src.path);
  if (charts.length === 0) return false;
  return charts.every((src) => {
    const approved = (src.valuesObject?.["tenant"] as { approvedTags?: Record<string, Record<string, unknown>> } | undefined)?.approvedTags;
    return approved?.[app]?.[build] === tag;
  });
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
  /** The version chosen per build, every build of a chosen part at its part's tag. */
  chosenVersions: Record<string, string>;
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

/** Write the chosen versions as the tenant's own, on the registration and the row. A build the members
 *  render and the tenant does not hold yet takes the stage pin as it stands when the step runs, so a
 *  build unit this run released first is among them. */
export function writeVersionsStep(ports: TenantOnboardPorts, p: TenantVersionsParams): Step {
  return {
    name: "write-versions",
    title: "Record the chosen versions as the tenant's own",
    run: async (ctx: StepCtx) => {
      ctx.registerCleanup(restoreVersionsCleanup(ports, p));
      const read = await ports.registrations.readTenant(p.stage, p.guid);
      if (!read) throw errValidation(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
      const approved = withChosenVersions(read.entry.approvedTags, await stagePinsOf((chart) => ports.registrations.listPinnedBuilds(p.stage, chart), p.members), p.chosenVersions);
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
        Object.entries(approved[m.name] ?? {}).every(([build, tag]) => rendersApproval(byName.get(apps[i]!), ports.deployRepoUrl, m.name, build, tag)));
      const until = (byName: ArgoAppStatusMap): boolean => syncedAt(apps)(byName) && renders(byName);
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const byName = await argoReader.watchApplicationSet(argoNamespace, apps, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${p.guid}` });
      if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${p.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
      if (!renders(byName)) throw errValidation(`tenant ${p.guid}'s members are Synced + Healthy, and ArgoCD has not rendered their versions yet — retry this step once the ApplicationSet has regenerated them`);
      ctx.log("meta", `tenant ${p.guid}: every member runs its versions`);
    },
  };
}

