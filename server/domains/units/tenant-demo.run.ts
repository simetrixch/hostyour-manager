import { z } from "zod";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import type { Cleanup, RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { errInternal, errNotFound, errValidation } from "../../kernel/errors.ts";
import { guid, memberName } from "../../../shared/tenant.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { attestTenantTargetStep, loadTenantCluster, refreshTenantApplications } from "./lifecycle.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { readStandingTenant } from "./tenant-standing.ts";
import { mintSecretValue } from "#unit/server/secret-mint.ts";
import { tenantE2ePasswordPath } from "#unit/server/adapters/vault/seeder-port.ts";

export const TenantSetDemoRequest = z.object({ tenantId: z.string().startsWith("tnt_"), demo: z.boolean() });
export const TenantSetDemoParams = TenantSetDemoRequest.extend({
  previous: z.boolean(), guid, clusterId: z.string().startsWith("cls_"), members: z.array(memberName).min(1),
});
export type TenantSetDemoParams = z.infer<typeof TenantSetDemoParams>;

const currentDemo = (ports: TenantOnboardPorts, p: TenantSetDemoParams, ctx: Pick<StepCtx, "db">) => readStandingTenant(ports, p, ctx, "demo mode");

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

function seederOf(ports: TenantOnboardPorts): NonNullable<TenantOnboardPorts["seeder"]> {
  if (!ports.seeder) throw errValidation("no Vault seeder is wired — a demo tenant's end-to-end password cannot be written or removed");
  return ports.seeder;
}

/** Remove the end-to-end password once the tenant is no demo, so nothing signs in to a tenant that is
 *  no demo with it. While the registration still says demo, it stays. */
async function dropE2ePasswordUnlessDemo(ports: TenantOnboardPorts, p: TenantSetDemoParams, ctx: StepCtx): Promise<void> {
  const { tc, entry } = await currentDemo(ports, p, ctx);
  const path = tenantE2ePasswordPath(tc.stage, tc.guid);
  if (entry.demo ?? false) {
    ctx.log("meta", `tenant ${tc.guid} is a demo — its end-to-end password at ${path} stays`);
    return;
  }
  await seederOf(ports).deleteTenantE2ePassword({ stage: tc.stage, guid: tc.guid });
  ctx.log("meta", `end-to-end password ${path} destroyed (all versions), or none stood`);
}

function undoE2ePassword(ports: TenantOnboardPorts, p: TenantSetDemoParams): Cleanup {
  return {
    name: "undo-e2e-password", title: "Remove the end-to-end password unless the tenant is a demo",
    run: (ctx) => dropE2ePasswordUnlessDemo(ports, p, ctx),
  };
}

/** A demo tenant's end-to-end password: minted BEFORE the registration says demo, because the auth
 *  of a demo reads it through an ExternalSecret that fails its sync while the entry is missing. A
 *  run that is undone takes it back once restore-demo left the tenant no demo. */
function mintE2ePasswordStep(ports: TenantOnboardPorts, p: TenantSetDemoParams): Step {
  return {
    name: "mint-e2e-password", title: "Mint the end-to-end tests' password into Vault",
    run: async (ctx) => {
      const { tc } = await currentDemo(ports, p, ctx);
      ctx.registerCleanup(undoE2ePassword(ports, p));
      await seederOf(ports).replaceTenantE2ePassword({ stage: tc.stage, guid: tc.guid, password: mintSecretValue("hex32") });
      ctx.log("meta", `end-to-end password of tenant ${tc.guid} written to ${tenantE2ePasswordPath(tc.stage, tc.guid)}; its auth starts with it once it renders demo`);
    },
  };
}

function demoSteps(ports: TenantOnboardPorts, p: TenantSetDemoParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    ...(p.demo ? [mintE2ePasswordStep(ports, p)] : []),
    {
      name: "write-demo", title: `Set demo mode ${p.demo ? "on" : "off"} for every member`,
      run: async (ctx) => {
        const { tc, entry } = await currentDemo(ports, p, ctx);
        const owner = ctx.db.select({ lastRunId: tenants.lastRunId }).from(tenants).where(eq(tenants.id, p.tenantId)).get();
        // Only the demo flag decides: every run on the tenant, a Versions run among them, moves lastRunId.
        if (owner?.lastRunId !== ctx.runId && (entry.demo ?? false) !== p.previous) {
          throw errValidation("demo mode changed since this switch was planned — plan it again");
        }
        ctx.registerCleanup(restoreDemo(ports, p));
        // Persist ownership before git commits, so a crash after that commit can retry or undo it.
        ctx.db.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        const { commit } = await ports.registrations.setDemo(tc.stage, tc.guid, p.demo, ctx.runId);
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
    // Only once no member renders demo any more, so no auth still reads the entry through its ExternalSecret.
    ...(p.demo ? [] : [{ name: "drop-e2e-password", title: "Remove the end-to-end tests' password from Vault", run: (ctx: StepCtx) => dropE2ePasswordUnlessDemo(ports, p, ctx) }]),
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
      const previous = current.entry.demo ?? false;
      // A switch on for a demo would mint a value its auth never takes, since nothing in its rendering
      // changes and the auth reads the value only when it starts.
      if (request.demo === previous) throw errValidation(`tenant ${tc.subdomain} is ${previous ? "already a demo" : "no demo"} — there is nothing to switch`);
      const params = { ...request, previous, guid: tc.guid, clusterId: tc.clusterId, members: current.entry.members.map((m) => m.name) };
      await currentDemo(ports, params, ctx);
      const steps = demoSteps(ports, params);
      return { outcome: "planned", params, plan: {
        kind: "tenant-set-demo", targetKind: "tenant", targetId: request.tenantId,
        summary: `Set demo mode ${request.demo ? "on" : "off"} for tenant ${tc.subdomain}: ${params.members.join(", ")}. The product's demo login and data-reset behavior follow this setting.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })), targets: [], locks: tenantLocks(ports.registrations), warnings: [], requiredSecrets: [],
      } };
    },
    steps: (params) => demoSteps(ports, params), cleanups: (params) => [restoreDemo(ports, params), undoE2ePassword(ports, params)],
  };
}
