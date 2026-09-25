import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step, Cleanup, Plan } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { STAGE } from "../../../shared/enums.ts";
import { guid as guidSchema, TenantMemberRecordSchema, type TenantMemberRecord } from "../../../shared/tenant.ts";
import { errNotFound, errValidation, errInternal } from "../../kernel/errors.ts";
import { validateTenant } from "./validate-tenant.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { RequiredImageSchema, requiredImagesFrom, ensureImagesStep } from "./ensure-images.ts";
import { assertDeployState, loadTenantCluster } from "./lifecycle.ts";
import { tenantSyncUnits } from "./build-rbac.ts";
import { memberApplication } from "./tenant-fanout.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { provisionArgoSyncStep } from "./tenant-builds.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "./tenant-watch.ts";

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
// and the plan refuses it. It builds no image either: an image the new render pulls must already stand
// in the registry, which ensure-images proves before anything is written.
//
// THE KNOWN GAP. Between the product's push and the end of this run, a member whose chart moved does
// not answer: the registration still names the old chart. The plan says so.

const MemberList = z.array(TenantMemberRecordSchema).min(1);

export const TenantRefreshMembersParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  guid: guidSchema,
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"),
  domain: z.string().min(1),
  /** The catalog commit the members were resolved and the gates rendered at. */
  chartsRef: z.string().min(1),
  registryHost: z.string().min(1),
  /** The member entries the registration carried when this was planned; an abort writes them back. */
  previous: MemberList,
  /** The member entries resolved off the product's manifest. */
  members: MemberList,
  expectedApps: z.array(z.string().min(1)).min(1),
  requiredImages: z.array(RequiredImageSchema),
  syncUnits: z.array(z.string()),
});
export type TenantRefreshMembersParams = z.infer<typeof TenantRefreshMembersParams>;

export const TenantRefreshMembersRequest = z.object({ tenantId: z.string().startsWith("tnt_") });

function sameMembers(a: readonly TenantMemberRecord[], b: readonly TenantMemberRecord[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** On abort: write back the member entries the registration carried before this run. */
function restoreMembersCleanup(ports: TenantOnboardPorts, p: TenantRefreshMembersParams): Cleanup {
  return {
    name: "restore-members",
    title: "Write the previous member entries back into the registration",
    run: async (ctx) => {
      const { commit } = await ports.registrations.setMembers(p.stage, p.guid, p.previous, ctx.runId);
      ctx.log("meta", `tenant ${p.guid} members back to the entries before this run (${commit})`);
    },
  };
}

function tenantRefreshMembersSteps(ports: TenantOnboardPorts, p: TenantRefreshMembersParams): Step[] {
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
    // Every image the new render pulls stands in the registry before a single entry changes.
    ensureImagesStep(ports, { registryHost: p.registryHost, requiredImages: p.requiredImages }),
    // The grant names the units whose builds the new render pulls, so a release of theirs may sync
    // this tenant; the member Applications it names are the same as before.
    provisionArgoSyncStep(ports, { guid: p.guid, clusterId: p.clusterId, expectedApps: p.expectedApps, syncUnits: p.syncUnits }, {}),
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
        const { commit } = await ports.registrations.setMembers(p.stage, p.guid, p.members, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${p.guid} member entries written (${commit}) — the master ArgoCD renders them at its next sync`);
      },
    },
    {
      name: "watch-sync-set",
      title: "Wait for ArgoCD to sync every member at the new entries",
      run: async (ctx) => {
        const until = syncedAt(p.expectedApps);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, until, {
          timeoutMs: ports.argoWatchTimeoutMs,
          signal: ctx.signal,
          labelSelector: `platform/tenant=${p.guid}`,
        });
        if (!until(byName)) throw errValidation(describeUnsynced(p.expectedApps, byName));
        ctx.log("meta", `tenant ${p.guid}: ${p.expectedApps.length} member Application(s) Synced + Healthy at ${p.chartsRef.slice(0, 7)}`);
      },
    },
  ];
}

/** What one member's entry changes: its chart paths, and whether its value files or values move too. */
function describeChange(before: TenantMemberRecord, after: TenantMemberRecord): string {
  const charts = (m: TenantMemberRecord): string => m.sources.map((s) => s.chart).join(" + ");
  const moved = charts(before) !== charts(after) ? `${charts(before)} → ${charts(after)}` : charts(after);
  return `${after.name} (${moved}${JSON.stringify(before.sources) !== JSON.stringify(after.sources) ? "" : ", labels only"})`;
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
      const clusterValueFiles = await ports.resolveClusterValueFiles(tc.domain, tc.stage);
      const registryHost = registryHostFromChain(clusterValueFiles);
      const { apps, appsImage, appsImageTag, seedUsers, subdomain } = current.entry;
      const outcome = await validateTenant(
        {
          repoURL: ports.catalogRepoUrl,
          // The revision the member Applications read their charts at (tenant-registrations.ts, `branch`).
          ref: ports.registrations.branch,
          stage: tc.stage,
          apps,
          probeGuid: tc.guid,
          subdomain,
          seedUsers,
          ...(appsImage ? { appsImage, appsImageTag } : {}),
          clusterValueFiles,
          ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}),
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
      const changed = members.filter((m) => !sameMembers([m], previous.filter((b) => b.name === m.name)));
      if (changed.length === 0) throw errValidation(`every member entry of tenant ${tc.guid} already matches the product's manifest at ${outcome.resolvedSha.slice(0, 7)} — nothing to refresh`);
      const requiredImages = requiredImagesFrom(outcome.images, registryHost);
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
      };
      const steps = tenantRefreshMembersSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-refresh-members",
        targetKind: "tenant",
        targetId: tc.tenantId,
        summary:
          `Refresh the members of tenant ${tc.guid} on ${tc.domain} (${tc.stage}) from the product's manifest at ${outcome.resolvedSha.slice(0, 7)}: ` +
          `${changed.map((m) => describeChange(previous.find((b) => b.name === m.name)!, m)).join("; ")}. ` +
          `Every image the new render pulls must stand in the registry; then the entries are written and every member must sync. ` +
          `A member whose chart moved does not answer from the product's push until its Application syncs here.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => tenantRefreshMembersSteps(ports, params),
    cleanups: (params) => [restoreMembersCleanup(ports, params)],
  };
}
