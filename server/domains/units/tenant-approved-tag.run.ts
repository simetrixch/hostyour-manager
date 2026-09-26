import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { approvedImageTag, buildName, memberName } from "../../../shared/tenant.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

// `tenant-set-approved-tag` — approve, change or clear the image tag ONE app of ONE tenant runs for
// ONE of its builds, above the stage pin every tenant shares (hostyour-manager#283). An app may work
// better with a particular version; the owner decides that per tenant and per app.
//
// THE CONTRACT WITH THE CHARTS (digita-deploy#58). The tenants ApplicationSet hands every member
// `tenant.approvedTags`, and a chart takes `tenant.approvedTags.<tenant.appName>.<build>` over the
// stage pin where it is set. An approval replaces only the tag: the build must stand in the chart's
// stage pin file. An approval is cleared by REMOVING its key; an empty value fails the render.
//
// WHAT IS PROVEN BEFORE ANYTHING IS WRITTEN: the app is one of the tenant's, the build is one its
// charts' stage pins name, and the registry holds the image at that tag. WHAT THE RUN WAITS FOR: the
// member Application Synced + Healthy on a comparison that renders the new value, so a green run is
// the new tag deployed and not a commit nobody has looked at yet.

export const TenantSetApprovedTagParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  /** The app, as its members receive it in tenant.appName: the app, or a standing member's name. */
  app: memberName,
  build: buildName,
  /** The tag to approve, or "" to clear the approval and follow the stage pin again. */
  tag: z.union([z.literal(""), approvedImageTag]),
  /** The approval standing when this was asked for ("" = none). An abort writes it back. */
  previous: z.union([z.literal(""), approvedImageTag]),
});
export type TenantSetApprovedTagParams = z.infer<typeof TenantSetApprovedTagParams>;

function approvalOf(tags: Record<string, Record<string, string>>, app: string, build: string): string {
  return tags[app]?.[build] ?? "";
}

/** The approvals with `app.build` set to `tag`, or removed where `tag` is "". An app left with no
 *  build loses its key too, so a cleared approval leaves nothing behind. */
function withApproval(tags: Record<string, Record<string, string>>, app: string, build: string, tag: string): Record<string, Record<string, string>> {
  const next: Record<string, Record<string, string>> = Object.fromEntries(Object.entries(tags).map(([a, b]) => [a, { ...b }]));
  const builds = next[app] ?? {};
  if (tag === "") delete builds[build];
  else builds[build] = tag;
  if (Object.keys(builds).length === 0) delete next[app];
  else next[app] = builds;
  return next;
}

/** Whether a member Application's last comparison renders `tag` for app and build (absent for ""). */
function rendersApproval(status: ArgoAppStatus | undefined, deployRepoUrl: string, app: string, build: string, tag: string): boolean {
  const charts = (status?.syncSources ?? []).filter((src) => src.repoURL === deployRepoUrl && src.path);
  if (charts.length === 0) return false;
  return charts.every((src) => {
    const approved = (src.valuesObject?.["tenant"] as { approvedTags?: Record<string, Record<string, unknown>> } | undefined)?.approvedTags;
    const seen = approved?.[app]?.[build];
    return tag === "" ? seen === undefined : seen === tag;
  });
}

async function writeApproval(ports: TenantOnboardPorts, tc: TenantCluster, db: Parameters<Step["run"]>[0]["db"], app: string, build: string, tag: string, runId: string): Promise<string> {
  const current = await ports.registrations.readTenant(tc.stage, tc.guid);
  if (!current) throw errValidation(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
  const next = withApproval(current.entry.approvedTags, app, build, tag);
  const { commit } = await ports.registrations.setApprovedTags(tc.stage, tc.guid, next, runId);
  db.update(tenants).set({ approvedTags: next, lastRunId: runId, updatedAt: new Date() }).where(eq(tenants.id, tc.tenantId)).run();
  return commit;
}

/** On abort: write the previous approval back, while the registration still carries this run's. */
function restoreApprovalCleanup(ports: TenantOnboardPorts, p: TenantSetApprovedTagParams): Cleanup {
  return {
    name: "restore-approved-tag",
    title: `Approve ${p.previous || "the stage pin"} again for ${p.app}/${p.build}`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      if (approvalOf(tc.approvedTags, p.app, p.build) !== p.tag) {
        ctx.log("meta", `${p.app}/${p.build} no longer carries this run's approval — another run wrote it since; left as it is`);
        return;
      }
      const commit = await writeApproval(ports, tc, ctx.db, p.app, p.build, p.previous, ctx.runId);
      ctx.log("meta", `${p.app}/${p.build} back to ${p.previous || "the stage pin"} (${commit})`);
    },
  };
}

function tenantSetApprovedTagSteps(ports: TenantOnboardPorts, p: TenantSetApprovedTagParams): Step[] {
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), tc.domain, "tenant");
        ctx.log("meta", `target ${tc.domain} attested for ${tc.guid} at ${tc.stage} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "write-approved-tag",
      title: `Record ${p.tag || "the stage pin"} for ${p.app}/${p.build} on the tenant's registration and row`,
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        // The plan's fact, asked again: another run may have changed this approval since. A resume
        // finds its own write already standing.
        const standing = approvalOf(tc.approvedTags, p.app, p.build);
        if (standing !== p.previous && standing !== p.tag) throw errValidation(`${p.app}/${p.build} of tenant ${tc.subdomain} carries ${standing || "no approval"} now, not ${p.previous || "no approval"} as when this run was planned — plan it again`);
        ctx.registerCleanup(restoreApprovalCleanup(ports, p));
        const commit = await writeApproval(ports, tc, ctx.db, p.app, p.build, p.tag, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `${p.app}/${p.build} of tenant ${tc.guid}: ${p.previous || "stage pin"} → ${p.tag || "stage pin"} (${commit})`);
      },
    },
    {
      name: "watch-member",
      title: `Wait until the member ${p.app} is Synced + Healthy on the approved tag`,
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const app = memberApplication(tc.guid, p.app, tc.stage);
        const until = (byName: ArgoAppStatusMap): boolean => syncedAt([app])(byName) && rendersApproval(byName.get(app), ports.catalogRepoUrl, p.app, p.build, p.tag);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, [app], until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${tc.guid}` });
        if (!syncedAt([app])(byName)) throw errValidation(describeUnsynced([app], byName));
        if (!until(byName)) throw errValidation(`${app} is Synced + Healthy but ArgoCD has not rendered ${p.tag || "the cleared approval"} for ${p.build} yet — retry this step once the ApplicationSet has regenerated it`);
        ctx.log("meta", `${app} runs ${p.build} at ${p.tag || "its stage pin"}`);
      },
    },
  ];
}

export function makeTenantSetApprovedTagDef(ports: TenantOnboardPorts): RunDefinition<TenantSetApprovedTagParams> {
  return {
    kind: "tenant-set-approved-tag",
    paramsSchema: TenantSetApprovedTagParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const row = db.select({ status: tenants.status, suspended: tenants.suspended }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run first`);
      if (row && (TENANT_SETTLED_STATUS as readonly string[]).includes(row.status)) throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing runs to approve a version for`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its members render no workloads, so the wait could never end; resume it first`);
      const standing = approvalOf(tc.approvedTags, params.app, params.build);
      if (standing !== params.previous) throw errValidation(`${params.app}/${params.build} of tenant ${tc.subdomain} carries ${standing || "no approval"}, not ${params.previous || "no approval"} as this request says — ask again`);
      if (standing === params.tag) throw errValidation(`${params.app}/${params.build} of tenant ${tc.subdomain} already runs ${params.tag || "its stage pin"} — nothing to change`);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errValidation(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      const member = current.entry.members.find((m) => m.name === params.app);
      if (!member) throw errValidation(`tenant ${tc.subdomain} has no app or member "${params.app}" — it has ${current.entry.members.map((m) => m.name).join(", ")}`);
      // The build must be one the member's charts render from their stage pins: an approval for a
      // build no chart renders is ignored by the charts, and the run would record a version nobody runs.
      const pinned = (await Promise.all(member.sources.map((s) => ports.registrations.listPinnedBuilds(tc.stage, s.chart)))).flat();
      const pin = pinned.find((b) => b.name === params.build);
      if (!pin) throw errValidation(`no chart of ${params.app} pins a build "${params.build}" at ${tc.stage} — its charts' stage pins name ${pinned.map((b) => b.name).join(", ") || "none"}`);
      if (params.tag !== "") {
        const registryHost = registryHostFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage));
        const exists = await ports.registryProbe.imageExists({ registryHost, repo: pin.image, tag: params.tag }, {});
        if (!exists) throw errValidation(`${registryHost}/${pin.image}:${params.tag} is not in the registry — only a version this installation has built can be approved`);
      }
      const steps = tenantSetApprovedTagSteps(ports, params);
      return {
        kind: "tenant-set-approved-tag",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `Run ${params.app}/${params.build} of tenant ${tc.guid} (${tc.domain}, ${tc.stage}) at ${params.tag || "its stage pin"}` +
          `${params.previous ? `, instead of the approved ${params.previous}` : ", instead of its stage pin"}: record it on the registration and the row, ` +
          `then wait until the member ${params.app} is Synced + Healthy rendering it.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetApprovedTagSteps(ports, params),
    cleanups: (params) => [restoreApprovalCleanup(ports, params)],
  };
}
