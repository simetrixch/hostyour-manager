// A stage's sender domain gets its DMARC record beside its DKIM record, because large receivers treat mail
// from a domain without one as suspect. The text is the product's mail service's, read from the route its
// tenant spec declares, and a DMARC policy is never overwritten: a TXT record at the name, whoever wrote it,
// is the domain's policy and stays, so the plan names it and the run goes on. Only a record this run created
// is taken back on an abort.
import type { Cleanup, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { errValidation } from "../../kernel/errors.ts";
import { findDnsWrite, forgetDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { dmarcRecordName, MAIL_RECORD_TAG } from "../../../shared/mail.ts";
import { stageApex } from "#unit/shared/unit-host.ts";
import { requireDns } from "#unit/server/unit-dns.ts";
import type { TenantCluster } from "./lifecycle.ts";
import type { TenantSpec } from "../../../shared/consumer.ts";
import { fillStageUrl, openStageUnitCallKey } from "./tenant-sender-domain-issuer.ts";
import { RUN_KIND, dkimRouteAt, readTxtRecord, tenantUnitApex, zoneOfRecord } from "./tenant-sender-domain-dkim.ts";
import type { TenantSetSenderDomainParams, TenantSetSenderDomainPorts } from "./tenant-sender-domain.run.ts";

/** What the plan decided about the DMARC record: publish it, or keep the TXT that stands at its name. */
type DmarcRecordPlan = NonNullable<TenantSetSenderDomainParams["dmarc"]>;

/** The record the product's mail service wants published for `domain`. */
function readDmarcRecord(ports: TenantSetSenderDomainPorts, url: string, key: string, domain: string, signal?: AbortSignal): Promise<{ name: string; content: string }> {
  return readTxtRecord(ports, { url, key, ...(signal ? { signal } : {}) }, {
    what: "DMARC record",
    domain,
    shape: `a TXT record named ${dmarcRecordName(domain)} that carries a DMARC policy`,
    accepts: (name, content) => name === dmarcRecordName(domain) && MAIL_RECORD_TAG.dmarc(content),
  });
}

/** The DMARC record the run publishes or keeps, or null where the domain is empty or the product declares
 *  no route to read the record from. A TXT record at the name is kept and never refused: it is the domain's
 *  own policy, or the one this Manager booked earlier. */
export async function planDmarcRecord(ports: TenantSetSenderDomainPorts, db: Db, tc: TenantCluster, spec: TenantSpec | null, senderDomain: string): Promise<DmarcRecordPlan | null> {
  const route = spec?.senderDomainDkim;
  if (senderDomain === "" || !route?.dmarcRecordUrl) return null;
  const apex = stageApex(await tenantUnitApex(ports, tc), tc.stage);
  const key = await openStageUnitCallKey(ports.store, route.unit, tc.stage, `${RUN_KIND}:read-dmarc-record`);
  const record = await readDmarcRecord(ports, fillStageUrl(route.dmarcRecordUrl, apex, senderDomain), key, senderDomain);
  const dns = requireDns(ports.dns, tc.guid, RUN_KIND);
  const zone = await zoneOfRecord(dns, record.name, "publish it there by hand, or give the Manager that zone");
  if ((await dns.listRecordContents({ name: record.name, type: "TXT" })).length === 0) return { ...record, zone, act: "publish" };
  const booked = findDnsWrite(db, { name: record.name, type: "TXT" });
  const why = booked === null
    ? `a DMARC policy this Manager did not write stands at ${record.name}; it stays`
    : `the DMARC record booked by run ${booked.runId} stays`;
  return { ...record, zone, act: "keep", why };
}

/** The sentence of the plan summary that says what the run does about DMARC, or "" where the tenant sends
 *  from the platform's own domain. */
export function dmarcPlanSentence(p: TenantSetSenderDomainParams): string {
  if (p.senderDomain === "") return "";
  if (!p.dmarc) return " The product declares no senderDomainDkim.dmarcRecordUrl, so the run publishes no DMARC record.";
  return p.dmarc.act === "publish" ? ` The run publishes TXT ${p.dmarc.name} in the zone ${p.dmarc.zone}.` : ` The run publishes no DMARC record: ${p.dmarc.why}.`;
}

const noneTitle = (p: TenantSetSenderDomainParams): string => {
  if (p.dmarc?.act === "keep") return p.dmarc.why;
  return p.senderDomain === "" ? "the tenant sends from the platform's own domain" : "the product declares no senderDomainDkim.dmarcRecordUrl";
};

/** Publishes the record the plan named. It is read from the product again and must be the same, so a run
 *  publishes nothing the product does not want at this moment; and a TXT record that appeared at the name
 *  since the plan stays. */
export function publishDmarcRecordStep(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Step {
  return {
    name: "publish-dmarc-record",
    title: p.dmarc?.act === "publish" ? `Publish TXT ${p.dmarc.name} in the zone ${p.dmarc.zone}` : `No DMARC record to publish: ${noneTitle(p)}`,
    run: async (ctx) => {
      const want = p.dmarc;
      if (want?.act !== "publish") {
        ctx.log("meta", `no DMARC record to publish: ${noneTitle(p)}`);
        return;
      }
      const { route, tc, apex, key } = await dkimRouteAt(ports, ctx, p, "publish-dmarc-record");
      if (!route.dmarcRecordUrl) throw errValidation(`the product's tenant spec no longer declares senderDomainDkim.dmarcRecordUrl — plan again`);
      const now = await readDmarcRecord(ports, fillStageUrl(route.dmarcRecordUrl, apex, p.senderDomain), key, p.senderDomain, ctx.signal);
      if (now.name !== want.name || now.content !== want.content) {
        throw errValidation(`${route.unit} wants another DMARC record for ${p.senderDomain} than the plan named (TXT ${now.name}) — plan again`);
      }
      const dns = requireDns(ports.dns, tc.guid, RUN_KIND);
      if ((await dns.listRecordContents({ name: want.name, type: "TXT", signal: ctx.signal })).length > 0) {
        ctx.log("meta", `a TXT record stands at ${want.name} since the plan — it stays, and this run publishes no DMARC record`);
        return;
      }
      await dns.createRecord({ name: want.name, type: "TXT", content: want.content, signal: ctx.signal });
      recordDnsWrite(ctx.db, { name: want.name, type: "TXT", content: want.content, act: "inserted", owner: { kind: "tenant", name: tc.guid, stage: tc.stage }, runId: ctx.runId });
      ctx.registerCleanup(removeDmarcRecordCleanup(ports, p));
      ctx.log("meta", `TXT ${want.name} published in the zone ${want.zone} — entered into the book of DNS writes as tenant ${tc.guid}'s`);
    },
  };
}

/** Takes back the record this run created, and nothing else: one a later run booked stays. */
export function removeDmarcRecordCleanup(ports: TenantSetSenderDomainPorts, p: TenantSetSenderDomainParams): Cleanup {
  return {
    name: "remove-dmarc-record",
    title: p.dmarc ? `Remove TXT ${p.dmarc.name}, which this run published` : "Remove the DMARC record this run published",
    run: async (ctx) => {
      const want = p.dmarc;
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
