// A tenant brought onto the NEWEST build of its apps, for this tenant alone (hostyour-manager#289).
//
// Refresh members builds every unit of the product whose builds the tenant's members pin, at the unit's
// default branch head, with target build: the release pipeline builds, scans and verifies it and writes
// no stage pin, so no other tenant moves. The built tag is then recorded as this tenant's approved tag
// (tenant.approvedTags, #283) for every app and build it serves, and the run waits until each member
// renders it. A unit whose head the tenant already runs builds nothing.
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { TenantMemberRecord } from "../../../shared/tenant.ts";
import { unitNameFromRepoURL, type TenantSpec } from "../../../shared/consumer.ts";
import type { ReleaseChannel } from "../../../shared/release.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { BuildUnitSchema, buildUnitStep, type RegisteredUnit } from "./tenant-builds.ts";
import { withApproval, rendersApproval } from "./tenant-approved-tag.run.ts";
import { memberApplication } from "./tenant-fanout.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

type Approvals = Record<string, Record<string, string>>;

/** A unit to build for the tenant, with the tag the tenant runs its builds at now. */
export const NewestUnitSchema = BuildUnitSchema.extend({ runningTag: z.string() });
export type NewestUnit = z.infer<typeof NewestUnitSchema>;

/** What the newest-build steps read off the refresh run's params. */
export interface NewestBuildsParams {
  tenantId: string;
  guid: string;
  owner: string;
  stage: Stage;
  clusterId: string;
  members: TenantMemberRecord[];
  channel?: ReleaseChannel | undefined;
  newest: NewestUnit[];
  /** The tenant's approvals when this was planned; an abort writes them back. */
  previousApproved: Approvals;
}

/** The registered build-only units of the product whose builds the tenant's members pin, each with the
 *  tag the tenant runs now: its approval where it has one, the stage pin otherwise. A unit the tenant
 *  pins nothing of, an unregistered unit and a deployable unit are named in `skipped`. */
export async function planNewestUnits(input: {
  buildRepos: TenantSpec["buildRepos"];
  members: readonly TenantMemberRecord[];
  approved: Approvals;
  pinned: (chart: string) => Promise<{ name: string; image: string; tag: string }[]>;
  registration: (unit: string) => Promise<RegisteredUnit | null>;
}): Promise<{ units: NewestUnit[]; skipped: string[] }> {
  const running = new Map<string, { image: string; tag: string }>();
  for (const m of input.members) {
    for (const source of m.sources) {
      for (const pin of await input.pinned(source.chart)) {
        const tag = input.approved[m.name]?.[pin.name] ?? pin.tag;
        if (!running.has(pin.name) || input.approved[m.name]?.[pin.name]) running.set(pin.name, { image: pin.image, tag });
      }
    }
  }
  const units: NewestUnit[] = [];
  const skipped: string[] = [];
  for (const entry of input.buildRepos) {
    const unit = unitNameFromRepoURL(entry.repo);
    const builds = entry.builds.filter((b) => running.has(b));
    if (builds.length === 0) { skipped.push(`${unit}: no member of the tenant pins its builds`); continue; }
    const reg = await input.registration(unit);
    if (!reg) { skipped.push(`${unit}: not registered on this installation`); continue; }
    if (reg.form !== "build-only") { skipped.push(`${unit}: registered as deployable, released from its Consumers page`); continue; }
    units.push({
      unit, repoURL: entry.repo, images: builds.map((b) => running.get(b)!.image), registered: true, form: "build-only",
      runningTag: running.get(builds[0]!)!.tag,
    });
  }
  return { units, skipped };
}

/** Record `tag` as the tenant's approval for every app and build of `builds` its members pin. */
async function approveBuiltTag(ctx: StepCtx, ports: TenantOnboardPorts, p: NewestBuildsParams, tag: string, builds: readonly string[]): Promise<void> {
  const current = await ports.registrations.readTenant(p.stage, p.guid);
  if (!current) throw errValidation(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
  let next: Approvals = current.entry.approvedTags;
  for (const m of p.members) {
    for (const source of m.sources) {
      for (const pin of await ports.registrations.listPinnedBuilds(p.stage, source.chart)) {
        if (builds.includes(pin.name)) next = withApproval(next, m.name, pin.name, tag);
      }
    }
  }
  ctx.registerCleanup(restoreApprovalsCleanup(ports, p));
  const { commit } = await ports.registrations.setApprovedTags(p.stage, p.guid, next, ctx.runId);
  ctx.db.update(tenants).set({ approvedTags: next, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
  ctx.log("meta", `tenant ${p.guid}: ${builds.join(", ")} approved at ${tag} for this tenant alone (${commit})`);
}

/** On abort: the tenant's approvals as they stood when this was planned. */
export function restoreApprovalsCleanup(ports: TenantOnboardPorts, p: NewestBuildsParams): Cleanup {
  return {
    name: "restore-approved-tags",
    title: "Record the tenant's previous approved versions again",
    run: async (ctx) => {
      const { commit } = await ports.registrations.setApprovedTags(p.stage, p.guid, p.previousApproved, ctx.runId);
      ctx.db.update(tenants).set({ approvedTags: p.previousApproved, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
      ctx.log("meta", `tenant ${p.guid}: approved versions back to what they were (${commit})`);
    },
  };
}

/** One step per unit: build its default branch head for this tenant, then approve the built tag. */
export function newestBuildSteps(ports: TenantOnboardPorts, p: NewestBuildsParams): Step[] {
  if (!p.channel) return [];
  const channel = p.channel;
  return p.newest.map((unit) => ({
    ...buildUnitStep(() => ports.onboard?.(), { guid: p.guid, owner: p.owner, stage: p.stage }, unit, {
      channel,
      runningTag: unit.runningTag,
      approve: (ctx, tag, builds) => approveBuiltTag(ctx, ports, p, tag, builds),
    }),
    name: `newest-build:${unit.unit}`,
    title: `Build the newest ${unit.images.join(", ")} of ${unit.unit} on ${channel} for this tenant alone`,
  }));
}

/** Wait until every member is Synced + Healthy rendering the tenant's approvals as they stand now. */
export function watchApprovedStep(ports: TenantOnboardPorts, p: NewestBuildsParams): Step {
  return {
    name: "watch-approved-tags",
    title: "Wait until every member runs the versions approved for this tenant",
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
      if (!renders(byName)) throw errValidation(`tenant ${p.guid}'s members are Synced + Healthy, and ArgoCD has not rendered the approved versions yet — retry this step once the ApplicationSet has regenerated them`);
      ctx.log("meta", `tenant ${p.guid}: every member runs the versions approved for it`);
    },
  };
}
