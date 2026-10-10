// The records and the wait of a customer's own hosts: the tenant's own domain (tenant-set-own-domain).
// Each host gets a CNAME onto the tenant's zone, entered
// into the book of DNS writes; a host in a zone nobody here manages is named for the operator to set.
// An address record, or a CNAME this installation did not write, standing at such a host is replaced:
// the plan lists it, the run deletes it, and an abort writes it back.
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { Step, StepCtx } from "../../executor/types.ts";
import { TENANT_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import type { Db } from "../../db/client.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { DnsZoneUnknownError, type StandingDnsRecord } from "../../adapters/dns/port.ts";
import type { TenantCluster, TenantLifecyclePorts } from "./lifecycle.ts";
import { isBookedFor, isTenantRecord, removeBookedRecord, tenantZone } from "#unit/server/unit-dns.ts";
import { prodHostOf, tenantOwnHosts as ownHosts } from "#unit/shared/unit-host.ts";
import { sleep } from "#unit/server/release-cycle.ts";
import type { PublicProbe } from "#unit/server/adapters/http-probe/port.ts";
import { publicFqdn } from "../../../shared/consumer.ts";

/** What writing and removing a record reads: the installation's DNS provider, where one is configured,
 *  and the public resolvers, which say what a name answers before its CNAME is replaced. */
export type RecordPorts = Pick<TenantLifecyclePorts, "dns" | "publicDns">;

/** What waiting for an answer reads: the probe, how long it asks, and how long it pauses between asks. */
export interface AnswerWaitPorts {
  probe: PublicProbe;
  answerWaitMs: number;
  answerPollMs: number;
}

/** Why `host` cannot be a customer's host of this tenant, or null: it lies in the platform's own name
 *  space or under a cluster's name, or it is, or overlaps, a host of another live tenant (one host
 *  carries one record, so it serves one tenant, and a session cookie scoped to an outer host would
 *  reach the inner one). An offboarded or purged tenant's hosts are free again.
 *
 *  THE ONE EXCEPTION IS CONFIRMED NESTING: a host may lie strictly below a host of the tenant this
 *  tenant nests under (tenants.nests_under, which the operator confirms in tenant-set-own-domain),
 *  and a host of a tenant nesting under this one may lie below this tenant's host. The operator accepts
 *  the cookie reach for two tenants of one owner; the exact same host stays refused. `nestsUnder`
 *  stands in for the recorded value while tenant-set-own-domain plans a new one. */
export function customerHostProblem(db: Db, tenantId: string, host: string, apex: string, nestsUnder?: string | null): string | null {
  if (host === apex || host.endsWith(`.${apex}`)) return `${host} lies in the platform's own name space (${apex}) — a customer's domain is one the customer brings`;
  // The one mail name a host can be spelled as (a DKIM selector carries an underscore, which no host
  // does): its CNAME is the domain's mail record (mailNames), and an own domain's CNAME would replace it.
  if (host.startsWith("autodiscover.")) return `${host} is the autodiscover name of ${host.slice("autodiscover.".length)}'s mail, a mail record — no own domain takes it`;
  const cluster = db.select({ domain: clusters.domain }).from(clusters).all().map((c) => c.domain).find((d) => host === d || host.endsWith(`.${d}`));
  if (cluster) return `${host} lies under the cluster name ${cluster} — a customer's domain is one the customer brings`;
  const self = db.select({ guid: tenants.guid, stage: tenants.stage, nestsUnder: tenants.nestsUnder }).from(tenants).where(eq(tenants.id, tenantId)).get();
  const parent = nestsUnder !== undefined ? nestsUnder : (self?.nestsUnder ?? null);
  const others = db
    .select({ id: tenants.id, guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage, ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects, ownDomainAliases: tenants.ownDomainAliases, nestsUnder: tenants.nestsUnder })
    .from(tenants)
    .where(and(ne(tenants.id, tenantId), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
    .all();
  const overlaps = (theirs: string): boolean => theirs === host || theirs.endsWith(`.${host}`) || host.endsWith(`.${theirs}`);
  const confirmed = (other: { id: string; nestsUnder: string | null }, theirs: string): boolean =>
    (host.endsWith(`.${theirs}`) && parent === other.id) || (theirs.endsWith(`.${host}`) && other.nestsUnder === tenantId);
  const refusal = (what: string, other: string, theirs: string): string =>
    `${host} ${theirs === host ? "is already" : "overlaps"} ${what} of tenant ${other} (${theirs})` +
    (host.endsWith(`.${theirs}`) ? ` — where both tenants are one owner's, confirm in Set own domain that this tenant's domain lies under tenant ${other}` : "");
  for (const o of others) {
    const theirs = ownHosts(o.ownDomain, o.ownDomainRedirects, o.ownDomainAliases).find(overlaps);
    if (!theirs || confirmed(o, theirs)) continue;
    // The same tenant at another stage. The stage rule puts its dev or test hosts at
    // <x>.<stage>.<zone>, under the zone's apex (stageHostProblem), so that nest is the rule's own
    // and no overlap. Any other is refused, named with its stage, and with no nesting to confirm,
    // which is between two tenants.
    if (o.guid === self?.guid) {
      const stageNested = (inner: string, stage: Stage, outer: string): boolean => stage !== "prod" && prodHostOf(inner, outer, stage) !== null;
      if (stageNested(theirs, o.stage, host) || stageNested(host, self.stage, theirs)) continue;
      return `${host} ${theirs === host ? "is already" : "overlaps"} a host of tenant ${o.subdomain} at ${o.stage} (${theirs})`;
    }
    return refusal("a host", o.subdomain, theirs);
  }
  return null;
}

/** A record that stood at a customer's host, written by nobody here: what a run replaces with its
 *  CNAME, frozen into the run's params at plan time so that an abort can write it back as it stood,
 *  behind the provider's proxy where it was and with its TTL. A run planned before the flag and the TTL
 *  were frozen reads them as DNS-only and automatic, which is what it wrote back then. */
export const ReplacedRecord = z.object({
  name: publicFqdn,
  type: z.enum(["A", "AAAA", "CNAME"]),
  content: z.string().min(1),
  proxied: z.boolean().default(false),
  ttl: z.number().int().positive().default(1),
});
export type ReplacedRecord = z.infer<typeof ReplacedRecord>;

const ADDRESS_TYPES = ["A", "AAAA"] as const;

/** The records a CNAME onto `zone` replaces at `hosts`: every A and AAAA record, and a CNAME pointing
 *  elsewhere that the book of DNS writes does not carry. A record the book carries for another owner
 *  is refused, never replaced. A host in a zone nobody here manages has none: its operator sets it. */
export async function recordsToReplace(db: Db, ports: RecordPorts, guid: string, zone: string, hosts: readonly string[], signal?: AbortSignal): Promise<ReplacedRecord[]> {
  if (!ports.dns) return [];
  const replaced: ReplacedRecord[] = [];
  for (const host of hosts) {
    let standing: StandingDnsRecord | null;
    try {
      standing = (await ports.dns.listStandingRecords({ name: host, type: "CNAME", ...(signal ? { signal } : {}) }))[0] ?? null;
    } catch (e) {
      if (e instanceof DnsZoneUnknownError) continue;
      throw e;
    }
    const cname = standing?.content ?? null;
    if (standing !== null && cname !== null && cname !== zone && !isTenantRecord(db, host, guid)) {
      const booked = findDnsWrite(db, { name: host, type: "CNAME" });
      if (booked !== null) throw errValidation(`${host} stands as CNAME ${cname}, which this installation wrote for ${booked.owner.kind} ${booked.owner.name} — it is not tenant ${guid}'s to replace`);
      await refuseInheritedMailAnswers(ports, host, cname, signal);
      replaced.push({ name: host, type: "CNAME", content: cname, proxied: standing.proxied, ttl: standing.ttl });
    }
    for (const type of ADDRESS_TYPES) {
      for (const { content, proxied, ttl } of await ports.dns.listStandingRecords({ name: host, type, ...(signal ? { signal } : {}) })) {
        const booked = findDnsWrite(db, { name: host, type });
        if (booked !== null) throw errValidation(`${host} carries the ${type} record ${content}, which this installation wrote for ${booked.owner.kind} ${booked.owner.name} — it is not tenant ${guid}'s to replace`);
        replaced.push({ name: host, type, content, proxied, ttl });
      }
    }
  }
  return replaced;
}

/** Refuse to replace the CNAME at `host` while `host` answers MX or TXT only through it. A name
 *  without such records of its own answers its CNAME target's: Cloudflare flattens a CNAME at the
 *  apex, and below the apex a CNAME hands every type to its target. The provider's API lists only
 *  the records the zone holds, so the answers are read where receivers read them. A `www.` host is
 *  no mail domain (mailNames), and its answers are nobody's mail. */
async function refuseInheritedMailAnswers(ports: RecordPorts, host: string, cname: string, signal?: AbortSignal): Promise<void> {
  if (host.startsWith("www.")) return;
  if (!ports.publicDns) throw errValidation(`no public DNS reader is wired on this manager, so what ${host} answers through its CNAME onto ${cname} cannot be read before the CNAME is replaced`);
  const inherited: string[] = [];
  for (const type of ["MX", "TXT"] as const) {
    if ((await ports.dns!.listRecordContents({ name: host, type, ...(signal ? { signal } : {}) })).length > 0) continue;
    const answered = type === "MX" ? await ports.publicDns.mx(host) : await ports.publicDns.txt(host);
    if (answered.length > 0) inherited.push(`${type} ${answered.join(", ")}`);
  }
  if (inherited.length === 0) return;
  throw errValidation(`${host} answers ${inherited.join(" and ")} only through its CNAME onto ${cname}, which this run replaces — add them as records of ${host} first, then plan again`);
}

/** The plan summary's sentence on the records the run replaces, or "" where it replaces none. The
 *  summary is what the run screen shows before the approval. */
export function replacementSentence(replacing: readonly ReplacedRecord[]): string {
  if (replacing.length === 0) return "";
  const records = replacing.map((r) => `${r.type} ${r.name} → ${r.content}${r.proxied ? " (behind the provider's proxy)" : ""}`).join(", ");
  return ` It deletes ${records}, which this installation did not write, and an abort writes ${replacing.length === 1 ? "it" : "them"} back.`;
}

/** Point `domain` at the tenant's zone, where this installation's DNS provider manages the domain's
 *  zone, and enter the write into the book. Where it does not, say which record the operator sets.
 *  The records the plan froze in `replacing` are deleted first; any other record found there now was
 *  not in the plan, and refuses. */
export async function provisionOwnDomainRecord(ctx: StepCtx, ports: RecordPorts, tc: TenantCluster, apex: string, domain: string, replacing: readonly ReplacedRecord[]): Promise<void> {
  const zone = tenantZone(tc.subdomain, tc.stage, apex);
  const operatorSets = `set CNAME ${domain} → ${zone} at the provider of ${domain}; the wait below ends once the tenant answers there`;
  if (!ports.dns) {
    ctx.log("meta", `no DNS provider is configured on this manager: ${operatorSets}`);
    return;
  }
  let standing: string | null;
  try {
    standing = await ports.dns.readRecordContent({ name: domain, type: "CNAME", signal: ctx.signal });
  } catch (e) {
    if (e instanceof DnsZoneUnknownError) {
      ctx.log("meta", `the DNS zone of ${domain} is not managed here: ${operatorSets}`);
      return;
    }
    throw e;
  }
  const planned = (type: ReplacedRecord["type"], content: string): boolean => replacing.some((r) => r.name === domain && r.type === type && r.content === content);
  if (standing !== null && standing !== zone && !isTenantRecord(ctx.db, domain, tc.guid) && !planned("CNAME", standing)) {
    throw errValidation(`${domain} stands as CNAME ${standing}, which the plan did not list and the book of DNS writes does not name tenant ${tc.guid}'s — plan the run again`);
  }
  if (standing === zone) {
    // A record at this tenant's zone serves this tenant, whoever the book names: a tenant this one
    // replaced on the same subdomain had the same zone. Left booked for that one, its purge would take
    // the record from under this tenant.
    const owner = { kind: "tenant" as const, name: tc.guid, stage: tc.stage };
    if (isBookedFor(ctx.db, domain, owner)) {
      ctx.log("meta", `${domain} already points at ${zone}`);
      return;
    }
    const booked = findDnsWrite(ctx.db, { name: domain, type: "CNAME" });
    recordDnsWrite(ctx.db, { name: domain, type: "CNAME", content: zone, act: "adopted", owner, runId: ctx.runId });
    ctx.log("meta", `${domain} already points at ${zone}${booked === null ? "" : `, booked for the ${booked.owner.kind} ${booked.owner.name}`} — adopted for tenant ${tc.guid}, so it goes with this tenant`);
    return;
  }
  // A CNAME stands alone under its name, so an address record there goes first.
  for (const type of ADDRESS_TYPES) {
    for (const content of await ports.dns.listRecordContents({ name: domain, type, signal: ctx.signal })) {
      if (!planned(type, content)) throw errValidation(`${domain} carries the ${type} record ${content}, which was not there when this run was planned — a CNAME cannot stand beside it; plan the run again`);
      await ports.dns.deleteRecord({ name: domain, type, content, signal: ctx.signal });
      ctx.log("meta", `${type} record ${domain} → ${content} deleted — an abort writes it back`);
    }
  }
  const { created } = await ports.dns.upsertRecord({ name: domain, type: "CNAME", content: zone, signal: ctx.signal });
  recordDnsWrite(ctx.db, { name: domain, type: "CNAME", content: zone, act: standing === null ? "inserted" : "updated", owner: { kind: "tenant", name: tc.guid, stage: tc.stage }, runId: ctx.runId });
  ctx.log("meta", `DNS record ${domain} → CNAME ${zone} ${created ? "created" : "updated"}`);
}

/** Remove `domain`'s record where this installation wrote it for this tenant (the book says so), while
 *  it still points where the book says. A record in a zone nobody here manages is the operator's to
 *  remove, and the run says so. */
export async function removeOwnDomainRecord(ctx: StepCtx, ports: RecordPorts, tc: TenantCluster, domain: string): Promise<void> {
  if (!(await removeBookedRecord(ctx, { dns: ports.dns, owner: { kind: "tenant", name: tc.guid }, recordName: domain }))) {
    ctx.log("meta", `${domain} is not recorded as tenant ${tc.guid}'s own record — if it points at the tenant, remove it at its provider`);
  }
}

/** On abort, after the tenant's own records are removed: write back every replaced record that no
 *  longer stands. Where a CNAME stands at its host again, an address record cannot go beside it, and a
 *  replaced CNAME would overwrite it, so that record is named and left. */
export async function restoreReplacedRecords(ctx: StepCtx, ports: RecordPorts, replacing: readonly ReplacedRecord[]): Promise<void> {
  if (!ports.dns || replacing.length === 0) return;
  for (const r of replacing) {
    if ((await ports.dns.listRecordContents({ name: r.name, type: r.type, signal: ctx.signal })).includes(r.content)) continue;
    const cname = await ports.dns.readRecordContent({ name: r.name, type: "CNAME", signal: ctx.signal });
    if (cname !== null) {
      ctx.log("meta", `${r.name} stands as CNAME ${cname} — the replaced ${r.type} record → ${r.content} is not written back beside it; set it at the provider if it is wanted`);
      continue;
    }
    await ports.dns.createRecord({ name: r.name, type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl, signal: ctx.signal });
    ctx.log("meta", `${r.type} record ${r.name} → ${r.content} written back${r.proxied ? ", behind the provider's proxy" : ""}${r.ttl === 1 ? "" : `, TTL ${r.ttl} s`}`);
  }
}

/** Ask `url` until `accepts` takes its status, or fail at the deadline naming what was waited for. */
export async function waitForAnswer(ctx: StepCtx, ports: AnswerWaitPorts, url: string, wanted: string, accepts: (status: number) => boolean, next: string): Promise<string> {
  const deadline = Date.now() + ports.answerWaitMs;
  for (;;) {
    const seen = await ports.probe.probe(url, { signal: ctx.signal });
    if (seen.status !== null && accepts(seen.status)) return seen.detail;
    if (ctx.signal.aborted) throw errValidation(`the wait for ${url} was cancelled`);
    if (Date.now() >= deadline) {
      throw errValidation(
        `${url} did not answer with ${wanted} within ${Math.round(ports.answerWaitMs / 60_000)} minutes (last: ${seen.detail}) — ` +
        `its record, its certificate or the product's charts are not in place yet. ${next}`,
      );
    }
    ctx.log("meta", `${url} does not answer with ${wanted} yet (${seen.detail}); asking again in ${Math.round(ports.answerPollMs / 1000)}s`);
    await sleep(ports.answerPollMs, ctx.signal);
  }
}

/** A mail record beside a host a run writes or removes: its name, its type, and the SHA-256 of every
 *  content standing there (none hashes too, so a record added since the plan counts as a change). */
export const MailRecordHash = z.object({ name: z.string().min(1), type: z.enum(["MX", "TXT", "CNAME"]), sha256: z.string().length(64) });
export type MailRecordHash = z.infer<typeof MailRecordHash>;

/** The names a mail domain's records stand at: the MX and the SPF at the domain, the DMARC policy, and
 *  the autodiscover CNAME. A DKIM key stands at a selector only its sender knows, so it is not read. */
function mailNames(domain: string): Pick<MailRecordHash, "name" | "type">[] {
  return [{ name: domain, type: "MX" }, { name: domain, type: "TXT" }, { name: `_dmarc.${domain}`, type: "TXT" }, { name: `autodiscover.${domain}`, type: "CNAME" }];
}

async function hashOf(ports: RecordPorts, r: Pick<MailRecordHash, "name" | "type">, signal?: AbortSignal): Promise<string> {
  const contents = await ports.dns!.listRecordContents({ name: r.name, type: r.type, ...(signal ? { signal } : {}) });
  return createHash("sha256").update([...contents].sort().join("\n"), "utf8").digest("hex");
}

function normalizeMailDomain(host: string): string {
  const lower = host.toLowerCase();
  const withoutDot = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  return withoutDot.startsWith("www.") ? withoutDot.slice(4) : withoutDot;
}

/** The mail records beside `hosts`, hashed: those at each host's domain (the host without `www.`). A
 *  domain in a zone nobody here manages has none — the run writes nothing there. The plan freezes
 *  them, and checkMailRecordsStep refuses the run where one changed since. */
export async function mailRecordHashes(ports: RecordPorts, hosts: readonly string[], signal?: AbortSignal): Promise<MailRecordHash[]> {
  if (!ports.dns) return [];
  const hashes: MailRecordHash[] = [];
  for (const domain of new Set(hosts.map(normalizeMailDomain))) {
    try {
      for (const r of mailNames(domain)) hashes.push({ ...r, sha256: await hashOf(ports, r, signal) });
    } catch (e) {
      if (!(e instanceof DnsZoneUnknownError)) throw e;
    }
  }
  return hashes;
}

/** The plan summary's sentence on the mail records it leaves, or "" where it reads none. */
export function mailRecordSentence(hashes: readonly MailRecordHash[]): string {
  if (hashes.length === 0) return "";
  return ` It writes only CNAME records, and leaves the mail records beside them as they stand: ${hashes.map((h) => `${h.type} ${h.name} (SHA-256 ${h.sha256.slice(0, 12)})`).join(", ")} — the run refuses to start where any of them changed since this plan.`;
}

/** Before the first write: every mail record the plan hashed, read again, and the run refused where one
 *  changed — the operator then sees what stands now in a new plan. */
export function checkMailRecordsStep(ports: RecordPorts, hashes: readonly MailRecordHash[]): Step {
  return {
    name: "check-mail-records",
    title: "Check that the mail records beside the hosts stand as planned",
    run: async (ctx) => {
      for (const h of hashes) {
        if ((await hashOf(ports, h, ctx.signal)) !== h.sha256) throw errValidation(`the ${h.type} records at ${h.name} changed since this run was planned — plan it again to see what stands now`);
      }
      ctx.log("meta", hashes.length ? `${hashes.length} mail record set(s) stand as planned` : "no mail record beside the hosts is managed here");
    },
  };
}
