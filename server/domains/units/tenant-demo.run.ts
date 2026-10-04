import { z } from "zod";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import type { Cleanup, RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { errInternal, errNotFound, errValidation } from "../../kernel/errors.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { guid, memberName } from "../../../shared/tenant.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { attestTenantTargetStep, loadTenantCluster, refreshTenantApplications } from "./lifecycle.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";

export const TenantSetDemoRequest = z.object({ tenantId: z.string().startsWith("tnt_"), demo: z.boolean() });
export const TenantSetDemoParams = TenantSetDemoRequest.extend({
  previous: z.boolean(), guid, clusterId: z.string().startsWith("cls_"), members: z.array(memberName).min(1),
});
export type TenantSetDemoParams = z.infer<typeof TenantSetDemoParams>;

async function currentDemo(ports: TenantOnboardPorts, p: TenantSetDemoParams, ctx: Pick<StepCtx, "db">) {
  const tc = loadTenantCluster(ctx.db, p.tenantId);
  assertTenantProvisioned(loadTenantStatus(ctx.db, p.tenantId), "setting demo mode");
  const current = await ports.registrations.readTenant(tc.stage, tc.guid);
  if (!current) throw errNotFound(`tenant ${tc.guid} has no registration at ${tc.stage}`);
  if (tc.guid !== p.guid || tc.clusterId !== p.clusterId || current.entry.members.map((m) => m.name).join(",") !== p.members.join(",")) {
    throw errValidation("the tenant target or members changed since this demo switch was planned — plan it again");
  }
  if (current.entry.suspended || (TENANT_SETTLED_STATUS as readonly string[]).includes(loadTenantStatus(ctx.db, p.tenantId).status)) {
    throw errValidation(`tenant ${tc.subdomain} is suspended or removed — demo mode needs running members`);
  }
  return { tc, entry: current.entry };
}

function restoreDemo(ports: TenantOnboardPorts, p: TenantSetDemoParams): Cleanup {
  return {
    name: "restore-demo", title: `Restore demo mode ${p.previous ? "on" : "off"}`,
    run: async (ctx) => {
      const { tc, entry } = await currentDemo(ports, p, ctx);
      const owner = ctx.db.select({ lastRunId: tenants.lastRunId }).from(tenants).where(eq(tenants.id, p.tenantId)).get();
      if ((entry.demo ?? false) !== p.demo || owner?.lastRunId !== ctx.runId) {
        ctx.log("meta", `tenant ${tc.guid} no longer carries this run's demo switch — left as it is`);
        return;
      }
      const { commit } = await ports.registrations.setDemo(tc.stage, tc.guid, p.previous, ctx.runId);
      await refreshTenantApplications(ports.resolver, tc.clusterId, p.members.map((m) => memberApplication(tc.guid, m, tc.stage)), ctx);
      ctx.log("meta", `tenant ${tc.guid}: demo restored to ${p.previous} (${commit})`);
    },
  };
}

function demoSteps(ports: TenantOnboardPorts, p: TenantSetDemoParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-demo", title: `Set demo mode ${p.demo ? "on" : "off"} for every member`,
      run: async (ctx) => {
        const { tc } = await currentDemo(ports, p, ctx);
        ctx.registerCleanup(restoreDemo(ports, p));
        const { commit } = await ports.registrations.setDemo(tc.stage, tc.guid, p.demo, ctx.runId);
        ctx.db.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid}: demo ${p.previous} → ${p.demo}; members ${p.members.join(", ")} (${commit})`);
        await refreshTenantApplications(ports.resolver, tc.clusterId, p.members.map((m) => memberApplication(tc.guid, m, tc.stage)), ctx);
      },
    },
    {
      name: "watch-members", title: "Wait until every member renders the requested demo mode",
      run: async (ctx) => {
        const { tc, entry } = await currentDemo(ports, p, ctx);
        if ((entry.demo ?? false) !== p.demo) throw errValidation("the registration no longer carries this run's demo mode — plan it again");
        const apps = p.members.map((m) => memberApplication(tc.guid, m, tc.stage));
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const renders = (byName: Parameters<ReturnType<typeof syncedAt>>[0]): boolean => apps.every((a) => {
          const charts = (byName.get(a)?.syncSources ?? []).filter((s) => s.repoURL === ports.deployRepoUrl && s.path);
          return charts.length > 0 && charts.every((s) => {
            const demo = (s.valuesObject?.["tenant"] as { demo?: unknown } | undefined)?.demo;
            // The ApplicationSet omits demo when off; the member charts default it to false.
            return demo === p.demo || (!p.demo && demo === undefined);
          });
        });
        const byName = await argoReader.watchApplicationSet(argoNamespace, apps, (rows) => syncedAt(apps)(rows) && renders(rows), { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${tc.guid}` });
        if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${tc.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
        if (!renders(byName)) throw errValidation(`not every member renders tenant.demo=${p.demo}: ${p.members.join(", ")}`);
        ctx.log("meta", `tenant ${tc.guid}: demo ${p.demo} rendered and Synced + Healthy for ${p.members.join(", ")}`);
      },
    },
  ];
}

export function makeTenantSetDemoDef(ports: TenantOnboardPorts): RunDefinition<TenantSetDemoParams> {
  return {
    kind: "tenant-set-demo", paramsSchema: TenantSetDemoParams, mutating: true,
    plan: () => { throw errInternal("tenant-set-demo is planned via planStream"); },
    planStream: async (raw, ctx) => {
      const request = TenantSetDemoRequest.parse(raw);
      const tc = loadTenantCluster(ctx.db, request.tenantId);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} has no registration at ${tc.stage}`);
      const params = { ...request, previous: current.entry.demo ?? false, guid: tc.guid, clusterId: tc.clusterId, members: current.entry.members.map((m) => m.name) };
      await currentDemo(ports, params, ctx);
      const steps = demoSteps(ports, params);
      return { outcome: "planned", params, plan: {
        kind: "tenant-set-demo", targetKind: "tenant", targetId: request.tenantId,
        summary: `Set demo mode ${request.demo ? "on" : "off"} for tenant ${tc.subdomain}: ${params.members.join(", ")}. The product's demo login and data-reset behavior follow this setting.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })), targets: [], locks: tenantLocks(ports.registrations), warnings: [], requiredSecrets: [],
      } };
    },
    steps: (params) => demoSteps(ports, params), cleanups: (params) => [restoreDemo(ports, params)],
  };
}
