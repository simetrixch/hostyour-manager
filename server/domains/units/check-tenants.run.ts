// Asking every tenant whether anybody can still administer it.
//
// A tenant whose first-admin invitation was never accepted, or whose only administrator was removed,
// is a tenant nobody can get into. Its pods run, its databases answer, its ingress serves — and no
// human can administer it. Nothing noticed that state; a Kubernetes CronJob starts this run on a
// schedule and it writes what it found onto each tenant's inventory row.
//
// A RUN and not a job that does its own work, unlike the registry reaper beside it. The reaper's
// output is a reaped tag and nobody needs to see the reaping; a tenant check exists to make
// something VISIBLE, so it belongs in the run list where it can be read, compared with the one
// before it, and started by hand without waiting for the schedule.
//
// THE TOKEN COMES OFF THE CLUSTER, NOT OUT OF VAULT. The manager writes a tenant's crypto entry
// write-only and holds no read grant on it — that is a deliberate property, and this must not be the
// thing that breaks it. The bootstrap token is materialized by ExternalSecrets into a Secret in the
// tenant's own auth namespace, and the first-admin invite already reads it from exactly there
// (api.ts, invite-admin). This takes the same route with the same grants.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Stage, TenantAdminState } from "../../../shared/enums.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import type { RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import type { TenantHealthReader } from "../../adapters/tenant-health/port.ts";
import type { ClusterKubeResolver } from "../../adapters/kube/port.ts";
import { BOOTSTRAP_TOKEN_KEY } from "./tenant-admin-invite.ts";
import { TENANT_SECRET } from "./tenant-secrets.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberHost } from "./unit-dns.ts";

/** The header the tenant's auth reads its bootstrap token from — the same one the invite uses. */
const BOOTSTRAP_TOKEN_HEADER = "X-Bootstrap-Token";

/** How long a tenant may have had zero administrators before it is a finding.
 *
 * A tenant onboarded minutes ago has none yet, and that is its normal state while the first-admin
 * invitation is out. Reporting it would make the very first check of every new tenant a false alarm,
 * which is how an alert gets ignored. */
export const ADMIN_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CheckTenantsPorts {
  resolver: ClusterKubeResolver;
  health: TenantHealthReader;
  resolveUnitApex: (domain: string, stage: Stage) => Promise<string>;
}

/** No parameters: the check is over every tenant this manager knows, and a check that could be
 *  pointed at a subset would let a schedule quietly stop covering the rest. */
const paramsSchema = z.object({}).strict();
export type CheckTenantsParams = z.infer<typeof paramsSchema>;

/** One tenant, as the check needs it. */
interface Candidate {
  id: string;
  guid: string;
  subdomain: string;
  stage: Stage;
  domain: string;
  identityProvider: string;
  clusterId: string;
}

/** The tenants worth asking.
 *
 * A suspended tenant renders no ingress and runs no pods, so asking it would produce a transport
 * error every time — an "unreachable" that says nothing about administrators and would bury the
 * findings that matter. Same for one whose create-tenant run never finished: it may have no auth
 * member at all, and certainly no bootstrap Secret. Both are SKIPPED rather than reported, and the
 * run says how many it skipped so the number is never silently smaller than the estimate. */
export function candidatesFrom(rows: readonly (Candidate & { suspended: boolean; status: string })[]): {
  ask: Candidate[];
  skipped: number;
} {
  const ask = rows.filter((r) => !r.suspended && r.status === "active");
  return { ask, skipped: rows.length - ask.length };
}

/** What a reading means, once the grace period is applied.
 *
 * Kept a pure function so the threshold is tested without a cluster, and so the ONE place that turns
 * a count into a verdict is the one place that has to be right. */
export function verdictFor(input: {
  reached: boolean;
  admins?: number;
  createdAt: Date;
  now: Date;
}): TenantAdminState {
  if (!input.reached) return "unreachable";
  if ((input.admins ?? 0) > 0) return "ok";
  // Zero administrators, and young enough that the invitation may still be out.
  return input.now.getTime() - input.createdAt.getTime() < ADMIN_GRACE_MS ? "ok" : "none";
}

function checkStep(ports: CheckTenantsPorts): Step {
  return {
    name: "check-administrators",
    title: "Ask every tenant whether it still has an administrator",
    run: async (ctx: StepCtx) => {
      const rows = ctx.db
        .select({
          id: tenants.id,
          guid: tenants.guid,
          subdomain: tenants.subdomain,
          stage: tenants.stage,
          identityProvider: tenants.identityProvider,
          clusterId: tenants.clusterId,
          suspended: tenants.suspended,
          status: tenants.status,
          createdAt: tenants.createdAt,
          domain: clusters.domain,
        })
        .from(tenants)
        .innerJoin(clusters, eq(tenants.clusterId, clusters.id))
        .all();

      const { ask, skipped } = candidatesFrom(rows);
      if (skipped > 0) {
        ctx.log("meta", `${skipped} tenant(s) skipped — suspended or not finished provisioning; neither can answer, and reporting them would bury the findings that matter`);
      }
      if (ask.length === 0) {
        ctx.log("meta", "no tenant is in a state to be asked");
        ctx.checkpoint({ asked: 0, ok: 0, none: 0, unreachable: 0, skipped });
        return;
      }

      const now = new Date();
      const tally: Record<TenantAdminState, number> = { ok: 0, none: 0, unreachable: 0 };

      for (const t of ask) {
        if (ctx.signal.aborted) break;
        const row = rows.find((r) => r.id === t.id)!;
        let state: TenantAdminState;
        let admins: number | null = null;
        let because = "";

        try {
          // The bootstrap Secret lives in the AUTH member's own namespace — the member that consumes
          // it — and the read uses the per-cluster credential this manager already holds.
          const ns = memberNamespace(t.guid, t.identityProvider);
          const { clusterReader } = await ports.resolver.resolve(t.clusterId);
          const token = await clusterReader.readSecretValue(ns, TENANT_SECRET, BOOTSTRAP_TOKEN_KEY);
          if (!token) {
            state = "unreachable";
            because = `the bootstrap token (Secret ${TENANT_SECRET} key ${BOOTSTRAP_TOKEN_KEY}) is absent in ${ns}`;
          } else {
            // WHERE the tenant's own auth serves: the apex comes off the target cluster's values
            // chain and never off the cluster's own domain — composing from the domain asks a host
            // nothing serves.
            const apex = await ports.resolveUnitApex(t.domain, t.stage);
            const authFqdn = tenantMemberHost(t.identityProvider, t.subdomain, apex);
            const answer = await ports.health.read({
              url: `https://${authFqdn}/api/v1/bootstrap/status`,
              tokenHeader: BOOTSTRAP_TOKEN_HEADER,
              token,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            if (answer.reached) {
              admins = answer.admins;
              state = verdictFor({ reached: true, admins: answer.admins, createdAt: row.createdAt, now });
            } else {
              state = "unreachable";
              because = answer.because;
            }
          }
        } catch (cause) {
          // Resolving a cluster or reading its Secret can fail for reasons that are about the
          // CLUSTER — an unreachable API server, a rotated credential — and none of them is evidence
          // about administrators. One tenant's failure never ends the check for the others.
          state = "unreachable";
          because = cause instanceof Error ? cause.message : String(cause);
        }

        tally[state] += 1;
        ctx.db
          .update(tenants)
          .set({ adminState: state, adminCount: admins, adminCheckedAt: now, updatedAt: now })
          .where(eq(tenants.id, t.id))
          .run();

        ctx.log(
          state === "none" ? "stderr" : "stdout",
          state === "ok"
            ? `${t.subdomain} (${t.guid}): ${admins ?? 0} administrator(s)`
            : state === "none"
              ? `${t.subdomain} (${t.guid}): NO ADMINISTRATOR — nobody can get into this tenant`
              : `${t.subdomain} (${t.guid}): could not be asked — ${because}`,
        );
      }

      ctx.checkpoint({ asked: ask.length, ...tally, skipped });
      ctx.log(
        "meta",
        `${ask.length} asked: ${tally.ok} with an administrator, ${tally.none} WITHOUT one, ${tally.unreachable} unreachable`,
      );
    },
  };
}

export function makeCheckTenantsDef(ports: CheckTenantsPorts): RunDefinition<CheckTenantsParams> {
  return {
    kind: "tenant-check",
    paramsSchema,
    // It changes no cluster: it reads a Secret, makes one GET per tenant, and writes the answer onto
    // the local inventory row. `mutating` is about what a run puts on a MACHINE, and this puts
    // nothing — which is also why it needs no attest-target first step.
    mutating: false,
    plan: async (_params, deps) => {
      const total = deps.db.select({ id: tenants.id }).from(tenants).all().length;
      return {
        kind: "tenant-check",
        targetKind: "self",
        targetId: "manager",
        summary: `Ask each of ${total} tenant(s) whether anybody can still administer it, and record the answer.`,
        steps: [{ name: "check-administrators", title: "Ask every tenant whether it still has an administrator" }],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: () => [checkStep(ports)],
  };
}

/** Exported for the API's read path: the tenants a check found nobody can administer. */
export const NEEDS_AN_ADMIN: readonly TenantAdminState[] = ["none"];

/** Ids of every tenant currently recorded as having no administrator. */
export function tenantsWithoutAdministrator(db: {
  select: (cols: { id: typeof tenants.id }) => {
    from: (t: typeof tenants) => { where: (w: unknown) => { all: () => { id: string }[] } };
  };
}): { id: string }[] {
  return db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), inArray(tenants.adminState, [...NEEDS_AN_ADMIN])))
    .all();
}
