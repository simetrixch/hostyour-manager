// The unit's ONE public DNS record (the address belongs to the unit, not to the server) —
// provisioned at onboard/create-tenant, removed at offboard AND at both purge run kinds, over the
// DnsProvider port (adapters/dns). One record per unit STANDING AT A STAGE, by kind of unit:
//
//   consumer — CNAME `<label>.<stage apex>`. The chart renders exactly ONE host, and by DNS rule a
//              wildcard does NOT cover a bare label, so the record is the host itself.
//   tenant   — one CNAME PER STAGE, named by the tenant's recorded routing (tenantRecordName). `host`:
//              the wildcard `*.<subdomain>.<stage apex>`, every member one level below it. `path`:
//              the zone `<subdomain>.<stage apex>` itself, every member under a path of it. Either way
//              one record covers a stage's members, members added later included, and a move
//              changes ONE record per stage.
//
// THE STAGE IS THE ZONE (`<stage>.<unitApex>`, and the apex itself for prod), and the apex is the
// target cluster's own (global.unitApex off its values chain). Two clusters may well share one apex — install.sh defaults
// `unit-apex` to the FQDN minus its first label precisely so a unit KEEPS its address when it moves
// between two clusters in one zone — and under a shared apex two stages of one unit are two records
// in two zones, so both may stand in one installation and on one cluster. What the name does NOT separate
// is two CLUSTERS claiming the same stage of one unit: the host can answer for exactly one cluster,
// so provisionUnitDns REFUSES a host whose record already points at ANOTHER CLUSTER OF THIS
// INSTALLATION. A standing record that points at no cluster of this installation is a different
// thing: only this installation's token writes the zone, so such a record is what an installation
// that is gone left behind (its machines restored bare, its units never offboarded — measured on
// 2026-09-15, post.digitacloud.app still at the abandoned apps4 when apps7 onboarded the same unit),
// and it is REPLACED, with the log saying what stood there. An address record under a unit's host is
// always such a record, because no unit record of this Manager is one. readStandingHost is the one
// reading of that difference; gate G27 (gates/compose.ts) takes it BEFORE the run writes anything, and
// provision-dns takes it again at its own step (hostyour-manager#151).
//
// The record's CONTENT is the target cluster's FQDN — a CNAME, never an address. The cluster's name
// is the one authority for where it is reachable, and DNS resolves it, so a cluster whose name is
// itself a CNAME serves its units through the same chain: a master identity `master.<apex>` onto one
// of two machines keeps every unit record when the identity moves, and the failover is that one
// record. A move between clusters is a content update of this one record, and the relocation's
// switch is the ONE caller that repoints a record from another cluster of this installation.
// Certificates are unaffected: HTTP-01 only requires that every certificate host resolves, which the
// record (or the wildcard) provides.
//
// Every step here is fail-CLOSED — an unwired provider or an API failure breaks the run, in the
// removal run kinds too: "no address is left pointing nowhere" holds without exception, and purge is the
// run kind that runs after failed offboards, exactly where the leftovers would appear. Absent records
// are the idempotent no-op (delete-by-(name,type) resolves 0).
//
// EVERY WRITE AND EVERY REMOVAL IS ENTERED INTO THE BOOK OF DNS WRITES (db/dns-writes.ts), which is
// what the DNS page shows first: a record inserted or updated here is a row, and the removal takes
// the row out beside the record. A write that found the record already pointing at the target
// changed nothing and enters nothing — the book says what this Manager changed, not what it was asked.
import type { StepCtx } from "#core/server/executor/types.ts";
import type { Db } from "#core/server/db/client.ts";
import { eq } from "drizzle-orm";
import { clusters } from "#core/server/db/schema/inventory.ts";
import { findDnsWrite, forgetDnsWrite, listDnsWrites, recordDnsWrite } from "#core/server/db/dns-writes.ts";
import type { DnsProvider } from "#core/server/adapters/dns/port.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import type { DnsWriteOwnerKind, Stage } from "#core/shared/enums.ts";

// A CONSUMER'S HOST LABEL AND A TENANT SUBDOMAIN ARE ONE NAME SPACE. Both stand as a single DNS
// label directly under a stage zone: the consumer serves `<label>.<stage apex>`, and the tenant's
// members sit one level below `<subdomain>.<stage apex>`. That parent is not merely the tenant's wildcard root —
// it is the Domain its IdP scopes every session cookie to (`example-auth.cookieDomain` in
// catalog/charts/example-auth/templates/_helpers.tpl, delivered as AUTH_COOKIE_DOMAIN and set
// on the access and refresh cookies in example-auth/backend/src/auth/cookies.ts). A browser sends a
// cookie to every host at or below its Domain, so a consumer labelled `<subdomain>` would stand on
// the very host a tenant's cookies reach for. Both onboarding run kinds therefore hold their candidate
// against the other side's set: gate G23 refuses a consumer label a tenant already stands on
// (gates/compose.ts), and the create-tenant step ensure-subdomain-free refuses a subdomain a consumer
// already holds (tenant-replace.ts).

/** The compositions themselves live in plugins/unit/shared/unit-host.ts — ONE place for the Manager and, by the
 *  same strings, for hostyour-cloud's ApplicationSets — and are re-exported here for the callers of
 *  this module: a consumer stands at `<label>.<stage apex>`, a tenant's members at
 *  `<member>.<subdomain>.<stage apex>` under ONE wildcard PER STAGE (host routing) or at
 *  `<subdomain>.<stage apex>/<member>` under ONE record for the zone (path routing). The label is
 *  the registration's / the row's `host`, never the name (simetrixch/hostyour-cloud#208). */
export { consumerUnitHost, tenantMemberUrl, tenantRecordName, tenantWildcardHost, tenantZone, stageApex } from "../shared/unit-host.ts";

function requireDns(dns: DnsProvider | undefined, unit: string, runKind: string): DnsProvider {
  if (!dns) {
    throw errValidation(
      `${runKind} "${unit}" requires the DNS provider but none is wired on this manager (CLOUDFLARE_DNS_API_TOKEN unset) — DNS is a mandatory part of this run kind, never a silent skip`,
    );
  }
  return dns;
}

/** What stands under a unit's host now, read against this installation's own clusters. */
export type StandingHost =
  /** No record stands under the host. */
  | { kind: "free" }
  /** A CNAME onto the target cluster already stands — a re-run, never a takeover. */
  | { kind: "ours" }
  /** A CNAME onto ANOTHER cluster of this installation: one stage of a unit has one host, and that
   *  cluster serves it. Refused wherever it is read, except by the switch that repoints it. */
  | { kind: "collision"; cluster: string }
  /** A record that points at no cluster of this installation — a CNAME onto a foreign name, or an
   *  address record: what an installation that is gone left in the zone. Replaced by provision-dns,
   *  and said so. */
  | { kind: "leftover"; type: "A" | "CNAME"; content: string };

/** The unit's host as the DNS provider answers it now, judged against the installation's own
 *  clusters by NAME — a CNAME names one of them or it does not, and no address is read. The one
 *  reading gate G27 and the provision-dns step both take. */
export async function readStandingHost(
  dns: DnsProvider,
  db: Db,
  opts: { recordName: string; clusterFqdn: string; signal: AbortSignal },
): Promise<StandingHost> {
  const named = await dns.readRecordContent({ name: opts.recordName, type: "CNAME", signal: opts.signal });
  if (named === null) {
    const address = await dns.readRecordContent({ name: opts.recordName, type: "A", signal: opts.signal });
    return address === null ? { kind: "free" } : { kind: "leftover", type: "A", content: address };
  }
  if (named === opts.clusterFqdn) return { kind: "ours" };
  const other = db.select({ domain: clusters.domain }).from(clusters).where(eq(clusters.domain, named)).get();
  return other ? { kind: "collision", cluster: other.domain } : { kind: "leftover", type: "CNAME", content: named };
}

/** G27's input: the unit's host as the provider answers it now, judged against the installation's own
 *  clusters. Bound by the caller to the provider and the inventory through standingHostFrom. */
export type StandingHostReader = (host: string, clusterFqdn: string) => Promise<StandingHost>;

/** G27's reader, bound to the DNS provider and the inventory — the same reading provision-dns takes
 *  at its own step. Empty where the Manager has no provider, so the gate says so. Shared by the
 *  consumer planner (validate.ts) and the tenant planner (validate-tenant.ts). */
export function standingHostFrom(dns: DnsProvider | undefined, db: Db, signal: AbortSignal): { standingHost?: StandingHostReader } {
  if (!dns) return {};
  return { standingHost: (host, clusterFqdn) => readStandingHost(dns, db, { recordName: host, clusterFqdn, signal }) };
}

/** The sentence a collision is refused with, the same at the gate and at the step. */
export function standingHostRefusal(recordName: string, unit: string, judged: { cluster: string }): string {
  return (
    `the host ${recordName} already points at ${judged.cluster}, a cluster of this installation — ` +
    `refusing to point "${unit}" at a second cluster: one stage of a unit has ONE host, and that cluster serves it. ` +
    `Offboard the unit there first, or give the two clusters different unit_apex answers.`
  );
}

/** Create (or move onto the current cluster) the unit's ONE record. Shared by the consumer
 *  onboard and create-tenant provision-dns steps AND by the relocation switch-dns (a move IS a
 *  content update of exactly this record) — the caller composes the record name per kind and names
 *  its run kind for the refusal message. */
export async function provisionUnitDns(
  ctx: StepCtx,
  opts: {
    dns: DnsProvider | undefined;
    /** The unit's one identity, which is also the owner name the book records: a consumer's name,
     *  a tenant's guid. */
    unit: string;
    /** Which kind of unit the record belongs to, and the stage it stands at — the owner the book
     *  carries beside the record, so the DNS page can say whose write a row is. */
    kind: Extract<DnsWriteOwnerKind, "consumer" | "tenant">;
    stage: Stage;
    recordName: string;
    clusterFqdn: string;
    /** The run kind the refusal message names. REQUIRED and never defaulted: this step is shared by
     *  consumer-onboard, tenant-create and the two relocation run kinds, so a default would put one
     *  of their names on the other three's refusal. */
    runKind: string;
    /** The MOVE alone. switch-dns repoints a record the unit already owns from the source cluster
     *  onto the target, so a record pointing at another cluster of this installation IS what the
     *  step changes. Every other caller is putting a unit onto a cluster for the first time and must
     *  not take a host off the cluster that serves it — see the host-collision paragraph in this
     *  module's header. */
    repoint?: boolean;
  },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, opts.runKind);
  const target = opts.clusterFqdn;
  // Read before write, in every case: upsertRecord overwrites the first match in place and answers
  // only whether it created, so what stood there is known nowhere else — a takeover would leave no
  // trace in the run, a leftover replaced without a word would leave none, and the book could not
  // tell a write that changed the record from one that found it already pointing at the target.
  const standing = await readStandingHost(dns, ctx.db, { recordName: opts.recordName, clusterFqdn: target, signal: ctx.signal });
  if (standing.kind === "collision" && !opts.repoint) {
    throw errValidation(standingHostRefusal(opts.recordName, opts.unit, standing));
  }
  if (standing.kind === "leftover") {
    ctx.log(
      "meta",
      `the host ${opts.recordName} stood as ${standing.type} ${standing.content}, which points at no cluster of this installation — what an installation that is gone left in the zone; replaced with a CNAME onto ${target}`,
    );
    // A CNAME stands alone under its name, so the address record goes before it is written.
    if (standing.type === "A") await dns.deleteRecord({ name: opts.recordName, type: "A", signal: ctx.signal });
  }
  const { created } = await dns.upsertRecord({ name: opts.recordName, type: "CNAME", content: target, signal: ctx.signal });
  ctx.checkpoint({ record: opts.recordName, content: target, created });
  ctx.log(
    "meta",
    `DNS record ${opts.recordName} → CNAME ${target} ${created ? "created" : "updated in place"} — the unit follows its cluster's name, and a move is a content update of exactly this record`,
  );
  if (standing.kind !== "ours") {
    recordDnsWrite(ctx.db, {
      name: opts.recordName, type: "CNAME", content: target, act: standing.kind === "free" ? "inserted" : "updated",
      owner: { kind: opts.kind, name: opts.unit, stage: opts.stage }, runId: ctx.runId,
    });
  }
}

/** The unit a record of the book of DNS writes belongs to: its kind, its name (a consumer's name, a
 *  tenant's guid) and, where given, the stage it stands at. */
export interface BookedOwner {
  kind: DnsWriteOwnerKind;
  name: string;
  stage?: Stage;
}

const bookedFor = (booked: { kind: string; name: string; stage?: Stage }, owner: BookedOwner): boolean =>
  booked.kind === owner.kind && booked.name === owner.name && (owner.stage === undefined || booked.stage === owner.stage);

/** Whether the book of DNS writes names `owner` as the writer of the CNAME `recordName`. */
export function isBookedFor(db: Db, recordName: string, owner: BookedOwner): boolean {
  const booked = findDnsWrite(db, { name: recordName, type: "CNAME" });
  return booked !== null && bookedFor(booked.owner, owner);
}

/** Whether a record a tenant's purge may name is the tenant's own. A wildcard is: only a tenant ever
 *  writes one. A plain name is a host another unit may hold, so it is the tenant's only where the book
 *  of DNS writes names the tenant as its owner. */
export function isTenantRecord(db: Db, recordName: string, guid: string): boolean {
  return recordName.startsWith("*.") || isBookedFor(db, recordName, { kind: "tenant", name: guid });
}

/** Remove ONE CNAME the book of DNS writes names as `owner`'s, only while it still carries the
 *  content the book recorded: one re-pointed elsewhere since is somebody else's now, and stays. Answers
 *  false where the book does not name the record `owner`'s, and removes nothing then. */
export async function removeBookedRecord(ctx: StepCtx, opts: { dns: DnsProvider | undefined; owner: BookedOwner; recordName: string }): Promise<boolean> {
  const w = findDnsWrite(ctx.db, { name: opts.recordName, type: "CNAME" });
  if (w === null || !bookedFor(w.owner, opts.owner)) return false;
  const dns = requireDns(opts.dns, opts.owner.name, "remove");
  const { deleted } = await dns.deleteRecord({ name: w.name, type: "CNAME", content: w.content, signal: ctx.signal });
  forgetDnsWrite(ctx.db, { name: w.name, type: "CNAME" });
  ctx.log("meta", deleted > 0 ? `DNS record ${w.name} → ${w.content} removed` : `DNS record ${w.name} no longer points at ${w.content} — left standing, it is not this ${opts.owner.kind}'s any more`);
  return true;
}

/** Remove every other CNAME the book of DNS writes names as `owner`'s at its stage — its own
 *  domain's record where this installation wrote it — beside the records the caller removes itself
 *  (`except`). Offboard and purge. A record is deleted only while it still carries the content the
 *  book recorded: one re-pointed elsewhere since is somebody else's now, and stays. */
export async function removeBookedRecords(ctx: StepCtx, opts: { dns: DnsProvider | undefined; owner: BookedOwner & { stage: Stage }; except: readonly string[] }): Promise<void> {
  const booked = listDnsWrites(ctx.db).filter((w) => w.type === "CNAME" && bookedFor(w.owner, opts.owner) && !opts.except.includes(w.name));
  for (const w of booked) await removeBookedRecord(ctx, { dns: opts.dns, owner: opts.owner, recordName: w.name });
}

/** Remove the unit's ONE record (offboard + both purge run kinds). Fail-closed on the API, absent=ok:
 *  a unit whose run died before provision-dns simply deletes nothing. */
export async function removeUnitDns(
  ctx: StepCtx,
  opts: { dns: DnsProvider | undefined; unit: string; recordName: string },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, "remove");
  const { deleted } = await dns.deleteRecord({ name: opts.recordName, type: "CNAME", signal: ctx.signal });
  forgetDnsWrite(ctx.db, { name: opts.recordName, type: "CNAME" });
  ctx.checkpoint({ record: opts.recordName, deleted });
  ctx.log(
    "meta",
    deleted > 0
      ? `DNS record ${opts.recordName} removed (${deleted}) — no address is left pointing nowhere`
      : `no DNS record ${opts.recordName} to remove — already absent`,
  );
}
