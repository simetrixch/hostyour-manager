import { STAGE, type MemberRouting, type Stage } from "#core/shared/enums.ts";

/** THE ONE PLACE A UNIT'S PUBLIC HOST IS COMPOSED (simetrixch/hostyour-cloud#208).
 *
 *  A stage is a ZONE and prod is the apex itself: `stageApex` is `<unitApex>` for prod and
 *  `<stage>.<unitApex>` for the other two. A consumer stands at `<label>.<stage apex>`, a tenant's
 *  members at `<member>.<subdomain>.<stage apex>`, and everything that has to agree with an ingress —
 *  the DNS record, the admission fence, the gates, the activation URL, the relocation probe — reads
 *  it from here. hostyour-cloud's ApplicationSets compose the same strings for the charts they
 *  deliver to (`unitHost`, `global.stageApex`, `tenant.zone`), so a chart composes no host at all.
 *
 *  WHY THE STAGE IS A ZONE AND NOT A SUFFIX. An identity provider sets its session cookie with the
 *  zone as its Domain so sibling units share the sign-in; a suffix (`<name>-<stage>.<apex>`) puts
 *  dev, test and prod on ONE cookie domain, a zone gives each stage its own. And prod is the apex
 *  because a public name carries nothing a reader does not need: `auth.digitacloud.app`.
 *
 *  THE LABEL IS NOT THE NAME. A unit's identity — namespace, Application, Vault path, image names —
 *  stays `<name>` and `<name>-<stage>`; the label is the manifest's `host` (default the name) and
 *  is held against every other label and every tenant subdomain at the same stage apex, because
 *  under one zone they are one name space. */

/** The zone of one stage under the installation's unit apex. */
export function stageApex(unitApex: string, stage: Stage): string {
  return stage === "prod" ? unitApex : `${stage}.${unitApex}`;
}

/** A consumer's one public host at one stage: `<label>.<stage apex>`. */
export function consumerUnitHost(label: string, stage: Stage, unitApex: string): string {
  return `${label}.${stageApex(unitApex, stage)}`;
}

/** The zone a tenant's members stand one level below at one stage: `<subdomain>.<stage apex>`. */
export function tenantZone(subdomain: string, stage: Stage, unitApex: string): string {
  return `${subdomain}.${stageApex(unitApex, stage)}`;
}

/** The tenant's one wildcard at one stage, covering every member host below its zone. One record
 *  PER STAGE now: the zones differ, so one wildcard cannot cover them all. */
export function tenantWildcardHost(subdomain: string, stage: Stage, unitApex: string): string {
  return `*.${tenantZone(subdomain, stage, unitApex)}`;
}

/** The ONE DNS record a package's members need at one stage, by their routing: `host` routing puts
 *  every member on a host of its own below the zone, which the wildcard covers; `path` routing
 *  serves every member under a path of the zone itself, which is a name the wildcard does NOT cover
 *  (a wildcard matches one label more, never the zone). */
export function tenantRecordName(routing: MemberRouting, subdomain: string, stage: Stage, unitApex: string): string {
  return routing === "path" ? tenantZone(subdomain, stage, unitApex) : tenantWildcardHost(subdomain, stage, unitApex);
}

/** ONE member's public base URL at one stage, for the callers that must ADDRESS a member rather than
 *  resolve it (the first-admin invite over the identity provider, the administrator check, the
 *  relocation probe): `https://<member>.<zone>` under `host` routing, `https://<host>/<member>` under
 *  `path` routing, where the host is the tenant's own domain if it has one ("" = none) and its zone
 *  otherwise. A caller appends its API path to it. */
export function tenantMemberUrl(routing: MemberRouting, member: string, stage: Stage, subdomain: string, unitApex: string, ownDomain: string): string {
  const zone = tenantZone(subdomain, stage, unitApex);
  return routing === "path" ? `https://${ownDomain || zone}/${member}` : `https://${member}.${zone}`;
}

/** Every host a tenant answers at beside its zone: its own domain and the hosts that redirect to it;
 *  none without an own domain. */
export function tenantOwnHosts(ownDomain: string, ownDomainRedirects: readonly string[]): string[] {
  return ownDomain === "" ? [] : [ownDomain, ...ownDomainRedirects];
}

/** The own hosts an operator's domain entry gives a tenant: the domain is typed without `www.`, the
 *  tenant is served at `www.<domain>`, and `<domain>` redirects there. "" gives none, which returns
 *  the tenant to its zone. The entry is checked by the caller (ownDomainEntryProblem). */
export function ownDomainHosts(domain: string): { ownDomain: string; ownDomainRedirects: string[] } {
  return domain === "" ? { ownDomain: "", ownDomainRedirects: [] } : { ownDomain: `www.${domain}`, ownDomainRedirects: [domain] };
}

/** Why a domain entry cannot be taken, or null: it is typed without `www.`, because the Manager adds it. */
export function ownDomainEntryProblem(domain: string): string | null {
  return domain.startsWith("www.") ? `type the domain without "www." (${domain.slice(4)}); the tenant is served at ${domain} and ${domain.slice(4)} redirects there` : null;
}

/** The words no label and no subdomain may be: the stage words are the zones themselves, so a
 *  consumer labelled `dev` at prod would stand on the dev zone's apex. */
export const RESERVED_HOST_LABELS: readonly string[] = STAGE;

/** One DNS label, lower-case, at most 63 characters, neither starting nor ending in a hyphen. */
export const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
