import { z } from "zod";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import type { Cleanup, RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { errInternal, errNotFound, errValidation } from "../../kernel/errors.ts";
import { appName, guid, memberName, type TenantRegistration } from "../../../shared/tenant.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { attestTenantTargetStep, loadTenantCluster, refreshTenantApplications } from "./lifecycle.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { readStandingTenant } from "./tenant-standing.ts";

// `tenant-set-website-main` — make one deployed website the tenant's main website: the one served at `/`
// of the tenant's domain. The mark is `main` on the website's apps[] entry, which every member chart reads
// off `tenant.apps`, so the run writes it (and clears it on the website that held it) in one commit and
// waits until every member's Application renders it. Ownership of the write follows tenant-set-demo:
// the tenant row's lastRunId, so a cleanup gives the mark back only while this run's write still stands.

export const TenantSetWebsiteMainRequest = z.object({ tenantId: z.string().startsWith("tnt_"), app: appName });
export const TenantSetWebsiteMainParams = TenantSetWebsiteMainRequest.extend({
  /** The website that held the mark when the run was planned, or null where none did. */
  previous: appName.nullable(),
  guid,
  clusterId: z.string().startsWith("cls_"),
  members: z.array(memberName).min(1),
});
export type TenantSetWebsiteMainParams = z.infer<typeof TenantSetWebsiteMainParams>;

const mainOf = (entry: TenantRegistration): string | null => entry.apps.find((a) => a.main)?.name ?? null;
const currentTenant = (ports: TenantOnboardPorts, p: TenantSetWebsiteMainParams, ctx: Pick<StepCtx, "db">) => readStandingTenant(ports, p, ctx, "the main website");
const ownerRun = (ctx: Pick<StepCtx, "db">, tenantId: string): string | null | undefined => ctx.db.select({ lastRunId: tenants.lastRunId }).from(tenants).where(eq(tenants.id, tenantId)).get()?.lastRunId;

function restoreMainWebsite(ports: TenantOnboardPorts, p: TenantSetWebsiteMainParams): Cleanup {
  return {
    name: "restore-main-website", title: p.previous ? `Give the main website back to ${p.previous}` : "Leave the tenant without a main website",
    run: async (ctx) => {
      const { tc, entry } = await currentTenant(ports, p, ctx);
      if (mainOf(entry) !== p.app || ownerRun(ctx, p.tenantId) !== ctx.runId) {
        ctx.log("meta", `tenant ${tc.guid} no longer carries this run's main website — left as it is`);
        return;
      }
      const { commit } = await ports.registrations.setWebsiteMain(tc.stage, tc.guid, p.previous, ctx.runId);
      await refreshTenantApplications(ports.resolver, tc.clusterId, p.members.map((m) => memberApplication(tc.guid, m, tc.stage)), ctx);
      ctx.log("meta", `tenant ${tc.guid}: main website restored to ${p.previous ?? "none"} (${commit})`);
    },
  };
}

function mainWebsiteSteps(ports: TenantOnboardPorts, p: TenantSetWebsiteMainParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-main-website", title: `Mark ${p.app} as the main website in the registration`,
      run: async (ctx) => {
        const { tc, entry } = await currentTenant(ports, p, ctx);
        const owner = ownerRun(ctx, p.tenantId);
        // Only the mark decides: every run on the tenant, a Versions run among them, moves lastRunId.
        if (owner !== ctx.runId && mainOf(entry) !== p.previous) {
          throw errValidation("the main website changed since this change was planned — plan it again");
        }
        ctx.registerCleanup(restoreMainWebsite(ports, p));
        // Persist ownership before git commits, so a crash after that commit can retry or undo it.
        ctx.db.update(tenants).set({ lastRunId: ctx.runId }).where(eq(tenants.id, p.tenantId)).run();
        const { commit } = await ports.registrations.setWebsiteMain(tc.stage, tc.guid, p.app, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid}: main website ${p.previous ?? "none"} → ${p.app}; members ${p.members.join(", ")} (${commit})`);
        await refreshTenantApplications(ports.resolver, tc.clusterId, p.members.map((m) => memberApplication(tc.guid, m, tc.stage)), ctx);
      },
    },
    {
      name: "watch-members", title: `Wait until every member renders ${p.app} as the main website`,
      run: async (ctx) => {
        const { tc, entry } = await currentTenant(ports, p, ctx);
        if (mainOf(entry) !== p.app) throw errValidation("the registration no longer marks this run's website as the main website — plan it again");
        const apps = p.members.map((m) => memberApplication(tc.guid, m, tc.stage));
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const renders = (byName: Parameters<ReturnType<typeof syncedAt>>[0]): boolean => apps.every((a) => {
          const charts = (byName.get(a)?.syncSources ?? []).filter((s) => s.repoURL === ports.deployRepoUrl && s.path);
          return charts.length > 0 && charts.every((s) => {
            const rendered = (s.valuesObject?.["tenant"] as { apps?: { name?: unknown; main?: unknown }[] } | undefined)?.apps ?? [];
            const marked = rendered.filter((r) => r.main === true).map((r) => r.name);
            return marked.length === 1 && marked[0] === p.app;
          });
        });
        const byName = await argoReader.watchApplicationSet(argoNamespace, apps, (rows) => syncedAt(apps)(rows) && renders(rows), { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${tc.guid}` });
        if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${tc.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
        if (!renders(byName)) throw errValidation(`not every member renders ${p.app} as the only main website: ${p.members.join(", ")}`);
        ctx.log("meta", `tenant ${tc.guid}: ${p.app} rendered as the main website and Synced + Healthy for ${p.members.join(", ")}`);
      },
    },
  ];
}

export function makeTenantSetWebsiteMainDef(ports: TenantOnboardPorts): RunDefinition<TenantSetWebsiteMainParams> {
  return {
    kind: "tenant-set-website-main", paramsSchema: TenantSetWebsiteMainParams, mutating: true,
    plan: () => { throw errInternal("tenant-set-website-main is planned via planStream"); },
    planStream: async (raw, ctx) => {
      const request = TenantSetWebsiteMainRequest.parse(raw);
      const tc = loadTenantCluster(ctx.db, request.tenantId);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} has no registration at ${tc.stage}`);
      const params = { ...request, previous: mainOf(current.entry), guid: tc.guid, clusterId: tc.clusterId, members: current.entry.members.map((m) => m.name) };
      await currentTenant(ports, params, ctx);
      const website = current.entry.apps.find((a) => a.name === request.app);
      if (!website?.folder || !website.site) throw errValidation(`app "${request.app}" of tenant ${tc.subdomain} is no website — only a website can be the main website`);
      if (params.previous === request.app) throw errValidation(`website "${request.app}" is already the main website of tenant ${tc.subdomain}`);
      const steps = mainWebsiteSteps(ports, params);
      return { outcome: "planned", params, plan: {
        kind: "tenant-set-website-main", targetKind: "tenant", targetId: request.tenantId,
        summary: `Make website "${request.app}" the main website of tenant ${tc.subdomain}, served at / of the tenant's domain. ${params.previous ? `Website "${params.previous}" stops being it` : "No website is the main website today"}; the registration is written in one commit, and the run waits until every member of the tenant renders it. An abort gives the mark back.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })), targets: [], locks: tenantLocks(ports.registrations), warnings: [], requiredSecrets: [],
      } };
    },
    steps: (params) => mainWebsiteSteps(ports, params), cleanups: (params) => [restoreMainWebsite(ports, params)],
  };
}
