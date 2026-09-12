// The unit's ONE public DNS record (the address belongs to the unit, not to the server) —
// provisioned at onboard/create-tenant, removed at offboard AND at both purge run kinds, over the
// DnsProvider port (adapters/dns). One record per unit STANDING AT A STAGE, by kind of unit:
//
//   consumer — A `<label>.<stage apex>`. The chart renders exactly ONE host, and by DNS rule a
//              wildcard does NOT cover a bare label, so the record is the host itself.
//   tenant   — wildcard A `*.<subdomain>.<stage apex>`, one PER STAGE. Every member sits exactly one
//              level below (`<member>.<subdomain>.<stage apex>`, nothing lives on the bare zone), so
//              one wildcard covers a stage's members — members added later included — and a move
//              changes ONE record per stage.
//
// THE STAGE IS THE ZONE (`<stage>.<unitApex>`, and the apex itself for prod), and the apex is the
// target cluster's own (global.unitApex off its values chain). Two clusters may well share one apex — install.sh defaults
// `unit-apex` to the FQDN minus its first label precisely so a unit KEEPS its address when it moves
// between two clusters in one zone — and under a shared apex two stages of one unit are two records
// in two zones, so both may stand in one installation and on one cluster. What the name does NOT separate
// is two CLUSTERS claiming the same stage of one unit: the host can answer for exactly one cluster,
// so provisionUnitDns REFUSES a host that already answers with another cluster's address. A standing
// record at another address is a takeover, whatever put it there.
//
// The record's CONTENT is the target cluster's address, READ off the cluster's own A record (its
// FQDN resolves to the machine that serves it) — never computed. A move is then a content update of
// this one record and nothing else, and it is the ONE caller that overwrites a foreign address.
// Certificates are unaffected: HTTP-01 only requires that every certificate host resolves, which the
// record (or the wildcard) provides.
//
// Every step here is fail-CLOSED — an unwired provider or an API failure breaks the run, in the
// removal run kinds too: "no address is left pointing nowhere" holds without exception, and purge is the
// run kind that runs after failed offboards, exactly where the leftovers would appear. Absent records
// are the idempotent no-op (delete-by-(name,type) resolves 0).
import type { StepCtx } from "../../executor/types.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { errValidation } from "../../kernel/errors.ts";

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

/** The compositions themselves live in shared/unit-host.ts — ONE place for the Manager and, by the
 *  same strings, for hostyour-cloud's ApplicationSets — and are re-exported here for the callers of
 *  this module: a consumer stands at `<label>.<stage apex>`, a tenant's members at
 *  `<member>.<subdomain>.<stage apex>`, under ONE wildcard PER STAGE (the zones differ). The label is
 *  the registration's / the row's `host`, never the name (simetrixch/hostyour-cloud#208). */
export { consumerUnitHost, tenantMemberHost, tenantWildcardHost, tenantZone, stageApex } from "../../../shared/unit-host.ts";

function requireDns(dns: DnsProvider | undefined, unit: string, runKind: string): DnsProvider {
  if (!dns) {
    throw errValidation(
      `${runKind} "${unit}" requires the DNS provider but none is wired on this manager (CLOUDFLARE_DNS_API_TOKEN unset) — DNS is a mandatory part of this run kind, never a silent skip`,
    );
  }
  return dns;
}

/** The target cluster's address: the content of ITS own A record. The cluster's FQDN is the one
 *  authority for where the cluster is reachable, so the unit record copies it rather than computing
 *  an address from inventory. Fail-closed: a cluster without an address record can serve nothing. */
async function resolveClusterAddress(dns: DnsProvider, clusterFqdn: string, signal: AbortSignal): Promise<string> {
  const content = await dns.readRecordContent({ name: clusterFqdn, type: "A", signal });
  if (content === null) {
    throw errValidation(`the target cluster ${clusterFqdn} has no A record of its own — there is no address to point the unit's record at`);
  }
  return content;
}

/** Create (or move onto the current cluster address) the unit's ONE record. Shared by the consumer
 *  onboard and create-tenant provision-dns steps AND by the relocation switch-dns (a move IS a
 *  content update of exactly this record) — the caller composes the record name per kind and names
 *  its run kind for the refusal message. */
export async function provisionUnitDns(
  ctx: StepCtx,
  opts: {
    dns: DnsProvider | undefined;
    unit: string;
    recordName: string;
    clusterFqdn: string;
    /** The run kind the refusal message names. REQUIRED and never defaulted: this step is shared by
     *  consumer-onboard, tenant-create and the two relocation run kinds, so a default would put one
     *  of their names on the other three's refusal. */
    runKind: string;
    /** The MOVE alone. switch-dns repoints a record the unit already owns onto the target cluster,
     *  so overwriting an address that is not the target's IS the step. Every other caller is putting
     *  a unit onto a cluster for the first time and must not take a live address off whatever answers
     *  there now — see the host-collision paragraph in this module's header. */
    overwriteAddress?: boolean;
  },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, opts.runKind);
  const address = await resolveClusterAddress(dns, opts.clusterFqdn, ctx.signal);
  if (!opts.overwriteAddress) {
    // Read before write, because upsertRecord overwrites the first match in place and reports it as
    // the benign "updated in place": the takeover would leave no trace anywhere in the run.
    const standing = await dns.readRecordContent({ name: opts.recordName, type: "A", signal: ctx.signal });
    if (standing !== null && standing !== address) {
      throw errValidation(
        `the host ${opts.recordName} already answers with ${standing}, and ${opts.clusterFqdn} is at ${address} — refusing to point "${opts.unit}" at a cluster the address does not serve. ` +
          `The record name carries the unit's stage, and a cluster's unitApex is global.unitApex in its own installation/profile.yaml, stamped from the unit_apex answer when its install branch is generated — so two clusters in one zone give one stage of a unit ONE host, not two. ` +
          `Overwriting it would move whatever serves ${opts.recordName} today onto this cluster without deploying it there: a standing record at another address is a takeover. ` +
          `Remove the standing record if nothing serves it any more, or give the two clusters different unit_apex answers.`,
      );
    }
  }
  const { created } = await dns.upsertRecord({ name: opts.recordName, type: "A", content: address, signal: ctx.signal });
  ctx.checkpoint({ record: opts.recordName, content: address, created });
  ctx.log(
    "meta",
    `DNS record ${opts.recordName} → ${address} ${created ? "created" : "updated in place"} — the unit's address is its own, and a move is a content update of exactly this record`,
  );
}

/** Remove the unit's ONE record (offboard + both purge run kinds). Fail-closed on the API, absent=ok:
 *  a unit whose run died before provision-dns simply deletes nothing. */
export async function removeUnitDns(
  ctx: StepCtx,
  opts: { dns: DnsProvider | undefined; unit: string; recordName: string },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, "remove");
  const { deleted } = await dns.deleteRecord({ name: opts.recordName, type: "A", signal: ctx.signal });
  ctx.checkpoint({ record: opts.recordName, deleted });
  ctx.log(
    "meta",
    deleted > 0
      ? `DNS record ${opts.recordName} removed (${deleted}) — no address is left pointing nowhere`
      : `no DNS record ${opts.recordName} to remove — already absent`,
  );
}
