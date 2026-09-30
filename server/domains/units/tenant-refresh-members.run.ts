import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step, Cleanup, Plan } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { STAGE } from "../../../shared/enums.ts";
import { approvedImageTag, guid as guidSchema, isOlderRelease, TenantAppSchema, TenantMemberRecordSchema, type TenantMemberRecord } from "../../../shared/tenant.ts";
import { errNotFound, errValidation, errInternal } from "../../kernel/errors.ts";
import { validateTenant } from "./validate-tenant.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { RequiredImageSchema, requiredImagesFrom } from "./ensure-images.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { tenantSyncUnits } from "#unit/server/build-rbac.ts";
import { memberApplication, withAppDatabases } from "./tenant-fanout.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { BuildUnitSchema, buildUnitStep, planBuildUnits, provisionArgoSyncStep, tenantImageSteps, type TenantBuildRuntime } from "./tenant-builds.ts";
import { probeBuildUnit } from "./tenant-probes.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { isDeepStrictEqual } from "node:util";
import { bundleReleaseRefusal, tenantBundleManifest, throwEngineLineRefusal } from "./engine-line.ts";
import { standingAppDatabases } from "./tenant-app-databases.ts";
import {
  restoreVersionsCleanup, sameApprovals, stagePinsOf, tenantVersionParts, versionRefusal, watchVersionsStep, withChosenVersions, writeVersionsStep,
  type Approvals, type TenantVersionPart,
} from "./tenant-versions.ts";

// `tenant-refresh-members` — resolve every member of a STANDING tenant again from the product's
// manifest and write the entries into its registration.
//
// WHY IT EXISTS. A registration carries its members resolved (chart, value files, values), because
// the ApplicationSet renders from it alone. The Manager resolves them when it creates a tenant or adds
// an app, and never again, so a product that renames a chart leaves every standing tenant pointing at a
// chart that is gone. This run is the one way to carry such a change to a standing tenant.
//
// WHAT IT DOES NOT DO. It changes entries, never the member set: a member the manifest adds, drops or
// renames is a new namespace, AppProject and Application, which is create-tenant's and add-app's work,
// and the plan refuses it.
//
// THE IMAGES. An image the new render pulls and the registry lacks is built first, the way create-tenant
// and add-app build theirs: the product's tenant.buildRepos names the unit that builds it, the unit's
// release is re-run (its builds attested again as its manifest declares them now) and pins the image on
// the books branch, the fan-out is rendered again at those pins, and ensure-images proves every image
// before anything is written.
//
// THE VERSIONS. The request names a version per part (tenant-versions.ts), the Versions dialog's choice;
// a part it does not name keeps what it runs. The plan refuses a version the registry lacks for any image
// of the part, one on a channel the stage does not take, and one no release made available at the stage.
// A version older than what runs is a downgrade, allowed on purpose and said in the plan.
//
// THE KNOWN GAP. From the carry of the product's change into the books branch until this run's write
// has synced, a member whose chart moved does not answer: the registration still names the old chart.
// The plan says so.
//
// THE WAIT. The member Applications stand already and read Synced/Healthy before the write, and their
// deploy repository revision moves with every commit on the books branch, so neither proves the new entries are
// rendered. A member counts as synced once ArgoCD's last comparison rendered exactly its new entry:
// each chart path in order, its value files and its values, and its namespace labels on the spec,
// with nothing left that the previous entry carried and this one dropped.

const MemberList = z.array(TenantMemberRecordSchema).min(1);

export const TenantRefreshMembersParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  guid: guidSchema,
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"),
  domain: z.string().min(1),
  /** The deploy repository commit the members were resolved and the gates rendered at. */
  chartsRef: z.string().regex(/^[0-9a-f]{40}$/),
  registryHost: z.string().min(1),
  /** The member entries the registration carried when this was planned; an abort writes them back. */
  previous: MemberList,
  /** The member entries resolved off the product's manifest. */
  members: MemberList,
  expectedApps: z.array(z.string().min(1)).min(1),
  requiredImages: z.array(RequiredImageSchema),
  syncUnits: z.array(z.string()),
  /** What the image steps render the fan-out with again after a build: the tenant's own facts. */
  subdomain: z.string().min(1),
  owner: z.string().min(1),
  apps: z.array(TenantAppSchema),
  seedUsers: z.boolean(),
  /** The tenant's own apps bundle and the tag it stands at ("" where it has none). */
  appsImage: z.string(),
  appsImageTag: z.string(),
  /** The units that build what the registry lacks, resolved at plan time (planBuildUnits). */
  buildUnits: z.array(BuildUnitSchema).default([]),
  /** The tenant's versions when this was planned (#296); an abort writes them back. */
  previousApproved: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** The version chosen per build: every build of a part the request names, at that part's tag. */
  chosenVersions: z.record(z.string(), approvedImageTag).default({}),
});
export type TenantRefreshMembersParams = z.infer<typeof TenantRefreshMembersParams>;

export const TenantRefreshMembersRequest = z.object({
  tenantId: z.string().startsWith("tnt_"),
  /** The version chosen per part, `<part> -> <image tag>`; a part not named keeps what it runs. */
  versions: z.record(z.string().min(1), approvedImageTag).default({}),
});

function sameMembers(a: readonly TenantMemberRecord[], b: readonly TenantMemberRecord[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether ArgoCD's last comparison of a member Application rendered exactly this member entry and
 *  none of what the previous one carried beyond it: its deploy repository sources carry the entry's charts in
 *  order; each carries the entry's value files in their order and no file the previous entry had and
 *  this one dropped, and the entry's values and no value key it dropped; the spec asks for the entry's
 *  namespace labels and none it dropped. The template's own value files and values around the entry's
 *  are the same before and after, so the previous entry is what tells a dropped part from them. */
export function rendersEntry(status: ArgoAppStatus | undefined, member: TenantMemberRecord, previous: TenantMemberRecord | undefined, deployRepoUrl: string): boolean {
  if (!status) return false;
  const charts = (status.syncSources ?? []).filter((src) => src.repoURL === deployRepoUrl && src.path);
  if (charts.length !== member.sources.length) return false;
  const sourcesMatch = member.sources.every((want, i) => {
    const got = charts[i]!;
    const was = previous?.sources[i];
    const files = got.valueFiles ?? [];
    // Each of the entry's files after the one before it, so a file the template also names cannot
    // stand in for the entry's own.
    let from = 0;
    const filesMatch = want.valueFiles.every((f) => { const n = files.indexOf(f, from); from = n + 1; return n >= 0; })
      && (was?.valueFiles ?? []).every((f) => want.valueFiles.includes(f) || !files.includes(f));
    const valuesMatch = Object.entries(want.values).every(([k, v]) => isDeepStrictEqual(got.valuesObject?.[k], v))
      && Object.keys(was?.values ?? {}).every((k) => k in want.values || got.valuesObject?.[k] === undefined);
    return got.path === want.chart && filesMatch && valuesMatch;
  });
  const labels = status.namespaceLabels ?? {};
  const labelsMatch = Object.entries(member.namespaceLabels).every(([k, v]) => labels[k] === v)
    && Object.keys(previous?.namespaceLabels ?? {}).every((k) => k in member.namespaceLabels || labels[k] === undefined);
  return sourcesMatch && labelsMatch;
}

/** Every member Application Synced + Healthy, each rendering its entry of `members`. */
function renderedAt(p: TenantRefreshMembersParams, members: readonly TenantMemberRecord[], deployRepoUrl: string): (byName: ArgoAppStatusMap) => boolean {
  const synced = syncedAt(p.expectedApps);
  return (byName) => synced(byName) && members.every((m, i) => rendersEntry(byName.get(p.expectedApps[i]!), m, p.previous.find((b) => b.name === m.name), deployRepoUrl));
}

/** On abort: write back the member entries the registration carried before this run — only while it
 *  still carries this run's own entries. Entries another run wrote since are that run's, and stay. */
function restoreMembersCleanup(ports: TenantOnboardPorts, p: TenantRefreshMembersParams): Cleanup {
  return {
    name: "restore-members",
    title: "Write the previous member entries back into the registration",
    run: async (ctx) => {
      const current = await ports.registrations.readTenant(p.stage, p.guid);
      if (!current || !sameMembers(current.entry.members, p.members)) {
        ctx.log("meta", `tenant ${p.guid}'s member entries are not the ones this run writes — this run never wrote them, or another run wrote others since; left as they are`);
        return;
      }
      const { commit } = await ports.registrations.setMembers(p.stage, p.guid, p.previous, ctx.runId);
      ctx.log("meta", `tenant ${p.guid} members back to the entries before this run (${commit}); the apps' database lists stay as their catalog entries declare them`);
    },
  };
}

/** Refuses the abort once every member Application is Synced/Healthy rendering this run's entries: the
 *  tenant serves from them, and writing the previous entries back would put it on charts the product
 *  no longer carries. A retry of the failed step is the way on. */
async function assertRefreshAbortable(ports: TenantOnboardPorts, p: TenantRefreshMembersParams): Promise<void> {
  // A run that changes no entry writes the same entries back on an abort, and only its versions go back.
  if (sameMembers(p.previous, p.members)) return;
  const current = await ports.registrations.readTenant(p.stage, p.guid);
  if (!current || !sameMembers(current.entry.members, p.members)) return;
  const until = renderedAt(p, p.members, ports.deployRepoUrl);
  const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
  const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, until, { timeoutMs: 1, labelSelector: `platform/tenant=${p.guid}` });
  if (until(byName)) {
    throw errValidation(
      `every member of tenant ${p.guid} is Synced + Healthy rendering this run's entries — an abort would write back entries whose charts the product no longer carries. ` +
      `Retry the failed step instead so the run settles green.`,
    );
  }
}

function tenantRefreshMembersSteps(ports: TenantOnboardPorts, p: TenantRefreshMembersParams): Step[] {
  // The bundle stands built at its recorded tag: a render again after a unit's build mounts it there.
  const runtime: TenantBuildRuntime = p.appsImage ? { appsImageTag: p.appsImageTag } : {};
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), p.domain, "tenant");
        ctx.log("meta", `target ${p.domain} attested for ${p.guid} at ${p.stage} — deploy-state generation ${state.generation}`);
      },
    },
    // The units that build what the registry lacks, before anything of the tenant is written.
    ...(p.buildUnits ?? []).map((unit) => ({
      ...buildUnitStep(() => ports.onboard?.(), { guid: p.guid, owner: p.owner, stage: p.stage }, unit),
      probe: (ctx: ProbeCtx) => probeBuildUnit(() => ports.onboard?.(), ports, p, unit, ctx),
    })),
    // Every image the new render pulls stands in the registry before a single entry changes; after a
    // build, the render is taken again at the pins the build wrote.
    ...tenantImageSteps(ports, {
      guid: p.guid, domain: p.domain, stage: p.stage, subdomain: p.subdomain, apps: p.apps, isStandingTenant: true, seedUsers: p.seedUsers,
      registryHost: p.registryHost, requiredImages: p.requiredImages, buildUnits: p.buildUnits,
      ...(p.appsImage ? { appsImage: p.appsImage } : {}),
    }, runtime),
    // The grant names the units whose builds the new render pulls, so a release of theirs may sync
    // this tenant; the member Applications it names are the same as before.
    provisionArgoSyncStep(ports, { guid: p.guid, clusterId: p.clusterId, expectedApps: p.expectedApps, syncUnits: p.syncUnits }, runtime),
    {
      name: "write-members",
      title: "Write the resolved member entries into the registration",
      run: async (ctx) => {
        const current = await ports.registrations.readTenant(p.stage, p.guid);
        if (!current) throw errNotFound(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
        // The plan's facts, asked again: another run may have changed the members since. A resume
        // finds its own write already standing.
        if (!sameMembers(current.entry.members, p.previous) && !sameMembers(current.entry.members, p.members)) {
          throw errValidation(`tenant ${p.guid}'s member entries changed since this run was planned — plan it again`);
        }
        ctx.registerCleanup(restoreMembersCleanup(ports, p));
        const { commit } = await ports.registrations.setMembers(p.stage, p.guid, p.members, ctx.runId, p.apps);
        ctx.db.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${p.guid} member entries written (${commit}) — the master ArgoCD renders them once its ApplicationSet regenerates the member Applications`);
      },
    },
    // The chosen versions, as the tenant's own, written before any wait: a member whose running
    // version can no longer start (its image gone from the registry) gets healthy only on the version
    // chosen, so a wait ahead of this write would never end.
    writeVersionsStep(ports, p),
    {
      name: "watch-sync-set",
      title: "Wait until every member is Synced + Healthy rendering its new entry",
      run: async (ctx) => {
        const until = renderedAt(p, p.members, ports.deployRepoUrl);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, until, {
          timeoutMs: ports.argoWatchTimeoutMs,
          signal: ctx.signal,
          labelSelector: `platform/tenant=${p.guid}`,
        });
        if (!syncedAt(p.expectedApps)(byName)) throw errValidation(`tenant ${p.guid} fan-out did not converge — ${describeUnsynced(p.expectedApps, byName)}`);
        if (!until(byName)) {
          const stale = p.members.filter((m, i) => !rendersEntry(byName.get(p.expectedApps[i]!), m, p.previous.find((b) => b.name === m.name), ports.deployRepoUrl)).map((m) => m.name);
          throw errValidation(`${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} Synced + Healthy but ArgoCD has not rendered the new ${stale.length === 1 ? "entry" : "entries"} yet — retry this step once the ApplicationSet has regenerated ${stale.length === 1 ? "it" : "them"}`);
        }
        ctx.log("meta", `tenant ${p.guid}: ${p.expectedApps.length} member Application(s) Synced + Healthy, each rendering its new entry`);
      },
    },
    watchVersionsStep(ports, p),
  ];
}

/** Every part whose version the run moves, `part old → new`, and apart from them every one it moves
 *  back: a downgrade is chosen on purpose, so it is said rather than refused. */
function versionMoves(parts: readonly TenantVersionPart[], after: Approvals): { forward: string[]; back: string[] } {
  const forward: string[] = [];
  const back: string[] = [];
  for (const part of parts) {
    const builds = new Set(part.builds.map((b) => b.name));
    const next = [...new Set(Object.values(after).flatMap((held) => Object.entries(held).filter(([b]) => builds.has(b)).map(([, t]) => t)))];
    if (next.length === part.running.length && next.every((t) => part.running.includes(t))) continue;
    const newest = part.running[0];
    const line = `${part.name} ${part.running.join(" / ")} → ${next.join(" / ")}`;
    (newest !== undefined && next.some((t) => isOlderRelease(t, newest)) ? back : forward).push(line);
  }
  return { forward, back };
}

/** What one member's entry changes: its chart paths, or else its value files and values, or else its
 *  namespace labels. */
function describeChange(before: TenantMemberRecord, after: TenantMemberRecord): string {
  const charts = (m: TenantMemberRecord): string => m.sources.map((s) => s.chart).join(" + ");
  if (charts(before) !== charts(after)) return `${after.name} (${charts(before)} → ${charts(after)})`;
  const what = JSON.stringify(before.sources) !== JSON.stringify(after.sources) ? "value files or values" : "namespace labels";
  return `${after.name} (${charts(after)}, ${what} change)`;
}

export function makeTenantRefreshMembersDef(ports: TenantOnboardPorts): RunDefinition<TenantRefreshMembersParams> {
  return {
    kind: "tenant-refresh-members",
    paramsSchema: TenantRefreshMembersParams,
    mutating: true,
    plan: () => {
      throw errInternal("tenant-refresh-members is planned via planStream (the streaming entrypoint), not plan()");
    },
    planStream: async (rawParams, ctx) => {
      const req = TenantRefreshMembersRequest.parse(rawParams);
      const tc = loadTenantCluster(ctx.db, req.tenantId);
      const row = ctx.db.select({ status: tenants.status, suspended: tenants.suspended }).from(tenants).where(eq(tenants.id, req.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run first`);
      if (row?.status === "offboarded" || row?.status === "purged") throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing serves it`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its members render no workloads, so the wait could never end; resume it first`);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      // The product's change reaches the books branch only when its trunk is carried there, and the
      // members are resolved off that branch: planned over a branch one product state behind, the run
      // would answer "nothing to refresh" right after the push it exists for.
      if (!ports.carryTrunkToBooksBranch) throw errValidation("this manager carries no deploy trunk into the books branch, so the members cannot be resolved off the product's current manifest");
      await ports.carryTrunkToBooksBranch();
      ctx.log(`deploy trunk carried into the books branch ${ports.registrations.branch}`);
      const clusterValueFiles = await ports.resolveClusterValueFiles(tc.domain, tc.stage);
      const registryHost = registryHostFromChain(clusterValueFiles);
      const { apps, appsImage, appsImageTag, seedUsers, subdomain } = current.entry;
      const appDatabases = await standingAppDatabases((bundle, signal) => tenantBundleManifest(ports, bundle, signal), current.entry, ctx);
      const outcome = await validateTenant(
        {
          repoURL: ports.deployRepoUrl,
          // The revision the member Applications read their charts at (tenant-registrations.ts, `branch`).
          ref: ports.registrations.branch,
          stage: tc.stage,
          apps,
          isStandingTenant: true,
          appDatabases,
          probeGuid: tc.guid,
          subdomain,
          seedUsers,
          ...(appsImage ? { appsImage, appsImageTag } : {}),
          clusterValueFiles,
          ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
        },
        { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal },
      );
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        return {
          outcome: "rejected",
          summary: `Refreshing the members of tenant ${tc.guid} was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`,
          planJson: outcome.report,
        };
      }
      const previous = current.entry.members;
      const members = outcome.memberRecords;
      const names = (list: readonly TenantMemberRecord[]): string => list.map((m) => m.name).sort().join(", ");
      if (names(previous) !== names(members)) {
        throw errValidation(
          `the product's manifest resolves the members ${names(members)} for tenant ${tc.guid}, which stands with ${names(previous)} — ` +
          `a member added, dropped or renamed is a new namespace and Application, not a refresh`,
        );
      }
      if (outcome.identityProvider !== current.entry.identityProvider) {
        throw errValidation(
          `the product's manifest names ${outcome.identityProvider} as the identity provider of tenant ${tc.guid}, which stands with ${current.entry.identityProvider} — ` +
          `moving the identity provider moves its users, which is not a refresh`,
        );
      }
      const changed = members.filter((m) => !sameMembers([m], previous.filter((b) => b.name === m.name)));
      const parts = await tenantVersionParts(ports, tc.stage, members, current.entry.approvedTags);
      const channels = await ports.channelStages();
      const chosenVersions: Record<string, string> = {};
      for (const [name, tag] of Object.entries(req.versions)) {
        const part = parts.find((p) => p.name === name);
        if (!part) throw errValidation(`tenant ${tc.subdomain} has no part "${name}" — its parts are ${parts.map((p) => p.name).join(", ") || "none"}`);
        const refusal = versionRefusal(tag, part, channels, tc.stage);
        if (refusal) throw errValidation(`${name} of tenant ${tc.subdomain} cannot run ${tag} — ${refusal}`);
        for (const b of part.builds) {
          if (!(await ports.registryProbe.imageExists({ registryHost, repo: b.image, tag }, { signal: ctx.signal }))) {
            throw errValidation(`${registryHost}/${b.image}:${tag} is not in the registry — a version is chosen only where every image of its part stands there`);
          }
          chosenVersions[b.name] = tag;
        }
      }
      // A build the tenant does not hold yet starts at its stage pin; write-versions reads the pins again when it runs.
      const approved = withChosenVersions(current.entry.approvedTags, await stagePinsOf((chart) => ports.registrations.listPinnedBuilds(tc.stage, chart), members), chosenVersions);
      // The engines this run puts the tenant on have to fit the bundle it runs, read off the tenant's
      // own repository at the release the bundle was built from where a version moves a line
      // (engine-line.ts); write-versions judges again with the pins as they stand then.
      throwEngineLineRefusal(await bundleReleaseRefusal(ports, current.entry, current.entry.approvedTags, approved, ctx), `tenant ${tc.subdomain} cannot run these versions`);
      const moves = versionMoves(parts, approved);
      // A build the tenant held no version of renders its stage pin; recording it changes nothing that runs.
      const recorded = Object.entries(approved).flatMap(([m, builds]) =>
        Object.entries(builds).filter(([b]) => current.entry.approvedTags[m]?.[b] === undefined && chosenVersions[b] === undefined).map(([b, t]) => `${m}/${b} ${t}`));
      const requiredImages = requiredImagesFrom(outcome.images, registryHost);
      const planned = await planBuildUnits({
        requiredImages, registryHost, buildRepos: outcome.spec?.buildRepos ?? [], appsBundle: outcome.spec?.appsBundle, appsImage: appsImage || undefined,
        probe: ports.registryProbe, registration: ports.buildUnitRegistration ?? (async () => null), githubApp: ports.githubApp,
        owners: (org) => readOwnerIdentity(ctx.db, org), stage: tc.stage, subdomain, signal: ctx.signal, log: ctx.log,
      });
      if (planned.outcome === "rejected") return { outcome: "rejected", summary: planned.summary, planJson: outcome.report };
      // Nothing to do is a result, not an error: the run passes through every step and changes nothing.
      // Each app with the database list the tenant's own repository declares now, which every member reads.
      const listedApps = withAppDatabases(apps, outcome.appDatabases);
      const relisted = listedApps.filter((a, i) => JSON.stringify(a.databases ?? []) !== JSON.stringify(apps[i]?.databases ?? [])).map((a) => a.name);
      const isCurrent = changed.length === 0 && relisted.length === 0 && sameApprovals(approved, current.entry.approvedTags) && planned.builds.units.length === 0;
      const params: TenantRefreshMembersParams = {
        tenantId: tc.tenantId,
        guid: tc.guid,
        stage: tc.stage,
        clusterId: tc.clusterId,
        domain: tc.domain,
        chartsRef: outcome.resolvedSha,
        registryHost,
        previous,
        members,
        expectedApps: members.map((m) => memberApplication(tc.guid, m.name, tc.stage)),
        requiredImages,
        syncUnits: tenantSyncUnits(requiredImages, await ports.attestedBuilds()),
        subdomain, owner: tc.owner, apps: listedApps, seedUsers, appsImage, appsImageTag: appsImageTag ?? "",
        buildUnits: planned.builds.units,
        previousApproved: current.entry.approvedTags,
        chosenVersions,
      };
      const steps = tenantRefreshMembersSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-refresh-members",
        targetKind: "tenant",
        targetId: tc.tenantId,
        summary:
          `Versions of tenant ${tc.guid} on ${tc.domain} (${tc.stage}), its member entries resolved again off the product's manifest at ${outcome.resolvedSha.slice(0, 7)}: ` +
          `${isCurrent ? "nothing changes — every member entry matches the product's manifest and every part runs the version asked for. " : ""}` +
          `${changed.length ? `${changed.map((m) => describeChange(previous.find((b) => b.name === m.name)!, m)).join("; ")}. ` : "the member entries are unchanged. "}` +
          `${relisted.length ? `The database lists of ${relisted.join(", ")} are written into tenant.apps as the tenant's own repository declares them. ` : ""}` +
          `${moves.forward.length ? `Versions: ${moves.forward.join("; ")}. ` : ""}` +
          `${moves.back.length ? `Downgrade: ${moves.back.join("; ")}, older than what runs now. ` : ""}` +
          `${recorded.length ? `Recorded as the tenant's own at the stage pin it renders now: ${recorded.join("; ")}. ` : ""}` +
          `${moves.forward.length || moves.back.length ? "No other tenant changes. " : ""}` +
          `${planned.builds.units.length ? `First the build unit(s) ${planned.builds.units.map((u) => `${u.unit} (${u.images.join(", ")})`).join("; ")} release their next version and pin it. ` : ""}` +
          `Every image the new render pulls must stand in the registry; then the entries are written and every member must sync. ` +
          `A member whose chart moved does not answer from the carry of the product's change into the books branch until its Application syncs here.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [
          ...moves.back.map((d) => `downgrade: ${d} — only the images move back; a database the newer version migrated stays migrated, and the older version must run on it`),
          ...planned.builds.units.map((u) =>
            `build unit ${u.unit} builds ${u.images.join(", ")}: ${u.registered ? "registered, so its builds are attested again as its manifest declares them now and its release is re-run; the attestation stays after an abort, and a tenant still pulling a build it drops stays on that build's last pin" : "not registered, so it is onboarded build-only"} — its next version is pinned for ${tc.stage} on the books branch`),
        ],
        requiredSecrets: [],
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => tenantRefreshMembersSteps(ports, params),
    cleanups: (params) => [restoreMembersCleanup(ports, params), restoreVersionsCleanup(ports, params)],
    assertAbortable: (params) => assertRefreshAbortable(ports, params),
  };
}
