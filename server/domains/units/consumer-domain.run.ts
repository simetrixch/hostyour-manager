import { z } from "zod";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { Cleanup, LockClaim, RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { findActiveRunOn } from "../../executor/read.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import { DnsZoneUnknownError, type DnsProvider } from "../../adapters/dns/port.ts";
import type { PublicProbe } from "#unit/server/adapters/http-probe/port.ts";
import { consumerUnitHost, removeBookedRecord } from "#unit/server/unit-dns.ts";
import { awaitAnswer, provisionDomainRecord, refuseHeldHost, type HeldHost } from "#unit/server/unit-domain.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { tenantOwnHosts } from "#unit/shared/unit-host.ts";
import { attestTargetStep, loadAppCluster, type AppCluster, type LifecyclePorts } from "./lifecycle.ts";

// `consumer-set-domain` — set, switch or clear the domain ONE consumer answers at, at ONE stage.
//
// WHY IT EXISTS. A consumer is reached at its platform host `<label>.<stage apex>`, and may be given a
// domain beside it: the stage registration's `fqdn`, which hostyour-cloud hands to the unit's
// admission policy. The Manager is the domain's one writer — the manifest declares none — so the
// domain switches without a commit in the consumer's repository, and the platform host keeps answering.
//
// THE DOMAIN'S RECORD is a CNAME onto the consumer's PLATFORM HOST, never onto a cluster: the platform
// host's record follows the consumer through every move and cluster rename, so a record in a zone this
// installation does not manage never has to change again. Where this installation's DNS provider
// manages the domain's zone, the run writes the record; where it does not, the run names the record
// the operator sets and waits for it.
//
// THE WAIT BEFORE THE REMOVAL, as in tenant-set-own-domain: the previous domain's record goes only once
// the consumer answers a 2xx at the new domain, and the wait and the removal are one step, so skipping
// a failed wait removes nothing. The registration carries ONE domain, and the admission policy admits
// only what it carries, so the new domain replaces the previous one there before the wait: an abort
// records the previous domain again and removes the new domain's record where this run wrote it.

const domain = z.union([z.literal(""), publicFqdn]);

export const ConsumerSetDomainParams = z.object({
  appId: z.string().startsWith("app_"),
  /** The domain to set, or "" to clear it: the consumer then answers at its platform host alone. */
  fqdn: domain,
  /** The domain the consumer had at this stage when this was asked for. The plan refuses a consumer
   *  that has moved since, and an abort records it again. */
  previous: domain,
});
export type ConsumerSetDomainParams = z.infer<typeof ConsumerSetDomainParams>;

export type ConsumerSetDomainPorts = LifecyclePorts & {
  /** Writes the new domain's record where this installation manages its zone, and takes the previous
   *  one back. Absent: the run names every record the operator sets. */
  dns?: DnsProvider;
  /** Reads the consumer at its new domain from the outside. */
  probe: PublicProbe;
  /** How long the wait asks before it fails the run, and how long it pauses between two asks. */
  domainWaitMs: number;
  domainPollMs: number;
};

/** The consumer's platform host at its stage, and the apex it stands under. */
async function platformHostOf(ports: ConsumerSetDomainPorts, ac: AppCluster): Promise<{ apex: string; host: string }> {
  const apex = unitApexFromChain(await ports.registrations.readClusterValueFiles(ac.domain, ac.stage));
  return { apex, host: consumerUnitHost(ac.host, ac.stage, apex) };
}

/** The domain the consumer's stage registration carries now, "" where it carries none. */
async function standingDomain(ports: ConsumerSetDomainPorts, ac: AppCluster): Promise<string> {
  const reg = await ports.registrations.readRegistration(ac.stage, ac.name);
  if (!reg) throw errValidation(`consumer ${ac.name} is not registered at ${ac.stage} — there is no stage to give a domain`);
  return reg.entry.fqdn ?? "";
}

/** Refuse a consumer whose row is not the standing one this run acts on. */
function assertStanding(db: Db, appId: string, ac: AppCluster): void {
  const status = db.select({ status: apps.status }).from(apps).where(eq(apps.id, appId)).get()?.status;
  if (status === "provisioning") throw errValidation(`consumer ${ac.name} is still provisioning at ${ac.stage} — its onboarding run has not finished; finish or remove it before setting its domain`);
  if (status === "offboarded") throw errValidation(`consumer ${ac.name} is offboarded at ${ac.stage} — nothing serves it there, so there is no domain to set`);
  if (status === "suspended") throw errValidation(`consumer ${ac.name} is suspended at ${ac.stage} — its ingress is down, so its new domain could never answer; resume it first`);
}

/** Every host a live unit answers at beside its platform host, this consumer at this stage excepted:
 *  each live tenant's own domain and redirect hosts, and each consumer's domain at every stage — its
 *  own other stages included, because one domain carries one record. */
async function heldHosts(db: Db, ports: ConsumerSetDomainPorts, ac: AppCluster): Promise<HeldHost[]> {
  const held: HeldHost[] = db
    .select({ subdomain: tenants.subdomain, ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects })
    .from(tenants)
    .where(and(ne(tenants.ownDomain, ""), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
    .all()
    .flatMap((t) => tenantOwnHosts(t.ownDomain, t.ownDomainRedirects).map((host) => ({ host, holder: `tenant ${t.subdomain}` })));
  for (const d of await ports.registrations.listAttestedFqdns({ unit: ac.name, stage: ac.stage })) held.push({ host: d.fqdn, holder: `consumer ${d.unit} at ${d.stage}` });
  return held;
}

/** Refuse `fqdn` where it is no domain this consumer may take — the plan's refusal, asked again when
 *  the run writes the record, because another unit may have taken the name in between. */
async function assertDomainFree(db: Db, ports: ConsumerSetDomainPorts, ac: AppCluster, fqdn: string): Promise<{ apex: string; host: string }> {
  const platform = await platformHostOf(ports, ac);
  if (fqdn !== "") refuseHeldHost(db, fqdn, { apex: platform.apex, held: await heldHosts(db, ports, ac) });
  return platform;
}

/** Remove `fqdn`'s record where this installation wrote it for this consumer at this stage (the book
 *  says so), while it still points where the book says. A record in a zone nobody here manages is the
 *  operator's to remove, and the run says so. */
async function removeDomainRecord(ctx: StepCtx, ports: ConsumerSetDomainPorts, ac: AppCluster, fqdn: string): Promise<void> {
  if (!(await removeBookedRecord(ctx, { dns: ports.dns, owner: { kind: "consumer", name: ac.name, stage: ac.stage }, recordName: fqdn }))) {
    ctx.log("meta", `${fqdn} is not recorded as written here for consumer ${ac.name} at ${ac.stage} — if it points at the consumer, remove it at its provider`);
  }
}

/** On abort: put the previous domain back on the stage registration. */
function restoreDomainCleanup(ports: ConsumerSetDomainPorts, p: ConsumerSetDomainParams): Cleanup {
  return {
    name: "restore-domain",
    title: `Record the previous domain (${p.previous || "none"}) again`,
    run: async (ctx) => {
      const ac = loadAppCluster(ctx.db, p.appId);
      const { commit } = await ports.registrations.setFqdn(ac.stage, ac.name, p.previous, ctx.runId);
      ctx.log("meta", `consumer ${ac.name} at ${ac.stage}: domain back to ${p.previous || "none"} (${commit})`);
    },
  };
}

/** On abort: remove the new domain's record — unless the registration names that domain after all.
 *  Runs after restore-domain (cleanups run in reverse order), so it reads the restored registration. */
function removeNewRecordCleanup(ports: ConsumerSetDomainPorts, p: ConsumerSetDomainParams): Cleanup {
  return {
    name: "remove-new-domain-record",
    title: `Remove the DNS record of ${p.fqdn || "no domain"}, where the consumer does not use it`,
    run: async (ctx) => {
      const ac = loadAppCluster(ctx.db, p.appId);
      if (p.fqdn === "" || (await standingDomain(ports, ac)) === p.fqdn) return;
      await removeDomainRecord(ctx, ports, ac, p.fqdn);
    },
  };
}

function consumerSetDomainSteps(ports: ConsumerSetDomainPorts, p: ConsumerSetDomainParams): Step[] {
  return [
    attestTargetStep(ports, p.appId),
    {
      name: "provision-domain-record",
      title: "Point the new domain at the consumer's platform host",
      run: async (ctx) => {
        if (p.fqdn === "") {
          ctx.log("meta", "no domain is set — the consumer answers at its platform host alone, whose record stands");
          return;
        }
        const ac = loadAppCluster(ctx.db, p.appId);
        const { host } = await assertDomainFree(ctx.db, ports, ac, p.fqdn);
        ctx.registerCleanup(removeNewRecordCleanup(ports, p));
        await provisionDomainRecord(ctx, { dns: ports.dns, owner: { kind: "consumer", name: ac.name, stage: ac.stage }, recordName: p.fqdn, target: host });
      },
    },
    {
      name: "write-domain",
      title: "Record the domain on the consumer's stage registration",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, p.appId);
        // The plan's facts, asked again: another run may have moved the consumer since it was planned.
        // A resume finds its own write already standing.
        assertStanding(ctx.db, p.appId, ac);
        const standing = await standingDomain(ports, ac);
        if (standing !== p.previous && standing !== p.fqdn) {
          throw errValidation(`consumer ${ac.name} answers at ${standing || "no domain"} at ${ac.stage} now, not at ${p.previous || "no domain"} as when this run was planned — plan it again`);
        }
        ctx.registerCleanup(restoreDomainCleanup(ports, p));
        const { commit } = await ports.registrations.setFqdn(ac.stage, ac.name, p.fqdn, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `consumer ${ac.name} at ${ac.stage}: domain ${p.previous || "none"} → ${p.fqdn || "none"} (${commit}) — the ArgoCD on ${ac.domain} carries it to the consumer on its next sync`);
      },
    },
    {
      name: "retire-previous-domain",
      title: "Wait until the consumer answers at its new domain, then remove the previous domain's record",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, p.appId);
        const { host } = await platformHostOf(ports, ac);
        const url = `https://${p.fqdn || host}/`;
        const seen = await awaitAnswer(
          ctx, { probe: ports.probe, waitMs: ports.domainWaitMs, pollMs: ports.domainPollMs }, url, { says: "a 2xx", accepts: (s) => s >= 200 && s < 300 },
          "its record, its certificate or the consumer's chart are not in place yet. The previous domain's record still stands: retry this step once they are, or abort the run to record the previous domain again.",
        );
        ctx.log("meta", `${url} answers (${seen}) — the consumer is served at ${p.fqdn || host}`);
        if (p.previous !== "" && p.previous !== p.fqdn) await removeDomainRecord(ctx, ports, ac, p.previous);
      },
    },
  ];
}

export function makeConsumerSetDomainDef(ports: ConsumerSetDomainPorts): RunDefinition<ConsumerSetDomainParams> {
  return {
    kind: "consumer-set-domain",
    paramsSchema: ConsumerSetDomainParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      assertStanding(db, params.appId, ac);
      const busy = findActiveRunOn(db, { kind: "app", id: params.appId });
      if (busy) throw errValidation(`consumer ${ac.name} at ${ac.stage} is mid-run: ${busy.kind} ${busy.id} is ${busy.status} — let it finish, or retry or abort it, first`);
      const standing = await standingDomain(ports, ac);
      if (standing !== params.previous) {
        throw errValidation(`consumer ${ac.name} answers at ${standing || "no domain"} at ${ac.stage}, not at ${params.previous || "no domain"} as this request says — it moved since; ask again`);
      }
      if (params.fqdn === "" && params.previous === "") throw errValidation(`consumer ${ac.name} has no domain at ${ac.stage} — there is none to clear`);
      const { host } = await assertDomainFree(db, ports, ac, params.fqdn);
      const serves = params.fqdn || host;
      const retired = params.previous !== "" && params.previous !== params.fqdn ? params.previous : null;
      const steps = consumerSetDomainSteps(ports, params);
      return {
        kind: "consumer-set-domain",
        targetKind: "app",
        targetId: params.appId,
        summary:
          `${params.previous === params.fqdn ? "Re-apply the domain" : `Move consumer ${ac.name} from ${params.previous || "no domain"} to`} ${params.fqdn || "no domain"} at ${ac.stage} (${ac.domain}): ` +
          `${params.fqdn ? `point ${params.fqdn} at ${host}, ` : ""}record it on the stage registration, wait until https://${serves}/ answers with a 2xx` +
          `${retired ? `, then remove the record of ${retired}` : ""}. The platform host ${host} keeps answering beside it. ` +
          `${params.fqdn ? `The consumer's chart must serve ${params.fqdn}, with its certificate, for the wait to end. Where this installation does not manage the DNS zone of ${params.fqdn}, set its record (a CNAME onto ${host}) BEFORE approving. ` : ""}` +
          `${retired ? `From the moment this is recorded, ${retired} is no longer admitted.` : ""}`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        // The claim every run kind that commits a consumer registration makes (set-size.run.ts).
        locks: [
          { resource: "git-branch", key: ports.registrations.branch },
          { resource: "git-branch", key: ac.domain },
          { resource: "master-kube", key: "m" },
        ] satisfies LockClaim[],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => consumerSetDomainSteps(ports, params),
    cleanups: (params) => [removeNewRecordCleanup(ports, params), restoreDomainCleanup(ports, params)],
    // Refused once the previous domain's record, which this installation wrote, is gone: the consumer
    // then answers at the new domain alone, and the abort would remove its record.
    assertAbortable: async (params) => {
      if (!ports.dns || params.previous === "" || params.previous === params.fqdn) return;
      let standing: string | null;
      try {
        standing = await ports.dns.readRecordContent({ name: params.previous, type: "CNAME" });
      } catch (e) {
        // A zone nobody here manages: this run never removed that record, so the abort takes nothing.
        if (e instanceof DnsZoneUnknownError) return;
        throw e;
      }
      if (standing === null) {
        throw errValidation(`${params.previous}, the previous domain's record, is gone — an abort would record ${params.previous} again with no record to reach it${params.fqdn ? ` and remove the record of ${params.fqdn}` : ""}. Retry the run instead.`);
      }
    },
  };
}
