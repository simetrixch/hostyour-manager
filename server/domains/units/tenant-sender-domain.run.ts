import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import type { PublicProbe } from "#unit/server/adapters/http-probe/port.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { stageApex } from "#unit/shared/unit-host.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { memberApplication, rendersTenantValue } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { readTenantSpec } from "./tenant-apps-repo.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { UnitCall } from "#unit/server/adapters/unit-call/port.ts";
import { changeStageIssuer, refuseWithoutKey, stageServiceIssuer, type SenderDomainIssuers } from "./tenant-sender-domain-issuer.ts";

// `tenant-set-sender-domain` — set, switch or clear the domain a tenant's mail is sent as.
// A customer sends from its own domain (the company tenant from simetrix.ch) instead of
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
//
// THE ISSUER. Where the product declares senderDomainIssuers, its mail service lets the stage's service
// issuer send from the new domain before any member sends as it, and stops letting it send from the
// previous one once every member has switched (tenant-sender-domain-issuer.ts); that removal is the
// run's last step, so nothing after it can fail and ask for it back. Both steps stand in
// every plan and do nothing where there is nothing to bind, so the plan's step list never depends on
// the product's manifest.

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
  /** Calls the product's issuer route as the Manager, with the key it keeps for the unit's stage. */
  unitCall: UnitCall;
  /** Where the plan looks for that key; a step opens it through its own context. */
  store: Pick<CredentialStore, "list">;
};

/** The tenant's public apex, off its cluster's values chain. */
async function tenantUnitApex(ports: TenantSetSenderDomainPorts, tc: TenantCluster): Promise<string> {
  return unitApexFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage));
}

/** Adds or removes the stage's issuer at `domain` through the product's route; null where the product
 *  declares none. */
async function changeIssuerAt(
  ports: TenantSetSenderDomainPorts,
  ctx: Parameters<Step["run"]>[0],
  p: TenantSetSenderDomainParams,
  domain: string,
  change: "add" | "remove",
): Promise<{ changed: boolean; issuer: string; route: SenderDomainIssuers; stage: string } | null> {
  const route = (await readTenantSpec(ports, {}))?.senderDomainIssuers;
  if (!route) return null;
  const tc = loadTenantCluster(ctx.db, p.tenantId);
  const unitApex = await tenantUnitApex(ports, tc);
  const issuer = stageServiceIssuer(tc, unitApex);
  const changed = await changeStageIssuer({ store: ctx.creds, unitCall: ports.unitCall }, { route, stage: tc.stage, unitApex, domain, issuer, change, runId: ctx.runId, signal: ctx.signal });
  return { changed, issuer, route, stage: tc.stage };
}

/** On abort: take back the issuer this run's bind-issuer added. Registered only where it added one. */
function unbindIssuerCleanup(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Cleanup {
  return {
    name: "unbind-issuer",
    title: `Stop the service issuer sending from ${p.senderDomain}`,
    run: async (ctx) => {
      const done = await changeIssuerAt(ports, ctx, p, p.senderDomain, "remove");
      if (!done) throw errValidation(`the product no longer declares senderDomainIssuers, so the issuer this run bound at ${p.senderDomain} stays — remove it in the product's mail service`);
      ctx.log("meta", `${done.route.unit} (${done.stage}) no longer lets ${done.issuer} send from ${p.senderDomain}`);
    },
  };
}

async function writeSenderDomain(ports: TenantSetSenderDomainPorts, tc: TenantCluster, db: Parameters<Step["run"]>[0]["db"], domain: string, runId: string): Promise<string> {
  const { commit } = await ports.registrations.setSenderDomain(tc.stage, tc.guid, domain, runId);
  db.update(tenants).set({ senderDomain: domain, lastRunId: runId, updatedAt: new Date() }).where(eq(tenants.id, tc.tenantId)).run();
  return commit;
}

/** On abort: write the previous sender domain back, while the tenant's registration still carries this
 *  run's. The registration decides, being what the members render: the row is written second, so a run
 *  that died between the two leaves the row on the previous domain while the members send from the new. */
function restoreSenderDomainCleanup(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Cleanup {
  return {
    name: "restore-sender-domain",
    title: `Send as ${p.previous || "the platform's own domain"} again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      if ((await ports.registrations.readTenant(tc.stage, tc.guid))?.entry.senderDomain !== p.senderDomain) {
        ctx.log("meta", `tenant ${tc.guid}'s registration does not carry this run's ${p.senderDomain || "platform domain"} — left as it is`);
        return;
      }
      const commit = await writeSenderDomain(ports, tc, ctx.db, p.previous, ctx.runId);
      ctx.log("meta", `tenant ${tc.guid} sends as ${p.previous || "the platform's own domain"} again (${commit})`);
    },
  };
}

/** Why the product's check refuses `domain`, or null where mail from it is signed. */
async function refuseUnsigned(ports: TenantSetSenderDomainPorts, tc: TenantCluster, template: string | undefined, domain: string): Promise<string | null> {
  if (!template) return "the product declares no senderDomainCheck in its tenant spec, so no tenant of it sends from a domain of its own";
  const apex = stageApex(await tenantUnitApex(ports, tc), tc.stage);
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
      name: "bind-issuer",
      title: `Let the stage's service issuer send from ${p.senderDomain || "the platform's own domain"}`,
      run: async (ctx) => {
        if (p.senderDomain === "") {
          ctx.log("meta", "the platform's own domain admits a tenant's identity provider by its DNS mark — nothing to bind");
          return;
        }
        const done = await changeIssuerAt(ports, ctx, p, p.senderDomain, "add");
        if (!done) {
          ctx.log("meta", `the product declares no senderDomainIssuers — the stage's issuer is bound at ${p.senderDomain} in its mail service by hand`);
          return;
        }
        if (done.changed) ctx.registerCleanup(unbindIssuerCleanup(ports, p));
        ctx.log("meta", done.changed
          ? `${done.route.unit} (${done.stage}) lets ${done.issuer} send from ${p.senderDomain}`
          : `${done.route.unit} (${done.stage}) already let ${done.issuer} send from ${p.senderDomain} — left as it stood, and an abort leaves it`);
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
        const renders = (byName: ArgoAppStatusMap): boolean => apps.every((a) => rendersTenantValue(byName.get(a), ports.deployRepoUrl, "senderDomain", p.senderDomain));
        const until = (byName: ArgoAppStatusMap): boolean => syncedAt(apps)(byName) && renders(byName);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, apps, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${tc.guid}` });
        if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${tc.guid} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
        if (!renders(byName)) throw errValidation(`tenant ${tc.guid}'s members are Synced + Healthy, and ArgoCD has not rendered tenant.senderDomain ${p.senderDomain || "(empty)"} yet — retry this step once the ApplicationSet has regenerated them`);
        ctx.log("meta", `tenant ${tc.guid}: every member sends as ${p.senderDomain || "the platform's own domain"}`);
      },
    },
    {
      name: "unbind-previous-issuer",
      title: `Stop the stage's service issuer sending from ${p.previous && p.previous !== p.senderDomain ? p.previous : "a former sender domain"}`,
      run: async (ctx) => {
        if (p.previous === "" || p.previous === p.senderDomain) {
          ctx.log("meta", "no former sender domain of its own — nothing to take back");
          return;
        }
        const done = await changeIssuerAt(ports, ctx, p, p.previous, "remove");
        if (!done) {
          ctx.log("meta", `the product declares no senderDomainIssuers — the stage's issuer stays bound at ${p.previous} until it is removed in its mail service`);
          return;
        }
        ctx.log("meta", done.changed
          ? `${done.route.unit} (${done.stage}) no longer lets ${done.issuer} send from ${p.previous}`
          : `${done.route.unit} (${done.stage}) did not let ${done.issuer} send from ${p.previous} — nothing to take back`);
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
      const spec = await readTenantSpec(ports, {});
      if (params.senderDomain !== "") {
        const { pointers } = await ports.registrations.listTenantPointers(tc.stage);
        const other = pointers.find((p) => p.guid !== tc.guid && p.senderDomain === params.senderDomain);
        if (other) {
          throw errValidation(`tenant ${tc.subdomain} cannot send as ${params.senderDomain} — tenant ${other.subdomain} of ${tc.stage} already sends from it; a stage's tenants send from different domains`);
        }
        const refused = await refuseUnsigned(ports, tc, spec?.senderDomainCheck, params.senderDomain);
        if (refused) throw errValidation(`tenant ${tc.subdomain} cannot send as ${params.senderDomain} — ${refused}`);
      }
      const route = spec?.senderDomainIssuers;
      const unbinds = params.previous !== "" && params.previous !== params.senderDomain;
      let issuerNote = "";
      if (route && (params.senderDomain !== "" || unbinds)) {
        const refused = await refuseWithoutKey(ports.store, route, tc.stage);
        if (refused) throw errValidation(`tenant ${tc.subdomain} cannot change its sender domain — ${refused}`);
        const issuer = stageServiceIssuer(tc, await tenantUnitApex(ports, tc));
        issuerNote =
          (params.senderDomain !== "" ? ` ${route.unit} first lets the stage's service issuer ${issuer} send from ${params.senderDomain}.` : "") +
          (unbinds ? ` Once every member renders the change, ${route.unit} stops letting ${issuer} send from ${params.previous}.` : "");
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
          `${params.senderDomain ? ` The product's check answered that mail from ${params.senderDomain} is signed. The domain's SPF record must allow the platform's mail server, which is the domain owner's to set.` : ""}` +
          issuerNote,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetSenderDomainSteps(ports, params),
    cleanups: (params) => [restoreSenderDomainCleanup(ports, params), unbindIssuerCleanup(ports, params)],
  };
}
