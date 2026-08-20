// The unit's ONE public DNS record (the address belongs to the unit, not to the server) —
// provisioned at onboard/create-tenant, removed at offboard AND at both purge run kinds, over the
// DnsProvider port (adapters/dns). One record per unit STANDING AT A STAGE, by kind of unit:
//
//   consumer — A `<name>.<unitApex>`. The chart renders exactly ONE host, and by DNS rule a
//              wildcard does NOT cover the bare name, so the record is the name itself.
//   tenant   — wildcard A `*.<subdomain>.<unitApex>`. Every member sits exactly one level below
//              (auth./erp./web. …, nothing lives on the bare <subdomain>), so ONE wildcard covers
//              them all — members added later included — and a move changes ONE record.
//
// NEITHER NAME CARRIES A STAGE, and the apex is the target cluster's own (global.unitApex off its
// values chain). Two clusters may well share one apex — install.sh defaults `unit-apex` to the FQDN
// minus its first label precisely so a unit KEEPS its address when it moves between two clusters in
// one zone — and under a shared apex both stages of a unit compose the identical host. That host can
// answer for exactly one cluster, and the consumer chart's ingress and the admission policy pin the
// same stage-free host on both, so the second stage would not become reachable, it would take the
// first stage's address away. provisionUnitDns therefore REFUSES a host that already answers with
// another cluster's address: a unit gets a second stage only where the two clusters' apexes differ,
// and then the two records are two different names. That refusal is what makes the record a PER-STAGE
// object for every teardown (offboard.run.ts SCOPE) even though its name states no stage.
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

// A CONSUMER NAME AND A TENANT SUBDOMAIN ARE ONE NAME SPACE. Both stand as a single DNS label
// directly under the apex: the consumer IS `<name>.<unitApex>`, and the tenant's members sit one
// level below `<subdomain>.<unitApex>`. That parent is not merely the tenant's wildcard root — it is
// the Domain its IdP scopes every session cookie to (`example-auth.cookieDomain` in
// catalog/charts/example-auth/templates/_helpers.tpl, delivered as AUTH_COOKIE_DOMAIN and set
// on the access and refresh cookies in example-auth/backend/src/auth/cookies.ts). A browser sends a
// cookie to every host at or below its Domain, so a consumer standing on a tenant's label is handed
// that tenant's users' sessions by their own browsers, with nothing in the tenant compromised. Both
// onboarding run kinds therefore hold their candidate against the other side's set: gate G23 refuses a
// consumer name a tenant already stands on (gates/compose.ts), and the create-tenant step
// ensure-subdomain-free refuses a subdomain a consumer already holds (tenant-replace.ts).

/** The consumer's one public host — the same composition the admission policy pins. */
export function consumerUnitHost(consumerName: string, unitApex: string): string {
  return `${consumerName}.${unitApex}`;
}

/** The tenant's one wildcard — covering every member host `<member>.<subdomain>.<unitApex>`. */
export function tenantWildcardHost(subdomain: string, unitApex: string): string {
  return `*.${subdomain}.${unitApex}`;
}

/** ONE member's own public host — a single name the wildcard above covers, for the callers that must
 *  ADDRESS a member rather than resolve it (the first-admin invite over the tenant's example-auth, the
 *  relocation probe). The three parts are exactly what the member charts render: every tenant-mode
 *  ingress host in catalog is `<member>.<tenant.subdomain>.<global.unitApex>`
 *  (charts/example-auth/templates/_helpers.tpl and its jobs/report/ui/web siblings, each of which
 *  `required`s the apex). Composing from the cluster's own domain instead names a host no ingress
 *  serves and no record resolves, because install.sh defaults `unit-apex` to the cluster FQDN minus
 *  its first label — so the two differ on every cluster that is not itself the apex. */
export function tenantMemberHost(member: string, subdomain: string, unitApex: string): string {
  return `${member}.${subdomain}.${unitApex}`;
}

function requireDns(dns: DnsProvider | undefined, unit: string, runKind: string): DnsProvider {
  if (!dns) {
    throw errValidation(
      `${runKind} "${unit}" requires the DNS provider but none is wired on this controller (CLOUDFLARE_DNS_API_TOKEN unset) — DNS is a mandatory part of this run kind, never a silent skip`,
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
    runKind?: string;
    /** The MOVE alone. switch-dns repoints a record the unit already owns onto the target cluster,
     *  so overwriting an address that is not the target's IS the step. Every other caller is putting
     *  a unit onto a cluster for the first time and must not take a live address off whatever answers
     *  there now — see the host-collision paragraph in this module's header. */
    overwriteAddress?: boolean;
  },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, opts.runKind ?? "onboard");
  const address = await resolveClusterAddress(dns, opts.clusterFqdn, ctx.signal);
  if (!opts.overwriteAddress) {
    // Read before write, because upsertRecord overwrites the first match in place and reports it as
    // the benign "updated in place": the takeover would leave no trace anywhere in the run.
    const standing = await dns.readRecordContent({ name: opts.recordName, type: "A", signal: ctx.signal });
    if (standing !== null && standing !== address) {
      throw errValidation(
        `the host ${opts.recordName} already answers with ${standing}, and ${opts.clusterFqdn} is at ${address} — refusing to point "${opts.unit}" at a cluster the address does not serve. ` +
          `The host carries no stage: it is <unit>.<unitApex>, and a cluster's unitApex is global.unitApex in its own installation/profile.yaml, stamped from the unit_apex answer when its install branch is generated — so two clusters in one zone give a unit ONE host, not two. ` +
          `Overwriting it would move whatever serves ${opts.recordName} today onto this cluster without deploying it there. ` +
          `Give the two clusters different unit_apex answers if this unit is to stand at both, or remove the standing record if nothing serves it any more.`,
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
