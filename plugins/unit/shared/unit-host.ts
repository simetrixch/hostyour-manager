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

/** A domain's host at one stage: the labels below the DNS zone that holds it, then the stage, then
 *  the zone, as `stageApex` puts the stage before the apex (`show.simetrix.ch` at test is
 *  `show.test.simetrix.ch`, the zone itself `test.simetrix.ch`). Prod is the host itself. The zone is
 *  the one the installation's DNS provider resolves for the host, never its last two labels: a zone
 *  can be `example.co.uk`, or delegated below. */
export function stageHost(prodHost: string, zone: string, stage: Stage): string {
  if (stage === "prod") return prodHost;
  return prodHost === zone ? `${stage}.${zone}` : `${prodHost.slice(0, -(zone.length + 1))}.${stage}.${zone}`;
}

/** The prod host a host of `stage` stands for, or null where the stage does not stand directly
 *  before `zone`. The inverse of `stageHost`. */
export function prodHostOf(host: string, zone: string, stage: Stage): string | null {
  if (stage === "prod") return host;
  const stageZone = `${stage}.${zone}`;
  if (host === stageZone) return zone;
  return host.endsWith(`.${stageZone}`) ? `${host.slice(0, -(stageZone.length + 1))}.${zone}` : null;
}

/** Why `host` is no host of `stage` under `zone`, naming the host it would be, or null: a dev or test
 *  host ends in `.<stage>.<zone>` (or is `<stage>.<zone>`), and a prod host carries no stage label
 *  directly before its zone. */
export function stageHostProblem(host: string, zone: string, stage: Stage): string | null {
  const carried = STAGE.find((s) => s !== "prod" && prodHostOf(host, zone, s) !== null);
  if (stage === "prod") {
    return carried === undefined ? null : `${host} carries the stage ${carried} before its zone ${zone}, and prod carries none: it is ${prodHostOf(host, zone, carried)}`;
  }
  if (prodHostOf(host, zone, stage) !== null) return null;
  // The prod host it stands for: one with another stage before the zone drops that stage, and one
  // with the stage in front of the whole name drops that label.
  const prod = carried !== undefined ? prodHostOf(host, zone, carried)! : host.startsWith(`${stage}.`) && host !== `${stage}.${zone}` ? host.slice(stage.length + 1) : host;
  return `${host} is no ${stage} host: the stage stands directly before the zone ${zone}, so it is ${stageHost(prod, zone, stage)}`;
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

/** The TXT record that marks a tenant's identity provider for the product's mail service: named
 *  `<label>.<issuer host>` and holding the issuer, which is the identity provider member's address on
 *  the tenant's ZONE and never on its own domain. The zone lies under a stage apex this platform alone
 *  writes, while a customer controls the DNS of its own domain, so only a mark under the zone can be
 *  trusted. The label is the product's (tenant spec `issuerRecordLabel`). */
export function tenantIssuerRecord(label: string, routing: MemberRouting, identityProvider: string, stage: Stage, subdomain: string, unitApex: string): { name: string; content: string } {
  const issuer = tenantMemberUrl(routing, identityProvider, stage, subdomain, unitApex, "");
  return { name: `${label}.${new URL(issuer).host}`, content: issuer };
}

/** The host that needs an address record of its own beside a tenant's identity provider mark: the
 *  issuer host under `host` routing, where the mark makes it an empty non-terminal below the tenant's
 *  wildcard, and RFC 4592 lets no wildcard answer a name that exists; null under `path` routing, whose
 *  issuer host is the zone, which holds the tenant's own record. Read from the issuer the mark holds, so
 *  a mark in the book of DNS writes says it without the tenant's routing. */
export function issuerAddressHost(issuer: string): string | null {
  const url = new URL(issuer);
  return url.pathname === "/" ? url.host : null;
}

/** Every host a tenant answers at beside its zone: its own domain, the hosts that redirect to it, and
 *  its alias domains with their `www.`; none without an own domain. */
export function tenantOwnHosts(ownDomain: string, ownDomainRedirects: readonly string[], ownDomainAliases: readonly string[] = []): string[] {
  return ownDomain === "" ? [] : [...new Set([ownDomain, ...ownDomainRedirects, ...aliasHosts(ownDomainAliases)])];
}

/** The hosts alias domains answer at: each alias, typed without `www.`, and its `www.`. */
export function aliasHosts(aliases: readonly string[]): string[] {
  return aliases.flatMap((a) => [a, `www.${a}`]);
}

/** The own hosts an operator's domain entry gives a tenant: the domain is typed without `www.`, the
 *  tenant is served at `<domain>`, and `www.<domain>` redirects there. "" gives none, which returns
 *  the tenant to its zone. The entry is checked by the caller (ownDomainEntryProblem). */
export function ownDomainHosts(domain: string): { ownDomain: string; ownDomainRedirects: string[] } {
  return domain === "" ? { ownDomain: "", ownDomainRedirects: [] } : { ownDomain: domain, ownDomainRedirects: [`www.${domain}`] };
}

/** Why a domain entry cannot be taken, or null: it is typed without `www.`, because the Manager adds it. */
export function ownDomainEntryProblem(domain: string): string | null {
  return domain.startsWith("www.") ? `type the domain without "www." (${domain.slice(4)}); it is served at ${domain.slice(4)}, and ${domain} redirects there` : null;
}

/** The words no label and no subdomain may be: the stage words are the zones themselves, so a
 *  consumer labelled `dev` at prod would stand on the dev zone's apex. */
export const RESERVED_HOST_LABELS: readonly string[] = STAGE;

/** The labels the platform and the website stand on directly under the apex, beside the prod units:
 *  the website's hosts, the mail records and the machines (`master*`, `apps*`, `srv*`, and the
 *  `enterprise*` records of the mail service). A unit on one of them would take the platform's name. */
export const PLATFORM_HOST_LABEL = /^(www|show|mail|autodiscover)$|^(master|apps|srv|enterprise)/;

/** One DNS label, lower-case, at most 63 characters, neither starting nor ending in a hyphen. */
export const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
