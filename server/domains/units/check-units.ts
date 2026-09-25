// THE SCHEDULED CHECK RUNS EVERY STANDING UNIT'S PROBES (hostyour-manager#210): the same functions
// the onboarding ran before its approve (onboard-probes.ts, tenant-probes.ts), run again on a
// schedule over every active consumer and tenant, their findings recorded on the unit's own row
// (apps.checkJson, tenants.checkJson) and read off it by the unit's page. Drift — a record that
// moved, a token that expired, a hook that was deleted — is a finding here, before the next
// release meets it.
//
// A STEP OF THE tenant-check RUN, beside the administrator check: one schedule, one run in the
// list, one place to read what the platform measured last. It reads only and writes the local
// row; a unit whose probe throws is recorded with that as its finding and the walk goes on.
//
// WHAT IS RUN PER CONSUMER: identity, hooks, DNS — the three whose inputs the row carries. Not the
// packages: that probe clones the repository at a commit, and a clone per unit per tick is a cost
// the onboarding pays once, not a schedule every hour. Per tenant: the wildcard record.
import { and, eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { Stage } from "../../../shared/enums.ts";
import { apps, clusters, tenants } from "../../db/schema/inventory.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import { probeIdentity, probeWebhook, probeDns } from "./onboard-probes.ts";
import { probeTenantDns } from "./tenant-probes.ts";
import { resolveRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";

export interface CheckUnitsPorts {
  /** The consumer onboarding's ports, handed late (the consumer family is wired after the tenant's). */
  onboard?: () => { ports: OnboardPorts } | undefined;
  /** The tenant onboarding's DNS provider and apex resolver, for the tenants' wildcard records. */
  tenant: Pick<TenantOnboardPorts, "dns" | "resolveUnitApex" | "githubApp">;
}

function probeCtx(ctx: StepCtx, prefix: string): ProbeCtx {
  return { db: ctx.db, creds: ctx.creds, params: ctx.params, signal: ctx.signal, log: (l) => ctx.log("meta", `${prefix}: ${l}`) };
}

const failed = (id: string, title: string, err: unknown): PreflightCheck =>
  ({ id, title, severity: "hard", status: "fail", detail: `the probe could not measure: ${err instanceof Error ? err.message : String(err)}` });

/** Every probe of one consumer that the row can feed, its findings collected; a probe that throws
 *  answers one failed finding under its name. */
async function consumerFindings(o: OnboardPorts, p: DeployableOnboardParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  for (const [id, title, probe] of [
    ["identity", `The identity of ${p.repoURL}`, () => probeIdentity(o, p, ctx)],
    ["webhook", `The build webhook of ${p.repoURL}`, () => probeWebhook(o, p, ctx)],
    ["dns.record", `The DNS record of ${p.consumerName}`, () => probeDns(o, p, ctx)],
  ] as const) {
    try {
      out.push(...(await probe()));
    } catch (err) {
      out.push(failed(id, title, err));
    }
  }
  return out;
}

export function checkUnitsStep(ports: CheckUnitsPorts): Step {
  return {
    name: "check-units",
    title: "Run every standing unit's probes and record what they found",
    run: async (ctx) => {
      const now = new Date();
      const tally = { consumers: 0, tenants: 0, attention: 0 };
      const onboard = ports.onboard?.();
      const consumers = ctx.db
        .select({ id: apps.id, name: apps.name, stage: apps.stage, host: apps.host, repoUrl: apps.repoUrl, clusterId: apps.clusterId, domain: clusters.domain })
        .from(apps).innerJoin(clusters, eq(apps.clusterId, clusters.id)).where(eq(apps.status, "active")).all();
      for (const c of consumers) {
        if (ctx.signal.aborted) break;
        let findings: PreflightCheck[];
        if (!onboard) {
          findings = [{ id: "check", title: `The unit ${c.name}`, severity: "soft", status: "warn", detail: "not measured: the consumer onboarding is not wired on this manager" }];
        } else if (!c.repoUrl) {
          findings = [{ id: "check", title: `The unit ${c.name}`, severity: "soft", status: "warn", detail: "not measured: the row records no repository (an adopted unit)" }];
        } else {
          const unitApex = await ports.tenant.resolveUnitApex(c.domain, c.stage as Stage);
          // The credential the probes open: the owner's, resolved from the URL now (#226) — a unit
          // whose owner lost its identity is a finding, not a crash of the whole check.
          let repoCredentialId: string;
          try {
            repoCredentialId = await resolveRepoCredentialId({ repoURL: c.repoUrl, githubApp: ports.tenant.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
          } catch (e) {
            findings = [{ id: "identity", title: `The unit ${c.name}`, severity: "hard", status: "fail", detail: e instanceof Error ? e.message : String(e) }];
            ctx.db.update(apps).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(apps.id, c.id)).run();
            tally.consumers += 1;
            tally.attention += 1;
            continue;
          }
          // The slice of the onboarding's params the three probes read, off the row and the cluster.
          const p = { consumerName: c.name, repoURL: c.repoUrl, repoCredentialId, host: c.host, stage: c.stage, unitApex, domain: c.domain, clusterId: c.clusterId } as DeployableOnboardParams;
          findings = await consumerFindings(onboard.ports, p, probeCtx(ctx, c.name));
        }
        ctx.db.update(apps).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(apps.id, c.id)).run();
        tally.consumers += 1;
        tally.attention += findings.filter((f) => f.status !== "pass").length;
      }
      const rows = ctx.db
        .select({ id: tenants.id, guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage, clusterId: tenants.clusterId, domain: clusters.domain })
        .from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(and(eq(tenants.status, "active"), eq(tenants.suspended, false))).all();
      for (const t of rows) {
        if (ctx.signal.aborted) break;
        let findings: PreflightCheck[];
        try {
          const p = { guid: t.guid, subdomain: t.subdomain, stage: t.stage, clusterId: t.clusterId, domain: t.domain } as CreateTenantParams;
          findings = await probeTenantDns(ports.tenant as TenantOnboardPorts, p, probeCtx(ctx, t.subdomain));
        } catch (err) {
          findings = [failed("dns.record", `The DNS record of ${t.subdomain}`, err)];
        }
        ctx.db.update(tenants).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(tenants.id, t.id)).run();
        tally.tenants += 1;
        tally.attention += findings.filter((f) => f.status !== "pass").length;
      }
      ctx.checkpoint(tally);
      ctx.log("meta", `${tally.consumers} consumer(s) and ${tally.tenants} tenant(s) probed: ${tally.attention} finding(s) worth a look, recorded on their rows`);
    },
  };
}
