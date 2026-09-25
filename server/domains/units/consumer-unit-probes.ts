// The consumer family's probes for the scheduled unit check (plugins/unit/server/check-units.ts).
// Per consumer: identity, hooks, DNS — the three whose inputs the row carries. Not the packages: that
// probe clones the repository at a commit, and a clone per unit per tick is a cost the onboarding
// pays once, not a schedule every hour.
import { eq } from "drizzle-orm";
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import { apps, clusters } from "../../db/schema/inventory.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { probeIdentity, probeWebhook } from "#unit/server/build-probes.ts";
import { probeDns } from "./onboard-deploy-probes.ts";
import { resolveRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { failedProbe, unitProbeCtx, type UnitProbes } from "#unit/server/check-units.ts";

export interface ConsumerUnitProbesPorts {
  /** The consumer onboarding's ports, handed late (the consumer family is wired after the tenant's).
   *  Absent where the consumer onboarding is not wired: every row then says it was not measured. */
  onboard: () => OnboardPorts | undefined;
  /** The public apex a cluster's units serve under, which the DNS probe composes the host with. */
  resolveUnitApex: (domain: string, stage: Stage) => Promise<string>;
  githubApp?: GitHubApp | undefined;
}

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
      out.push(failedProbe(id, title, err));
    }
  }
  return out;
}

export function consumerUnitProbes(ports: ConsumerUnitProbesPorts): UnitProbes {
  return {
    noun: "consumer",
    probeAll: async (ctx, now) => {
      const done = { probed: 0, attention: 0 };
      const onboard = ports.onboard();
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
          const unitApex = await ports.resolveUnitApex(c.domain, c.stage as Stage);
          // The credential the probes open: the owner's, resolved from the URL now (#226) — a unit
          // whose owner lost its identity is a finding, not a crash of the whole check.
          let repoCredentialId: string;
          try {
            repoCredentialId = await resolveRepoCredentialId({ repoURL: c.repoUrl, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
          } catch (e) {
            findings = [{ id: "identity", title: `The unit ${c.name}`, severity: "hard", status: "fail", detail: e instanceof Error ? e.message : String(e) }];
            ctx.db.update(apps).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(apps.id, c.id)).run();
            done.probed += 1;
            done.attention += 1;
            continue;
          }
          // The slice of the onboarding's params the three probes read, off the row and the cluster.
          const p = { consumerName: c.name, repoURL: c.repoUrl, repoCredentialId, host: c.host, stage: c.stage, unitApex, domain: c.domain, clusterId: c.clusterId } as DeployableOnboardParams;
          findings = await consumerFindings(onboard, p, unitProbeCtx(ctx, c.name));
        }
        ctx.db.update(apps).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(apps.id, c.id)).run();
        done.probed += 1;
        done.attention += findings.filter((f) => f.status !== "pass").length;
      }
      return done;
    },
  };
}
