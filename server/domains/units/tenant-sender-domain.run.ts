import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import type { PublicProbe } from "#unit/server/adapters/http-probe/port.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { stageApex } from "#unit/shared/unit-host.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { readTenantSpec } from "./tenant-apps-repo.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

// `tenant-set-sender-domain` — set, switch or clear the domain a tenant's mail is sent as
// (hostyour-manager#290). A customer sends from its own domain (simetrix from simetrix.ch) instead of
// the platform's.
//
// THE CONTRACT WITH THE PRODUCT. The tenants ApplicationSet hands every member tenant.senderDomain, and
// the product's charts send as no-reply@<senderDomain> where it is set ("" keeps the platform's own).
// Mail from a domain the product's mail service does not sign would leave unsigned, so the product
// declares in its tenant spec where the Manager asks first (senderDomainCheck, a URL template with
// {stageApex} and {domain}); the Manager names no product and reads no secret to ask it.
//
// WHAT THE RUN WAITS FOR: every member Application Synced + Healthy on a comparison that renders the
// new value, so a green run is the domain in use and not a commit nobody has looked at yet.

const senderDomain = z.union([z.literal(""), publicFqdn]);

export const TenantSetSenderDomainParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  /** The domain to send as, or "" to send as the platform's own domain again. */
  senderDomain,
  /** The sender domain standing when this was asked for. An abort writes it back. */
  previous: senderDomain,
});
export type TenantSetSenderDomainParams = z.infer<typeof TenantSetSenderDomainParams>;

export type TenantSetSenderDomainPorts = TenantOnboardPorts & {
  /** Asks the product's sender-domain check from the outside. */
  probe: PublicProbe;
};

/** Whether a member Application's last comparison renders `domain` as tenant.senderDomain. */
function rendersSenderDomain(status: ArgoAppStatus | undefined, deployRepoUrl: string, domain: string): boolean {
  const charts = (status?.syncSources ?? []).filter((src) => src.repoURL === deployRepoUrl && src.path);
  return charts.length > 0 && charts.every((src) => (src.valuesObject?.["tenant"] as { senderDomain?: unknown } | undefined)?.senderDomain === domain);
}

async function writeSenderDomain(ports: TenantSetSenderDomainPorts, tc: TenantCluster, db: Parameters<Step["run"]>[0]["db"], domain: string, runId: string): Promise<string> {
  const { commit } = await ports.registrations.setSenderDomain(tc.stage, tc.guid, domain, runId);
  db.update(tenants).set({ senderDomain: domain, lastRunId: runId, updatedAt: new Date() }).where(eq(tenants.id, tc.tenantId)).run();
  return commit;
}

/** On abort: write the previous sender domain back, while the tenant still carries this run's. */
function restoreSenderDomainCleanup(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Cleanup {
  return {
    name: "restore-sender-domain",
    title: `Send as ${p.previous || "the platform's own domain"} again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      if (tc.senderDomain !== p.senderDomain) {
        ctx.log("meta", `tenant ${tc.guid} no longer sends as this run's ${p.senderDomain || "platform domain"} — another run wrote it since; left as it is`);
        return;
      }
      const commit = await writeSenderDomain(ports, tc, ctx.db, p.previous, ctx.runId);
      ctx.log("meta", `tenant ${tc.guid} sends as ${p.previous || "the platform's own domain"} again (${commit})`);
    },
  };
}

/** Why the product's check refuses `domain`, or null where mail from it is signed. */
async function refuseUnsigned(ports: TenantSetSenderDomainPorts, tc: TenantCluster, domain: string): Promise<string | null> {
  const template = (await readTenantSpec(ports, {}))?.senderDomainCheck;
  if (!template) return "the product declares no senderDomainCheck in its tenant spec, so no tenant of it sends from a domain of its own";
  const apex = stageApex(unitApexFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage)), tc.stage);
  const url = template.replaceAll("{stageApex}", apex).replaceAll("{domain}", encodeURIComponent(domain));
  const answer = await ports.probe.probe(url, { readBody: true });
  if (answer.status === 404) return `the product does not know ${domain} as a sender domain (${url} answered 404) — register it in the product's mail service first`;
  if (answer.status !== 200) return `the product's sender-domain check did not answer (${url}: ${answer.detail}) — nothing says mail from ${domain} is signed`;
  let signing: unknown;
  try {
    signing = (JSON.parse(answer.body ?? "") as { signing?: unknown }).signing;
  } catch {
    return `the product's sender-domain check answered no JSON (${url}) — nothing says mail from ${domain} is signed`;
  }
  return signing === true ? null : `mail from ${domain} is not signed yet (${url} answered signing: ${String(signing)}) — its key is not active in the product's mail service`;
}

function tenantSetSenderDomainSteps(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Step[] {
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
      name: "write-sender-domain",
      title: `Record ${p.senderDomain || "the platform's own domain"} as the tenant's sender domain`,
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        // The plan's fact, asked again: another run may have changed it since. A resume finds its own
        // write already standing.
        if (tc.senderDomain !== p.previous && tc.senderDomain !== p.senderDomain) {
          throw errValidation(`tenant ${tc.subdomain} sends as ${tc.senderDomain || "the platform's own domain"} now, not ${p.previous || "the platform's own domain"} as when this run was planned — plan it again`);
        }
        ctx.registerCleanup(restoreSenderDomainCleanup(ports, p));
        const commit = await writeSenderDomain(ports, tc, ctx.db, p.senderDomain, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid}: sender domain ${p.previous || "platform"} → ${p.senderDomain || "platform"} (${commit})`);
      },
    },
    {
      name: "watch-members",
      title: "Wait until every member is Synced + Healthy sending as the new domain",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apps = tc.members.map((m) => memberApplication(tc.guid, m, tc.stage));
        const renders = (byName: ArgoAppStatusMap): boolean => apps.every((a) => rendersSenderDomain(byName.get(a), ports.deployRepoUrl, p.senderDomain));
        const until = (byName: ArgoAppStatusMap): boolean => syncedAt(apps)(byName) && renders(byName);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, apps, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${tc.guid}` });
        if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${tc.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
        if (!renders(byName)) throw errValidation(`tenant ${tc.guid}'s members are Synced + Healthy, and ArgoCD has not rendered tenant.senderDomain ${p.senderDomain || "(empty)"} yet — retry this step once the ApplicationSet has regenerated them`);
        ctx.log("meta", `tenant ${tc.guid}: every member sends as ${p.senderDomain || "the platform's own domain"}`);
      },
    },
  ];
}

export function makeTenantSetSenderDomainDef(ports: TenantSetSenderDomainPorts): RunDefinition<TenantSetSenderDomainParams> {
  return {
    kind: "tenant-set-sender-domain",
    paramsSchema: TenantSetSenderDomainParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const row = db.select({ status: tenants.status, suspended: tenants.suspended }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run first`);
      if (row && (TENANT_SETTLED_STATUS as readonly string[]).includes(row.status)) throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing runs to send mail for`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its members render no workloads, so the wait could never end; resume it first`);
      if (tc.senderDomain !== params.previous) throw errValidation(`tenant ${tc.subdomain} sends as ${tc.senderDomain || "the platform's own domain"}, not ${params.previous || "the platform's own domain"} as this request says — ask again`);
      if (params.senderDomain !== "") {
        const refused = await refuseUnsigned(ports, tc, params.senderDomain);
        if (refused) throw errValidation(`tenant ${tc.subdomain} cannot send as ${params.senderDomain} — ${refused}`);
      }
      const steps = tenantSetSenderDomainSteps(ports, params);
      return {
        kind: "tenant-set-sender-domain",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `Send the mail of tenant ${tc.guid} (${tc.domain}, ${tc.stage}) as ${params.senderDomain ? `no-reply@${params.senderDomain}` : "the platform's own domain"}` +
          `${params.previous === params.senderDomain ? " (unchanged, re-applied)" : `, instead of ${params.previous || "the platform's own domain"}`}` +
          `: record it on the registration and the row, then wait until every member is Synced + Healthy rendering it.` +
          `${params.senderDomain ? ` The product's check answered that mail from ${params.senderDomain} is signed. The domain's SPF record must allow the platform's mail server, which is the domain owner's to set.` : ""}`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetSenderDomainSteps(ports, params),
    cleanups: (params) => [restoreSenderDomainCleanup(ports, params)],
  };
}
