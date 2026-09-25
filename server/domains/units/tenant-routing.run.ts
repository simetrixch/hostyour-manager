import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { MEMBER_ROUTING, type MemberRouting } from "../../../shared/enums.ts";
import type { PublicProbe } from "../../adapters/http-probe/port.ts";
import { errValidation } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { provisionUnitDns, removeUnitDns, tenantMemberUrl, tenantRecordName } from "./unit-dns.ts";
import { sleep } from "./onboard-release-cycle.ts";

// `tenant-set-routing` — move a STANDING tenant onto another member routing (MEMBER_ROUTING).
//
// WHY IT EXISTS. A tenant records the routing its product declared when it was created, and its DNS
// record and every member address the Manager composes follow that record. A product that moves its
// tenants from a host per member to paths of one host changes its charts; this run is the platform's
// half for a tenant that already stands: the record the new routing names, the recorded routing, and
// the record the old routing named gone — in that order, so no moment exists in which the tenant's
// address has no record.
//
// THE WAIT BEFORE THE REMOVAL. The recorded routing is the Manager's own fact; what serves the tenant
// at the new address is its product's charts, which reach the cluster on their own schedule. So the
// run waits until the tenant's IdP answers at the address the new routing gives it with a 2xx, and
// only then takes the old record away: removed earlier, it would leave the tenant with neither. A
// redirect does not count: where nothing routes the IdP's path, another member serving the zone's
// root (a website) answers it with a redirect of its own. The wait and the removal are ONE step, so
// skipping a failed wait removes nothing.
//
// AN ABORT PUTS THE TENANT BACK where the plan found it: the routing it stood on (`previous`, frozen
// into the params when the move was asked for) and no record of the requested routing. It is refused
// once the record of the previous routing is gone: the tenant then stands on the new record alone, and
// taking that away would leave it with none.
//
// ASKING FOR THE ROUTING A TENANT HAS is the re-apply, not a no-op: the record is provisioned again
// (a no-op where it stands), the write commits nothing, the wait confirms the address answers, and a
// record of another routing that was left behind is removed.

export const TenantSetRoutingParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  routing: z.enum(MEMBER_ROUTING),
  /** The routing the tenant stood on when the move was asked for. The plan refuses a tenant that has
   *  moved since, and an abort records it again. */
  previous: z.enum(MEMBER_ROUTING),
});
export type TenantSetRoutingParams = z.infer<typeof TenantSetRoutingParams>;

export type TenantSetRoutingPorts = TenantLifecyclePorts & {
  /** Reads the tenant's IdP from the outside — the probe verify-quiesced reads a quiesced unit with. */
  probe: PublicProbe;
  /** How long the wait asks before it fails the run, and how long it pauses between two asks. */
  routingWaitMs: number;
  routingPollMs: number;
};

/** The routings other than `routing` — whose records a tenant on `routing` no longer needs. */
function otherRoutings(routing: MemberRouting): MemberRouting[] {
  return MEMBER_ROUTING.filter((r) => r !== routing);
}

/** On abort: put the previous routing back on the registration and the row. Both writes are no-ops
 *  where they already hold it, so a crash between the two is repaired as well. */
function restoreRoutingCleanup(ports: TenantSetRoutingPorts, tenantId: string, previous: MemberRouting): Cleanup {
  return {
    name: "restore-routing",
    title: `Record the previous routing (${previous}) again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, tenantId);
      const { commit } = await ports.registrations.setRouting(tc.stage, tc.guid, previous, ctx.runId);
      ctx.db.update(tenants).set({ routing: previous, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
      ctx.log("meta", `tenant ${tc.guid} routing back to ${previous} (${commit})`);
    },
  };
}

/** On abort: remove the record the requested routing names — unless the tenant's recorded routing is
 *  that routing after all, in which case it is the tenant's own record and stays. Runs after
 *  restore-routing (cleanups run in reverse order), so it reads the restored routing. */
function removeUnneededRecordCleanup(ports: TenantSetRoutingPorts, p: TenantSetRoutingParams): Cleanup {
  return {
    name: "remove-unneeded-record",
    title: `Remove the DNS record the ${p.routing} routing names, where the tenant does not use it`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      if (tc.routing === p.routing) return;
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      await removeUnitDns(ctx, { dns: ports.dns, unit: tc.guid, recordName: tenantRecordName(p.routing, tc.subdomain, tc.stage, apex) });
    },
  };
}

function tenantSetRoutingSteps(ports: TenantSetRoutingPorts, p: TenantSetRoutingParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "provision-record",
      title: "Provision the DNS record the new routing names",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        ctx.registerCleanup(removeUnneededRecordCleanup(ports, p));
        await provisionUnitDns(ctx, {
          dns: ports.dns, unit: tc.guid, kind: "tenant", stage: tc.stage,
          recordName: tenantRecordName(p.routing, tc.subdomain, tc.stage, apex), clusterFqdn: tc.domain, runKind: "tenant-set-routing",
        });
      },
    },
    {
      name: "write-routing",
      title: "Record the new routing on the tenant's registration and row",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        ctx.registerCleanup(restoreRoutingCleanup(ports, p.tenantId, p.previous));
        const { commit } = await ports.registrations.setRouting(tc.stage, tc.guid, p.routing, ctx.runId);
        ctx.db.update(tenants).set({ routing: p.routing, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid} routing ${p.previous} → ${p.routing} (${commit}) — its charts serve the new addresses once the ArgoCD on ${tc.domain} syncs a product that routes by ${p.routing}`);
      },
    },
    {
      name: "retire-previous-record",
      title: "Wait until the tenant's identity provider answers at its new address, then remove the other routing's record",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        const url = `${tenantMemberUrl(p.routing, tc.identityProvider, tc.stage, tc.subdomain, apex, tc.ownDomain)}/`;
        const deadline = Date.now() + ports.routingWaitMs;
        for (;;) {
          const seen = await ports.probe.probe(url, { signal: ctx.signal });
          if (seen.status !== null && seen.status >= 200 && seen.status < 300) {
            ctx.log("meta", `${url} answers (${seen.detail}) — the tenant is served at the ${p.routing} routing`);
            break;
          }
          if (ctx.signal.aborted) throw errValidation(`the wait for ${url} was cancelled`);
          if (Date.now() >= deadline) {
            throw errValidation(
              `${url} did not answer within ${Math.round(ports.routingWaitMs / 60_000)} minutes (last: ${seen.detail}) — ` +
              `the product's charts do not serve the ${p.routing} routing on ${tc.domain} yet. The record of the previous routing still stands: ` +
              `retry this step once the charts are synced, or abort the run to record the previous routing again.`,
            );
          }
          ctx.log("meta", `${url} does not answer yet (${seen.detail}); asking again in ${Math.round(ports.routingPollMs / 1000)}s`);
          await sleep(ports.routingPollMs, ctx.signal);
        }
        // Every other routing's record, whatever the tenant stood on before: a record of a routing the
        // tenant does not use is a leftover, and removing an absent record is a no-op.
        for (const other of otherRoutings(p.routing)) {
          await removeUnitDns(ctx, { dns: ports.dns, unit: tc.guid, recordName: tenantRecordName(other, tc.subdomain, tc.stage, apex) });
        }
      },
    },
  ];
}

export function makeTenantSetRoutingDef(ports: TenantSetRoutingPorts): RunDefinition<TenantSetRoutingParams> {
  return {
    kind: "tenant-set-routing",
    paramsSchema: TenantSetRoutingParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const row = db.select({ suspended: tenants.suspended, status: tenants.status }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run before moving its routing`);
      if (row?.status === "offboarded" || row?.status === "purged") throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing serves it, so there is no routing to move`);
      if (tc.ownDomain !== "" && params.routing !== "path") throw errValidation(`tenant ${tc.subdomain} is reached at its own domain ${tc.ownDomain}, which serves every member under a path — clear the domain before moving it off path routing`);
      if (tc.routing !== params.previous) throw errValidation(`tenant ${tc.subdomain} stands on the ${tc.routing} routing, not on ${params.previous} as this request says — it moved since; ask again`);
      // A suspended tenant renders no ingress, so the wait could never be answered.
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its ingress is down, so its new address could never answer; resume it before moving its routing`);
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const record = tenantRecordName(params.routing, tc.subdomain, tc.stage, apex);
      const url = tenantMemberUrl(params.routing, tc.identityProvider, tc.stage, tc.subdomain, apex, tc.ownDomain);
      const old = otherRoutings(params.routing).map((r) => tenantRecordName(r, tc.subdomain, tc.stage, apex)).join(", ");
      const stepDefs = tenantSetRoutingSteps(ports, params);
      return {
        kind: "tenant-set-routing",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `${tc.routing === params.routing ? "Re-apply" : `Move tenant ${tc.guid} from ${tc.routing} to`} the ${params.routing} routing on ${tc.domain} (${tc.stage}): ` +
          `provision the DNS record ${record}, record the routing on the registration and the row, wait until ${url}/ answers, ` +
          `then remove ${old}. The tenant's charts must serve the ${params.routing} routing for the wait to end — the old record stands until they do.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetRoutingSteps(ports, params),
    cleanups: (params) => [removeUnneededRecordCleanup(ports, params), restoreRoutingCleanup(ports, params.tenantId, params.previous)],
    // Refused once the previous routing's record is gone: the tenant then stands on the requested
    // record alone, and the abort would remove it. A re-apply has nothing to guard.
    assertAbortable: async (params, { db }) => {
      if (params.previous === params.routing) return;
      const tc = loadTenantCluster(db, params.tenantId);
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const record = tenantRecordName(params.previous, tc.subdomain, tc.stage, apex);
      if (!ports.dns) throw errValidation(`no DNS provider is configured, so it cannot be read whether ${record} still stands — the abort is refused rather than risk removing the tenant's last record`);
      if ((await ports.dns.readRecordContent({ name: record, type: "CNAME" })) === null) {
        throw errValidation(`${record}, the record of the ${params.previous} routing, is gone — the tenant stands on the ${params.routing} record alone, and an abort would remove it. Retry the run instead.`);
      }
    },
  };
}
