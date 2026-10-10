import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { tenantDisplayName } from "../../../shared/tenant.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { memberApplication, rendersTenantValue } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

// `tenant-set-display-name` — set, change or clear the name a tenant is shown under. A member without
// its own sender domain names the tenant in the From of its mail: `<name> <no-reply@<platform domain>>`.
//
// THE CONTRACT WITH THE PRODUCT. The tenants ApplicationSet hands every member tenant.displayName, and
// the product's charts put it before the platform's sender address where the tenant has no sender
// domain of its own. digita-post parses that `Name <address>` form, which is why the name is held to
// what it can parse (tenantDisplayName).
//
// WHAT THE RUN WAITS FOR: every member Application Synced + Healthy on a comparison that renders the
// new name, so a green run is the name in use and not a commit nobody has rendered yet.

export const TenantSetDisplayNameParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  /** The name to show the tenant under, or "" for none. */
  displayName: tenantDisplayName,
  /** The name standing when this was asked for. An abort writes it back. */
  previous: z.string(),
});
export type TenantSetDisplayNameParams = z.infer<typeof TenantSetDisplayNameParams>;

export type TenantSetDisplayNamePorts = TenantOnboardPorts;

const named = (name: string): string => (name ? `"${name}"` : "no name");

async function writeDisplayName(ports: TenantSetDisplayNamePorts, tc: TenantCluster, db: Parameters<Step["run"]>[0]["db"], name: string, runId: string): Promise<string> {
  const { commit } = await ports.registrations.setDisplayName(tc.stage, tc.guid, name, runId);
  db.update(tenants).set({ displayName: name, lastRunId: runId }).where(eq(tenants.id, tc.tenantId)).run();
  return commit;
}

/** On abort: write the previous name back, while the tenant's registration still carries this run's. The
 *  registration decides, being what the members render (restoreSenderDomainCleanup says why). */
function restoreDisplayNameCleanup(ports: TenantSetDisplayNamePorts, p: TenantSetDisplayNameParams): Cleanup {
  return {
    name: "restore-display-name",
    title: `Show the tenant under ${named(p.previous)} again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      if ((await ports.registrations.readTenant(tc.stage, tc.guid))?.entry.displayName !== p.displayName) {
        ctx.log("meta", `tenant ${tc.guid}'s registration does not carry this run's name ${named(p.displayName)} — left as it is`);
        return;
      }
      const commit = await writeDisplayName(ports, tc, ctx.db, p.previous, ctx.runId);
      ctx.log("meta", `tenant ${tc.guid} is shown under ${named(p.previous)} again (${commit})`);
    },
  };
}

function tenantSetDisplayNameSteps(ports: TenantSetDisplayNamePorts, p: TenantSetDisplayNameParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-display-name",
      title: `Record ${named(p.displayName)} as the tenant's display name`,
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        // The plan's fact, asked again: another run may have changed it since. A resume finds its own
        // write already standing.
        if (tc.displayName !== p.previous && tc.displayName !== p.displayName) {
          throw errValidation(`tenant ${tc.subdomain} is named ${named(tc.displayName)} now, not ${named(p.previous)} as when this run was planned — plan it again`);
        }
        ctx.registerCleanup(restoreDisplayNameCleanup(ports, p));
        const commit = await writeDisplayName(ports, tc, ctx.db, p.displayName, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid}: display name ${named(p.previous)} → ${named(p.displayName)} (${commit})`);
      },
    },
    {
      name: "watch-members",
      title: "Wait until every member is Synced + Healthy rendering the new name",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apps = tc.members.map((m) => memberApplication(tc.guid, m, tc.stage));
        const renders = (byName: ArgoAppStatusMap): boolean => apps.every((a) => rendersTenantValue(byName.get(a), ports.deployRepoUrl, "displayName", p.displayName));
        const until = (byName: ArgoAppStatusMap): boolean => syncedAt(apps)(byName) && renders(byName);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, apps, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${tc.guid}` });
        if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${tc.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
        if (!renders(byName)) throw errValidation(`tenant ${tc.guid}'s members are Synced + Healthy, and ArgoCD has not rendered tenant.displayName ${named(p.displayName)} yet — retry this step once the ApplicationSet has regenerated them`);
        ctx.log("meta", `tenant ${tc.guid}: every member renders ${named(p.displayName)}`);
      },
    },
  ];
}

export function makeTenantSetDisplayNameDef(ports: TenantSetDisplayNamePorts): RunDefinition<TenantSetDisplayNameParams> {
  return {
    kind: "tenant-set-display-name",
    paramsSchema: TenantSetDisplayNameParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const row = db.select({ status: tenants.status, suspended: tenants.suspended }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run first`);
      if (row && (TENANT_SETTLED_STATUS as readonly string[]).includes(row.status)) throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing runs to show a name for`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its members render no workloads, so the wait could never end; resume it first`);
      if (tc.displayName !== params.previous) throw errValidation(`tenant ${tc.subdomain} is named ${named(tc.displayName)}, not ${named(params.previous)} as this request says — ask again`);
      const steps = tenantSetDisplayNameSteps(ports, params);
      return {
        kind: "tenant-set-display-name",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `Show tenant ${tc.guid} (${tc.domain}, ${tc.stage}) under ${named(params.displayName)}` +
          `${params.previous === params.displayName ? " (unchanged, re-applied)" : `, instead of ${named(params.previous)}`}` +
          ": record it on the registration and the row, then wait until every member is Synced + Healthy rendering it." +
          `${tc.senderDomain ? ` The tenant sends as ${tc.senderDomain}, its own domain, so its mail keeps the bare address.` : ` Its mail is then sent as ${params.displayName ? `${params.displayName} <no-reply@…>` : "the bare no-reply address"} of the platform domain.`}`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetDisplayNameSteps(ports, params),
    cleanups: (params) => [restoreDisplayNameCleanup(ports, params)],
  };
}
