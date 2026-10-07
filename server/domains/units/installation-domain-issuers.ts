// An installation domain move changes every tenant's service issuer: the issuer is the identity
// provider's address on the tenant's zone, and the zone lies under the installation's apex. A stage
// with a sender domain of its own has its issuer bound in the product's mail service, so the move
// binds the new issuer before the members switch and takes the old one back once every member renders
// the new zone. The old one cannot stay: it names a host on the old domain, and whoever holds that
// domain later could send as the tenant.
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import type { UnitCall } from "#unit/server/adapters/unit-call/port.ts";
import type { ClusterKubeResolver, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import type { TenantSpec } from "../../../shared/consumer.ts";
import type { SenderDomainIssuers } from "./tenant-sender-domain-issuer.ts";
import type { InstallationDomainSnapshot } from "../../../shared/installation-domain.ts";
import { describeUnsynced, syncedAt } from "#unit/server/argo-app-status.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { changeStageIssuer } from "./tenant-sender-domain-issuer.ts";
import { memberApplication, rendersTenantValue } from "./tenant-fanout.ts";

export interface InstallationDomainIssuerPorts {
  readTenantSpec(signal?: AbortSignal): Promise<TenantSpec | null>;
  unitCall: UnitCall;
  resolver: ClusterKubeResolver;
  deployRepoUrl: string;
  argoWatchTimeoutMs: number;
}

type Which = "before" | "after";
type SnapshotTenant = InstallationDomainSnapshot["tenants"][number];
type RebindTenant = SnapshotTenant & { senderDomain: string; zoneBefore: string; zoneAfter: string; clusterId: string; members: string[] };

const FROZEN_BEFORE = "this plan was frozen before issuers were rebound — nothing to rebind";
const NO_ROUTE = "the product declares no senderDomainIssuers, so no issuer is bound at a sender domain — nothing to rebind";

/** The tenant stages whose issuer moves with the installation: those with a sender domain of their own.
 *  Null where the plan was frozen before it recorded what a rebind needs. */
function rebound(snapshot: InstallationDomainSnapshot): RebindTenant[] | null {
  if (snapshot.tenants.some((t) => t.senderDomain === undefined || t.clusterId === undefined || t.members === undefined)) return null;
  return snapshot.tenants.filter((t): t is RebindTenant => t.senderDomain !== "");
}

const issuerOf = (t: SnapshotTenant, which: Which): string => (which === "before" ? t.issuerBefore : t.issuerAfter);

function apexOf(snapshot: InstallationDomainSnapshot, t: RebindTenant, which: Which): string {
  const cluster = snapshot.clusters.find((c) => c.id === t.clusterId);
  if (!cluster) throw errValidation(`tenant ${t.guid}/${t.stage} stands on cluster ${t.clusterId}, which this plan does not cover`);
  return which === "before" ? cluster.apexBefore : cluster.apexAfter;
}

function portsOf(ports: InstallationDomainIssuerPorts | undefined): InstallationDomainIssuerPorts {
  if (!ports) throw errNotConfigured("tenant onboarding is not configured, so the issuers at the tenants' sender domains cannot be rebound");
  return ports;
}

/** The product's route for binding issuers, or undefined where it declares none and nothing is rebound. */
const routeOf = async (ports: InstallationDomainIssuerPorts, ctx: StepCtx): Promise<SenderDomainIssuers | undefined> =>
  (await ports.readTenantSpec(ctx.signal))?.senderDomainIssuers;

/** Adds or removes `issuer`'s issuer of one stage at its sender domain, through the post host of the
 *  apex that serves at that moment (`via`); whether post's list changed. */
async function changeIssuer(ports: InstallationDomainIssuerPorts, ctx: StepCtx, snapshot: InstallationDomainSnapshot, route: SenderDomainIssuers, t: RebindTenant, change: "add" | "remove", issuer: Which, via: Which): Promise<boolean> {
  const unitApex = apexOf(snapshot, t, via);
  const changed = await changeStageIssuer(
    { store: ctx.creds, unitCall: ports.unitCall },
    { route, stage: t.stage, unitApex, domain: t.senderDomain, issuer: issuerOf(t, issuer), change, runId: ctx.runId, signal: ctx.signal },
  ).catch((err: unknown) => {
    // Through the new apex, the call can come before the product's mail service serves there: the move
    // waits on the tenants' members, not on it. The cause then reads as a refused connection.
    if (via === "before" || unitApex === apexOf(snapshot, t, "before")) throw err;
    throw errValidation(`${err instanceof Error ? err.message : String(err)} — right after a move, ${route.unit} may not serve on ${unitApex} yet; retry this step once it does`);
  });
  ctx.log("meta", `${route.unit} (${t.stage}) ${change === "add" ? "lets" : "no longer lets"} ${issuerOf(t, issuer)} send from ${t.senderDomain}${changed ? "" : " — it stood so already"}`);
  return changed;
}

/** A forward move's compensation for one stage: `unbind` takes back the new issuer it bound, through the
 *  old apex, which serves again once the move's restore has run; `rebind` puts back the old issuer it took,
 *  through the new apex, because it runs before that restore. Resolved by name, so the steps and the
 *  definition build the same one. */
function compensation(ports: InstallationDomainIssuerPorts | undefined, snapshot: InstallationDomainSnapshot, t: RebindTenant, kind: "unbind" | "rebind"): Cleanup {
  return {
    name: `installation-issuer-${kind}:${t.guid}:${t.stage}`,
    title: kind === "unbind" ? `Stop ${t.issuerAfter} sending from ${t.senderDomain}` : `Let ${t.issuerBefore} send from ${t.senderDomain} again`,
    run: async (ctx) => {
      const p = portsOf(ports);
      const route = await routeOf(p, ctx);
      // This run changed the list, so a route that vanished since leaves its change standing: say so.
      if (!route) throw errValidation(`the product no longer declares senderDomainIssuers, so the issuer this run changed at ${t.senderDomain} stays — set it in the product's mail service`);
      await (kind === "unbind" ? changeIssuer(p, ctx, snapshot, route, t, "remove", "after", "before") : changeIssuer(p, ctx, snapshot, route, t, "add", "before", "after"));
    },
  };
}

export function createInstallationDomainIssuers(ports: InstallationDomainIssuerPorts | undefined) {
  /** Binds `which` issuer of every rebound stage, through the apex that serves now. A forward move arms
   *  the unbind where it bound; a rollback arms nothing, as its own restore arms nothing either, and
   *  binding the issuer it returns to cannot harm. */
  async function bindIssuers(ctx: StepCtx, snapshot: InstallationDomainSnapshot, which: Which): Promise<void> {
    const stages = rebound(snapshot);
    if (stages === null) return ctx.log("meta", FROZEN_BEFORE);
    if (stages.length === 0) return;
    const p = portsOf(ports);
    const route = await routeOf(p, ctx);
    if (!route) return ctx.log("meta", NO_ROUTE);
    const via: Which = which === "after" ? "before" : "after";
    for (const t of stages) {
      if ((await changeIssuer(p, ctx, snapshot, route, t, "add", which, via)) && which === "after") ctx.registerCleanup(compensation(ports, snapshot, t, "unbind"));
    }
  }

  /** Waits until every member of every rebound stage is Synced + Healthy rendering `which` zone and own
   *  domain, which is when its identity provider signs with that side's issuer. */
  async function watchTenantZones(ctx: StepCtx, snapshot: InstallationDomainSnapshot, which: Which): Promise<void> {
    const stages = rebound(snapshot);
    if (stages === null) return ctx.log("meta", FROZEN_BEFORE);
    if (stages.length === 0) return;
    const p = portsOf(ports);
    if (!(await routeOf(p, ctx))) return ctx.log("meta", NO_ROUTE);
    for (const t of stages) {
      const apps = t.members.map((m) => memberApplication(t.guid, m, t.stage));
      const zone = which === "after" ? t.zoneAfter : t.zoneBefore;
      const ownDomain = which === "after" ? t.ownDomainAfter : t.ownDomainBefore;
      const renders = (byName: ArgoAppStatusMap): boolean =>
        apps.every((a) => rendersTenantValue(byName.get(a), p.deployRepoUrl, "zone", zone) && rendersTenantValue(byName.get(a), p.deployRepoUrl, "ownDomain", ownDomain));
      const { argoReader, argoNamespace } = await p.resolver.resolve(t.clusterId);
      const byName = await argoReader.watchApplicationSet(argoNamespace, apps, (s) => syncedAt(apps)(s) && renders(s), { timeoutMs: p.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: `platform/tenant=${t.guid}` });
      if (!syncedAt(apps)(byName)) throw errValidation(`tenant ${t.guid}/${t.stage} fan-out did not converge — ${describeUnsynced(apps, byName)}`);
      if (!renders(byName)) throw errValidation(`tenant ${t.guid}/${t.stage}'s members are Synced + Healthy, and ArgoCD has not rendered the zone ${zone} yet — retry this step`);
      ctx.log("meta", `tenant ${t.guid}/${t.stage}: every member renders ${zone}`);
    }
  }

  /** Takes `which` issuer from every rebound stage, through the apex that serves now. A forward move arms
   *  the rebind where it took one. */
  async function unbindIssuers(ctx: StepCtx, snapshot: InstallationDomainSnapshot, which: Which): Promise<void> {
    const stages = rebound(snapshot);
    if (stages === null) return ctx.log("meta", FROZEN_BEFORE);
    if (stages.length === 0) return;
    const p = portsOf(ports);
    const route = await routeOf(p, ctx);
    if (!route) return ctx.log("meta", NO_ROUTE);
    const via: Which = which === "before" ? "after" : "before";
    for (const t of stages) {
      if ((await changeIssuer(p, ctx, snapshot, route, t, "remove", which, via)) && which === "before") ctx.registerCleanup(compensation(ports, snapshot, t, "rebind"));
    }
  }

  /** Every compensation a forward move can arm, by name. */
  function issuerCleanups(snapshot: InstallationDomainSnapshot): Cleanup[] {
    return (rebound(snapshot) ?? []).flatMap((t) => [compensation(ports, snapshot, t, "unbind"), compensation(ports, snapshot, t, "rebind")]);
  }

  return { bindIssuers, watchTenantZones, unbindIssuers, issuerCleanups };
}

export type InstallationDomainIssuers = ReturnType<typeof createInstallationDomainIssuers>;
