// The versions a tenant runs (hostyour-manager#296). A release only makes a version AVAILABLE: it moves
// the stage pin (charts/<chart>/pins-<stage>.yaml on the books branch). Every tenant holds its own fixed
// version of every build its members render (tenant.approvedTags, #283), so a release moves no build a
// tenant holds. Two writers set those versions: create-tenant and add-app (the newest available when the
// member is created), and the tenant's Versions run (the version chosen per part). A build a member's
// chart gains later renders the stage pin until that run fixes it, and a build the pin files stop naming
// leaves the tenant's versions when that run writes them.
//
// A PART is the set of builds one unit releases together (its build registration), so one release tag
// names every image of it and a choice moves them all: a tenant never runs the engine of one release
// beside the app of another.
//
// THE APPS BUNDLE IS A PART TOO. Its release moves its own stage pin (bundles/<image>/pins-<stage>.yaml,
// in the shape of a chart's pin file), and the tenant runs the tag its registration holds
// (appsImageTag). The Versions run moves that tag together with both copies of every app's database
// list, which the bundle declares.
import { eq } from "drizzle-orm";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import { approvedImageTag, isOlderRelease, type TenantMemberRecord, type TenantRegistration } from "../../../shared/tenant.ts";
import type { ReleaseChannel } from "../../../shared/release.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import type { ChannelStages } from "../inventory/channel-stages.ts";
import { loadTenantCluster, refreshTenantApplications } from "./lifecycle.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { memberApplication } from "./tenant-fanout.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import type { PinHistory } from "./tenant-registrations.ts";
import type { AppsEngine } from "../../../shared/apps-manifest.ts";
import { bundleReleaseRefusal, engineLineRefusal, stepLog, throwEngineLineRefusal } from "./engine-line.ts";

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
  /** Every tag the stage pin has named for it, newest first: what releases made available at the stage. */
  released: string[];
}

/** One part of a tenant: the builds one unit releases together, and the versions its members run of
 *  them now, newest first (one where every member runs the same). */
export interface TenantVersionPart {
  name: string;
  builds: PinnedBuild[];
  running: string[];
}

/** The directory of a bundle's stage pin files on the books branch, written by the release pipeline. */
export const bundlePinsDir = (appsImage: string): string => `bundles/${appsImage}`;

/** The tenant's apps bundle as a part, running the tag the registration holds; undefined where the
 *  tenant runs no bundle or no release has pinned it at the stage yet. `pins` is its pin file's read. */
function bundlePart(
  bundle: Pick<TenantRegistration, "appsImage" | "appsImageTag">,
  unitOf: ReadonlyMap<string, string>,
  pins: readonly PinHistory[],
): TenantVersionPart | undefined {
  if (!bundle.appsImage || !bundle.appsImageTag) return undefined;
  const builds = pins
    .filter((b) => approvedImageTag.safeParse(b.tag).success)
    .map((b) => ({ name: b.name, image: b.image, pin: b.tag, released: b.released }));
  if (builds.length === 0) return undefined;
  return { name: unitOf.get(bundle.appsImage) ?? bundle.appsImage, builds, running: [bundle.appsImageTag] };
}

/** The tenant's apps bundle as a part (bundlePart), read on its own. */
export async function tenantBundlePart(
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds">,
  stage: Stage,
  bundle: Pick<TenantRegistration, "appsImage" | "appsImageTag">,
): Promise<TenantVersionPart | undefined> {
  if (!bundle.appsImage) return undefined;
  const pinsDir = bundlePinsDir(bundle.appsImage);
  const [attested, pins] = await Promise.all([ports.attestedBuilds(), ports.registrations.listPinHistories(stage, [pinsDir])]);
  return bundlePart(bundle, new Map(attested.map((a) => [a.build, a.unit])), pins.get(pinsDir) ?? []);
}

/** The directories of the stage pin files a tenant's parts read: every chart its members render, and
 *  its apps bundle's. */
function versionPinsDirs(members: readonly TenantMemberRecord[], bundle: Pick<TenantRegistration, "appsImage">): string[] {
  const charts = [...new Set(members.flatMap((m) => m.sources.map((s) => s.chart)))];
  return bundle.appsImage ? [...charts, bundlePinsDir(bundle.appsImage)] : charts;
}

/** The tenant's parts: every build its members' charts pin at the stage, grouped by the unit whose build
 *  registration claims it; a build no unit claims is a part of its own. A pin that names no released
 *  image (a chart's placeholder) is left out, as stagePinsOf leaves it out. The apps bundle is one more
 *  part where its stage pin stands (bundlePart). Every pin file is read in one books turn. */
export async function tenantVersionParts(
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds">,
  stage: Stage,
  members: readonly TenantMemberRecord[],
  approved: Approvals,
  bundle: Pick<TenantRegistration, "appsImage" | "appsImageTag">,
): Promise<TenantVersionPart[]> {
  const [attested, pinsOf] = await Promise.all([ports.attestedBuilds(), ports.registrations.listPinHistories(stage, versionPinsDirs(members, bundle))]);
  return versionPartsOf(members, approved, bundle, attested, pinsOf);
}

/** tenantVersionParts over pins and attested builds already read. */
function versionPartsOf(
  members: readonly TenantMemberRecord[],
  approved: Approvals,
  bundle: Pick<TenantRegistration, "appsImage" | "appsImageTag">,
  attested: readonly { unit: string; build: string }[],
  pinsOf: ReadonlyMap<string, PinHistory[]>,
): TenantVersionPart[] {
  const bundleDir = bundle.appsImage ? bundlePinsDir(bundle.appsImage) : undefined;
  const unitOf = new Map(attested.map((a) => [a.build, a.unit]));
  const parts = new Map<string, { builds: Map<string, PinnedBuild>; running: Set<string> }>();
  for (const m of members) {
    for (const { chart } of m.sources) {
      for (const b of pinsOf.get(chart) ?? []) {
        if (!approvedImageTag.safeParse(b.tag).success) continue;
        const name = unitOf.get(b.name) ?? b.name;
        const part = parts.get(name) ?? { builds: new Map<string, PinnedBuild>(), running: new Set<string>() };
        part.builds.set(b.name, { name: b.name, image: b.image, pin: b.tag, released: b.released });
        part.running.add(approved[m.name]?.[b.name] ?? b.tag);
        parts.set(name, part);
      }
    }
  }
  const memberParts = [...parts.entries()].map(([name, p]) => ({ name, builds: [...p.builds.values()], running: [...p.running].sort(byNewest) }));
  const bundled = bundleDir ? bundlePart(bundle, unitOf, pinsOf.get(bundleDir) ?? []) : undefined;
  return [...memberParts, ...(bundled ? [bundled] : [])].sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a tenant at `stage` cannot be put on `tag` for `part`, or null where it can: the tag must be an
 *  image tag, on a channel the stage takes (global.channelStages, which the release pipeline enforces
 *  where it pins), and one the stage pin of every build of the part has named. A release makes a version
 *  available at a stage by pinning it there (#296), and one put back on the stage moves the pin back
 *  without taking the newer one away, so the pins' history is the answer and the pin alone is not. */
export function versionRefusal(tag: string, part: TenantVersionPart, channels: ChannelStages, stage: Stage): string | null {
  if (!approvedImageTag.safeParse(tag).success) return `${tag} is not an image tag <x.y.z>-<channel>-<ts14>-<sha7>`;
  const reaches = channels[channelOf(tag)] ?? [];
  if (!reaches.includes(stage)) return `the ${channelOf(tag)} channel reaches ${reaches.join(", ") || "no stage"} (global.channelStages), not ${stage}`;
  const unreleased = part.builds.filter((b) => !b.released.includes(tag)).map((b) => b.name);
  if (unreleased.length > 0) return `no release made ${tag} available at ${stage}: the stage pin of ${unreleased.join(", ")} never named it`;
  return null;
}

/** GET /api/tenants/:id/versions — per part, the versions every image of it stands at in the registry
 *  and that the stage takes, newest first, each marked where choosing it moves the part back. The
 *  reads that do not wait on each other run together, and `log` gets one line per read with its time. */
export async function readTenantVersions(
  ports: Pick<TenantOnboardPorts, "registrations" | "attestedBuilds" | "resolveClusterValueFiles" | "registryProbe" | "channelStages">,
  db: Db,
  tenantId: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<VersionsView> {
  const started = performance.now();
  const timed = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await read();
    } finally {
      log(`${what}: ${Math.round(performance.now() - t)} ms`);
    }
  };
  const tc = loadTenantCluster(db, tenantId);
  // Logged on every path, a refused or failed read included, because the time is what tells which read is slow.
  // The registration and its pins share one books turn, whose fetch is the dearest read here; nothing
  // else waits for it.
  try {
    const [read, attested, valueFiles, channels] = await Promise.all([
      timed("registration and stage pins", () => ports.registrations.readTenantWithPinHistories(tc.stage, tc.guid, (entry) => versionPinsDirs(entry.members, entry))),
      timed("attested builds", () => ports.attestedBuilds()),
      timed("cluster values", () => ports.resolveClusterValueFiles(tc.domain, tc.stage)),
      timed("channel stages", () => ports.channelStages()),
    ]);
    if (!read) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
    const parts = versionPartsOf(read.entry.members, read.entry.approvedTags, read.entry, attested, read.pins);
    const registryHost = registryHostFromChain(valueFiles);
    return {
      stage: tc.stage,
      parts: await timed(`registry tags of ${parts.reduce((n, p) => n + p.builds.length, 0)} images`, () => Promise.all(parts.map(async (part) => {
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
      }))),
    };
  } finally {
    log(`versions read of tenant ${tc.guid}: ${Math.round(performance.now() - started)} ms`);
  }
}

/** The stage pin of every build the members' charts pin, per member: `<member> -> <build> -> <tag>`.
 *  A pin that names no released image (a chart's placeholder before its first release) is left out. */
export async function stagePinsOf(pinned: (chart: string) => Promise<{ name: string; tag: string }[]>, members: readonly TenantMemberRecord[]): Promise<Approvals> {
  return (await stagePinsAndNamesOf(pinned, members)).tags;
}

/** The stage pins of the members' charts: `tags` as stagePinsOf answers, and `named`, per member, every
 *  build its pin files name at any tag, a placeholder included, so "not released yet" and "no longer
 *  built" stay apart. A member is absent from `named` where one of its charts has no pin file or a file
 *  that names no build: what it holds cannot be judged against the pins then, and an empty read never
 *  empties a tenant. */
export interface StagePins {
  tags: Approvals;
  named: Readonly<Record<string, ReadonlySet<string>>>;
}

export async function stagePinsAndNamesOf(pinned: (chart: string) => Promise<{ name: string; tag: string }[]>, members: readonly TenantMemberRecord[]): Promise<StagePins> {
  const tags: Approvals = {};
  const named: Record<string, ReadonlySet<string>> = {};
  for (const m of members) {
    const names = new Set<string>();
    let everyChartPinned = m.sources.length > 0;
    for (const source of m.sources) {
      const pins = await pinned(source.chart);
      if (pins.length === 0) everyChartPinned = false;
      for (const pin of pins) {
        names.add(pin.name);
        if (approvedImageTag.safeParse(pin.tag).success) (tags[m.name] ??= {})[pin.name] = pin.tag;
      }
    }
    if (everyChartPinned) named[m.name] = names;
  }
  return { tags, named };
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

/** Why members that start at their stage pins beside the ones `held` keeps cannot run beside a bundle
 *  written for `engine`, or null (engine-line.ts). */
export async function newMembersRefusal(input: { engine: AppsEngine | undefined; held: Approvals; newMembers: readonly TenantMemberRecord[]; pinned: (chart: string) => Promise<{ name: string; tag: string }[]> }): Promise<string | null> {
  return input.engine === undefined ? null : engineLineRefusal(input.engine, withMissingPins(input.held, await stagePinsOf(input.pinned, input.newMembers)));
}

/** The versions an app added to a standing tenant starts on, every build of its member at the stage pin
 *  as it stands when the step runs, judged against the bundle the registration names (engine-line.ts). */
export async function addedMemberVersions(ports: TenantOnboardPorts, stage: Stage, entry: TenantRegistration, app: string, member: TenantMemberRecord, ctx: Pick<StepCtx, "log" | "signal">): Promise<Record<string, string>> {
  const approved = (await stagePinsOf((chart) => ports.registrations.listPinnedBuilds(stage, chart), [member]))[app] ?? {};
  throwEngineLineRefusal(await bundleReleaseRefusal(ports, entry, entry.approvedTags, { ...entry.approvedTags, [app]: approved }, stepLog(ctx)), `app "${app}" cannot be added to tenant ${entry.subdomain}`);
  return approved;
}

/** `current` with every build of `pins` it does not hold yet added at the pin, every build `chosen`
 *  names (build -> tag) moved onto its chosen version, and every build the member's pin files no longer
 *  name dropped; any other build keeps what it holds. */
export function withChosenVersions(current: Approvals, pins: StagePins, chosen: Readonly<Record<string, string>>): Approvals {
  const next = withMissingPins(current, pins.tags);
  for (const [member, builds] of Object.entries(pins.tags)) {
    for (const build of Object.keys(builds)) {
      const tag = chosen[build];
      if (tag !== undefined) next[member]![build] = tag;
    }
  }
  for (const [member, names] of Object.entries(pins.named)) {
    for (const build of Object.keys(next[member] ?? {})) {
      if (!names.has(build)) delete next[member]![build];
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
      ctx.db.update(tenants).set({ approvedTags: p.previousApproved, lastRunId: ctx.runId }).where(eq(tenants.id, p.tenantId)).run();
      await refreshTenantApplications(ports.resolver, p.clusterId, p.members.map(m => memberApplication(p.guid, m.name, p.stage)), ctx);
      ctx.log("meta", `tenant ${p.guid}: versions back to what they were (${commit})`);
    },
  };
}

/** Write the chosen versions as the tenant's own, on the registration and the row. A build the members
 *  render and the tenant does not hold yet takes the stage pin as it stands when the step runs, so a
 *  build unit this run released first is among them, and the versions are judged against the bundle the
 *  tenant runs again here, as they are written (engine-line.ts). */
export function writeVersionsStep(ports: TenantOnboardPorts, p: TenantVersionsParams): Step {
  return {
    name: "write-versions",
    title: "Record the chosen versions as the tenant's own",
    run: async (ctx: StepCtx) => {
      ctx.registerCleanup(restoreVersionsCleanup(ports, p));
      const read = await ports.registrations.readTenant(p.stage, p.guid);
      if (!read) throw errValidation(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
      const approved = withChosenVersions(read.entry.approvedTags, await stagePinsAndNamesOf((chart) => ports.registrations.listPinnedBuilds(p.stage, chart), p.members), p.chosenVersions);
      throwEngineLineRefusal(await bundleReleaseRefusal(ports, read.entry, read.entry.approvedTags, approved, stepLog(ctx)), `tenant ${p.guid} cannot run these versions`);
      const { commit } = await ports.registrations.setApprovedTags(p.stage, p.guid, approved, ctx.runId);
      ctx.db.update(tenants).set({ approvedTags: approved, lastRunId: ctx.runId }).where(eq(tenants.id, p.tenantId)).run();
      ctx.checkpoint({ commit });
      await refreshTenantApplications(ports.resolver, p.clusterId, p.members.map(m => memberApplication(p.guid, m.name, p.stage)), ctx);
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

