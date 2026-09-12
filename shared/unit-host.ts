import { STAGE, type Stage } from "./enums.ts";

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

/** ONE member's own public host at one stage — a single name the wildcard above covers, for the
 *  callers that must ADDRESS a member rather than resolve it (the first-admin invite over the
 *  tenant's identity provider, the relocation probe). */
export function tenantMemberHost(member: string, stage: Stage, subdomain: string, unitApex: string): string {
  return `${member}.${tenantZone(subdomain, stage, unitApex)}`;
}

/** The words no label and no subdomain may be: the stage words are the zones themselves, so a
 *  consumer labelled `dev` at prod would stand on the dev zone's apex. */
export const RESERVED_HOST_LABELS: readonly string[] = STAGE;

/** One DNS label, lower-case, at most 63 characters, neither starting nor ending in a hyphen. */
export const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
