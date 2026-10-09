// A stage's sender domain that the product's mail service does not sign yet gets its DKIM record from
// the Manager: the plan names the one TXT record and its zone, so the approve is the yes for that zone;
// the run writes it, has the mail service check it and waits until mail from the domain is signed,
// before the issuer is bound and the registration changes. Nothing but that record is ever written,
// and a record the Manager did not write is never touched.
import { setTimeout as sleep } from "node:timers/promises";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { errValidation } from "../../kernel/errors.ts";
import { findDnsWrite, forgetDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { DnsZoneUnknownError, type DnsProvider } from "../../adapters/dns/port.ts";
import { stageApex } from "#unit/shared/unit-host.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { requireDns } from "#unit/server/unit-dns.ts";
import { loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { readTenantSpec } from "./tenant-apps-repo.run.ts";
import type { TenantSpec } from "../../../shared/consumer.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { fillStageUrl, openStageUnitCallKey } from "./tenant-sender-domain-issuer.ts";
import type { TenantSetSenderDomainParams, TenantSetSenderDomainPorts } from "./tenant-sender-domain.run.ts";

export const RUN_KIND = "tenant-set-sender-domain";
export const DKIM_SIGNING_WAIT_MS = 10 * 60_000;
export const DKIM_POLL_INTERVAL_MS = 15_000;

/** The DKIM record a run publishes, as the plan named it. */
export interface DkimRecordPlan {
  name: string;
  content: string;
  zone: string;
}

/** The tenant's public apex, off its cluster's values chain. */
export async function tenantUnitApex(ports: Pick<TenantOnboardPorts, "resolveClusterValueFiles">, tc: TenantCluster): Promise<string> {
  return unitApexFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage));
}

/** Why the product's check refuses `domain`, or null where mail from it is signed. `pending` says that the
 *  product knows the domain and only waits for its DKIM record, which this Manager can publish. */
export async function refuseUnsigned(
  ports: TenantSetSenderDomainPorts,
  tc: TenantCluster,
  template: string | undefined,
  domain: string,
): Promise<{ why: string; pending: boolean } | null> {
  const refused = (why: string) => ({ why, pending: false });
  if (!template) return refused("the product declares no senderDomainCheck in its tenant spec, so no tenant of it sends from a domain of its own");
  const url = fillStageUrl(template, stageApex(await tenantUnitApex(ports, tc), tc.stage), domain);
  const answer = await ports.probe.probe(url, { readBody: true });
  if (answer.status === 404) return refused(`the product does not know ${domain} as a sender domain (${url} answered 404) — register it in the product's mail service first`);
  if (answer.status !== 200) return refused(`the product's sender-domain check did not answer (${url}: ${answer.detail}) — nothing says mail from ${domain} is signed`);
  let signing: unknown;
  try {
    signing = (JSON.parse(answer.body ?? "") as { signing?: unknown }).signing;
  } catch {
    return refused(`the product's sender-domain check answered no JSON (${url}) — nothing says mail from ${domain} is signed`);
  }
  if (signing === true) return null;
  return { why: `mail from ${domain} is not signed yet (${url} answered signing: ${String(signing)}) — its key is not active in the product's mail service`, pending: true };
}

/** The TXT record a route of the product's mail service answers for `domain`. Only its name, type and content
 *  are read, and none of them is echoed where the answer is not such a record: `what` names the record in the
 *  refusals, `shape` says what it has to be, and `accepts` judges the answered name and content. */
export async function readTxtRecord(
  ports: Pick<TenantSetSenderDomainPorts, "unitCall">,
  route: { url: string; key: string; signal?: AbortSignal },
  record: { what: string; domain: string; shape: string; accepts: (name: string, content: string) => boolean },
): Promise<{ name: string; content: string }> {
  const answer = await ports.unitCall.call({ method: "GET", url: route.url, key: route.key, ...(route.signal ? { signal: route.signal } : {}) });
  if (answer.status !== 200) throw errValidation(`${route.url} answered ${answer.status ?? "nothing"} (${answer.detail}) — the Manager cannot read the ${record.what} of ${record.domain}`);
  const body = (answer.body ?? {}) as { name?: unknown; type?: unknown; content?: unknown };
  if (typeof body.name !== "string" || body.type !== "TXT" || typeof body.content !== "string" || body.content === "" || !record.accepts(body.name, body.content)) {
    throw errValidation(`${route.url} answered no ${record.what} of ${record.domain}, which is ${record.shape}`);
  }
  return { name: body.name, content: body.content };
}

/** The record the product's mail service wants published for `domain`. */
function readDkimRecord(ports: TenantSetSenderDomainPorts, url: string, key: string, domain: string, signal?: AbortSignal): Promise<{ name: string; content: string }> {
  return readTxtRecord(ports, { url, key, ...(signal ? { signal } : {}) }, {
    what: "DKIM record",
    domain,
    shape: `a TXT record named <selector>._domainkey.${domain}`,
    accepts: (name) => name.endsWith(`._domainkey.${domain}`),
  });
}

/** The zone that holds a record's name, or the refusal where this Manager manages none: `repair` says what
 *  the person does then. */
export async function zoneOfRecord(dns: DnsProvider, name: string, repair: string): Promise<string> {
  try {
    return await dns.zoneName({ name });
  } catch (err) {
    if (err instanceof DnsZoneUnknownError) throw errValidation(`${name} lies in a zone this Manager does not manage — ${repair}`);
    throw err;
  }
}

/** Whether the record already stands at its name. Another TXT record there refuses: the Manager never
 *  overwrites one, because the compensation would then delete what it did not create. */
async function standingDkim(dns: DnsProvider, db: Db, record: { name: string; content: string }, signal?: AbortSignal): Promise<boolean> {
  const standing = await dns.listRecordContents({ name: record.name, type: "TXT", ...(signal ? { signal } : {}) });
  if (standing.every((txt) => txt === record.content)) return standing.length > 0;
  throw errValidation(
    findDnsWrite(db, { name: record.name, type: "TXT" }) === null
      ? `a TXT record this Manager did not write stands at ${record.name} — it is left untouched; remove it in the DNS provider if it is stale, then plan again`
      : `TXT ${record.name} holds another key this Manager wrote earlier — remove it on the DNS page, then plan again`,
  );
}

/** The DKIM record the run publishes, or null where nothing is to publish because mail from the domain is
 *  signed already. Refuses as before where the product's check refuses for another reason, or where the
 *  product declares no route to read the record from. */
export async function planDkimRecord(ports: TenantSetSenderDomainPorts, db: Db, tc: TenantCluster, spec: TenantSpec | null, senderDomain: string): Promise<DkimRecordPlan | null> {
  const refused = await refuseUnsigned(ports, tc, spec?.senderDomainCheck, senderDomain);
  if (refused === null) return null;
  const route = spec?.senderDomainDkim;
  if (!route || !refused.pending) throw errValidation(`tenant ${tc.subdomain} cannot send as ${senderDomain} — ${refused.why}`);
  const apex = stageApex(await tenantUnitApex(ports, tc), tc.stage);
  const key = await openStageUnitCallKey(ports.store, route.unit, tc.stage, `${RUN_KIND}:read-dkim-record`);
  const record = await readDkimRecord(ports, fillStageUrl(route.recordUrl, apex, senderDomain), key, senderDomain);
  const dns = requireDns(ports.dns, tc.guid, RUN_KIND);
  const zone = await zoneOfRecord(dns, record.name, `publish it there by hand and have ${route.unit} check it, or give the Manager that zone`);
  await standingDkim(dns, db, record);
  return { ...record, zone };
}

/** What a step of a sender-domain record needs at run time: the route as the product declares it now, and the key. */
export async function dkimRouteAt(ports: TenantSetSenderDomainPorts, ctx: StepCtx, p: TenantSetSenderDomainParams, purpose: string) {
  const spec = await readTenantSpec(ports, { signal: ctx.signal });
  const route = spec?.senderDomainDkim;
  if (!route) throw errValidation(`the product's tenant spec no longer declares senderDomainDkim — plan again`);
  const tc = loadTenantCluster(ctx.db, p.tenantId);
  const apex = stageApex(await tenantUnitApex(ports, tc), tc.stage);
  const key = await openStageUnitCallKey(ctx.creds, route.unit, tc.stage, `${RUN_KIND}:${purpose}`, ctx.runId);
  return { spec, route, tc, apex, key };
}

/** Why a run publishes no record and waits for no signing; the steps stand in every run's list, so
 *  their titles say it rather than promise a record. */
const unsignedNone = (p: TenantSetSenderDomainParams): string =>
  p.senderDomain === "" ? "the tenant sends from the platform's own domain" : `the product signs mail from ${p.senderDomain} already`;

/** Publishes the record the plan named. It is read from the product again and must be the same, so a
 *  run publishes nothing the product does not want at this moment. */
export function publishDkimRecordStep(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Step {
  return {
    name: "publish-dkim-record",
    title: p.dkim ? `Publish TXT ${p.dkim.name} in the zone ${p.dkim.zone}` : `No DKIM record to publish: ${unsignedNone(p)}`,
    run: async (ctx) => {
      const want = p.dkim;
      if (!want) {
        ctx.log("meta", `mail from ${p.senderDomain || "the platform's own domain"} is signed without a record from this run — nothing to publish`);
        return;
      }
      const { route, tc, apex, key } = await dkimRouteAt(ports, ctx, p, "publish-dkim-record");
      const now = await readDkimRecord(ports, fillStageUrl(route.recordUrl, apex, p.senderDomain), key, p.senderDomain, ctx.signal);
      if (now.name !== want.name || now.content !== want.content) {
        throw errValidation(`${route.unit} wants another DKIM record for ${p.senderDomain} than the plan named (TXT ${now.name}) — plan again`);
      }
      const dns = requireDns(ports.dns, tc.guid, RUN_KIND);
      const owner = { kind: "tenant" as const, name: tc.guid, stage: tc.stage };
      if (await standingDkim(dns, ctx.db, want, ctx.signal)) {
        const booked = findDnsWrite(ctx.db, { name: want.name, type: "TXT" });
        if (booked === null) recordDnsWrite(ctx.db, { name: want.name, type: "TXT", content: want.content, act: "adopted", owner, runId: ctx.runId });
        ctx.log("meta", `TXT ${want.name} already stands${booked === null ? " — adopted for tenant " + tc.guid : ", booked by run " + booked.runId} and stays when this run is aborted`);
        return;
      }
      await dns.createRecord({ name: want.name, type: "TXT", content: want.content, signal: ctx.signal });
      recordDnsWrite(ctx.db, { name: want.name, type: "TXT", content: want.content, act: "inserted", owner, runId: ctx.runId });
      ctx.registerCleanup(removeDkimRecordCleanup(ports, p));
      ctx.log("meta", `TXT ${want.name} published in the zone ${want.zone} — entered into the book of DNS writes as tenant ${tc.guid}'s`);
    },
  };
}

/** Takes back the record this run created, and nothing else: one it adopted, or one a later run booked,
 *  stays. */
export function removeDkimRecordCleanup(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Cleanup {
  return {
    name: "remove-dkim-record",
    title: p.dkim ? `Remove TXT ${p.dkim.name}, which this run published` : "Remove the DKIM record this run published",
    run: async (ctx) => {
      const want = p.dkim;
      if (!want) return;
      const booked = findDnsWrite(ctx.db, { name: want.name, type: "TXT" });
      if (booked === null || booked.runId !== ctx.runId) {
        ctx.log("meta", `TXT ${want.name} is not booked as created by this run — left as it is`);
        return;
      }
      const dns = requireDns(ports.dns, booked.owner.name, RUN_KIND);
      const { deleted } = await dns.deleteRecord({ name: want.name, type: "TXT", content: want.content, signal: ctx.signal });
      forgetDnsWrite(ctx.db, { name: want.name, type: "TXT" });
      ctx.log("meta", deleted > 0 ? `TXT ${want.name} deleted and forgotten from the book of DNS writes` : `TXT ${want.name} was gone already — forgotten from the book of DNS writes`);
    },
  };
}

/** Has the product's mail service check the record until mail from the domain is signed. DNS reaches the
 *  service's resolver after a while, so the step asks again until the wait is over. */
export function awaitDkimSigningStep(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Step {
  return {
    name: "await-dkim-signing",
    title: p.dkim ? `Wait until mail from ${p.senderDomain} is signed` : `No wait for signing: ${unsignedNone(p)}`,
    run: async (ctx) => {
      const want = p.dkim;
      if (!want) return;
      const { spec, route, tc, apex, key } = await dkimRouteAt(ports, ctx, p, "check-dkim-record");
      const checkUrl = fillStageUrl(route.checkUrl, apex, p.senderDomain);
      const waitMs = ports.dkimWaitMs ?? DKIM_SIGNING_WAIT_MS;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const checked = await ports.unitCall.call({ method: "POST", url: checkUrl, key, signal: ctx.signal });
        if (checked.status !== 200) throw errValidation(`${checkUrl} answered ${checked.status ?? "nothing"} (${checked.detail}) — ${route.unit} did not check TXT ${want.name}`);
        const refused = await refuseUnsigned(ports, tc, spec?.senderDomainCheck, p.senderDomain);
        if (refused === null) {
          ctx.log("meta", `mail from ${p.senderDomain} is signed — ${route.unit} found TXT ${want.name}`);
          return;
        }
        if (!refused.pending) throw errValidation(refused.why);
        if (Date.now() >= deadline) {
          throw errValidation(`${route.unit} did not sign mail from ${p.senderDomain} within ${Math.round(waitMs / 60_000)} minutes of TXT ${want.name} — ${refused.why}. Abort this run to take the record back, or set the sender domain again once DNS has reached ${route.unit}`);
        }
        await sleep(ports.dkimPollMs ?? DKIM_POLL_INTERVAL_MS, undefined, { signal: ctx.signal });
      }
    },
  };
}
