// A UNIT'S OWN DOMAIN — a name brought from outside the installation's own names, which a unit
// answers at beside or instead of its platform name — and what a run kind that sets one shares with
// the others: the refusal of a name that is not the unit's to take, the record onto the unit's own
// platform name, and the wait for the new name's answer before the previous name's record goes.
//
// THE RECORD POINTS AT THE UNIT'S OWN PLATFORM NAME, never at a cluster: that name's record follows
// the unit through every move and cluster rename, so a record in a zone somebody else manages never
// has to change again. Where this installation's DNS provider manages the domain's zone, the record
// is written and entered into the book of DNS writes; where it does not, the run names the record
// the operator sets, and the wait after it ends once that record stands.
import type { StepCtx } from "#core/server/executor/types.ts";
import type { Db } from "#core/server/db/client.ts";
import { clusters } from "#core/server/db/schema/inventory.ts";
import { findDnsWrite, recordDnsWrite } from "#core/server/db/dns-writes.ts";
import { DnsZoneUnknownError, type DnsProvider } from "#core/server/adapters/dns/port.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import type { Stage } from "#core/shared/enums.ts";
import type { PublicProbe } from "./adapters/http-probe/port.ts";
import { isBookedFor, type BookedOwner } from "./unit-dns.ts";
import { sleep } from "./release-cycle.ts";

/** A host a unit answers at beside its platform name, and that unit as a refusal names it. */
export interface HeldHost {
  host: string;
  holder: string;
}

/** Refuse `host` as a unit's own domain where it is not one to take: a name in the platform's own
 *  name space (`apex`), a cluster's name or one below it, or a name equal to or nested with a host
 *  another unit answers at (`held`). One host carries one record, so it serves one unit; and a session
 *  cookie scoped to an outer host reaches the inner one. */
export function refuseHeldHost(db: Db, host: string, opts: { apex: string; held: readonly HeldHost[] }): void {
  if (host === opts.apex || host.endsWith(`.${opts.apex}`)) {
    throw errValidation(`${host} lies in the platform's own name space (${opts.apex}) — an own domain is a name brought from outside the installation's names`);
  }
  const cluster = db.select({ domain: clusters.domain }).from(clusters).all().map((c) => c.domain).find((d) => host === d || host.endsWith(`.${d}`));
  if (cluster !== undefined) {
    throw errValidation(`${host} lies under the cluster name ${cluster} — an own domain is a name brought from outside the installation's names`);
  }
  const taken = opts.held.find((h) => h.host === host || h.host.endsWith(`.${host}`) || host.endsWith(`.${h.host}`));
  if (taken !== undefined) throw errValidation(`${host} ${taken.host === host ? "is already" : "overlaps"} a host of ${taken.holder} (${taken.host})`);
}

/** Point the own domain `recordName` at `target`, the unit's platform name, where this installation's
 *  DNS provider manages the domain's zone, and enter the write into the book as `owner`'s. Where it
 *  does not, say which record the operator sets. A standing CNAME the book does not name `owner`'s is
 *  somebody else's and refuses the run; an address record under the name refuses it too, because a
 *  CNAME stands alone under its name. */
export async function provisionDomainRecord(
  ctx: StepCtx,
  opts: { dns: DnsProvider | undefined; owner: BookedOwner & { stage: Stage }; recordName: string; target: string },
): Promise<void> {
  const { dns, owner, recordName: domain, target } = opts;
  const operatorSets = `set CNAME ${domain} → ${target} at the provider of ${domain}; the wait below ends once the unit answers there`;
  if (!dns) {
    ctx.log("meta", `no DNS provider is configured on this manager: ${operatorSets}`);
    return;
  }
  let standing: string | null;
  try {
    standing = await dns.readRecordContent({ name: domain, type: "CNAME", signal: ctx.signal });
  } catch (e) {
    if (e instanceof DnsZoneUnknownError) {
      ctx.log("meta", `the DNS zone of ${domain} is not managed here: ${operatorSets}`);
      return;
    }
    throw e;
  }
  if (standing !== null && standing !== target && !isBookedFor(ctx.db, domain, owner)) {
    throw errValidation(`${domain} stands as CNAME ${standing}, and the book of DNS writes does not name it ${owner.kind} ${owner.name}'s — remove it at the provider first, or choose another domain`);
  }
  if (standing === target) {
    if (findDnsWrite(ctx.db, { name: domain, type: "CNAME" }) === null) {
      recordDnsWrite(ctx.db, { name: domain, type: "CNAME", content: target, act: "updated", owner, runId: ctx.runId });
    }
    ctx.log("meta", `${domain} already points at ${target}`);
    return;
  }
  if ((await dns.readRecordContent({ name: domain, type: "A", signal: ctx.signal })) !== null) {
    throw errValidation(`${domain} carries an A record — a CNAME cannot stand beside it; remove it at the provider first`);
  }
  const { created } = await dns.upsertRecord({ name: domain, type: "CNAME", content: target, signal: ctx.signal });
  recordDnsWrite(ctx.db, { name: domain, type: "CNAME", content: target, act: standing === null ? "inserted" : "updated", owner, runId: ctx.runId });
  ctx.log("meta", `DNS record ${domain} → CNAME ${target} ${created ? "created" : "updated"}`);
}

/** What a run asks a new name with, how long it asks before it fails, and how long it pauses
 *  between two asks. */
export interface AnswerWait {
  probe: PublicProbe;
  waitMs: number;
  pollMs: number;
}

/** Ask `url` until `wanted.accepts` takes its status, and answer the probe's detail; fail at the
 *  deadline naming what was waited for, followed by `otherwise` — what still stands, and how the run
 *  goes on from there. */
export async function awaitAnswer(
  ctx: StepCtx,
  wait: AnswerWait,
  url: string,
  wanted: { says: string; accepts: (status: number) => boolean },
  otherwise: string,
): Promise<string> {
  const deadline = Date.now() + wait.waitMs;
  for (;;) {
    const seen = await wait.probe.probe(url, { signal: ctx.signal });
    if (seen.status !== null && wanted.accepts(seen.status)) return seen.detail;
    if (ctx.signal.aborted) throw errValidation(`the wait for ${url} was cancelled`);
    if (Date.now() >= deadline) {
      throw errValidation(`${url} did not answer with ${wanted.says} within ${Math.round(wait.waitMs / 60_000)} minutes (last: ${seen.detail}) — ${otherwise}`);
    }
    ctx.log("meta", `${url} does not answer with ${wanted.says} yet (${seen.detail}); asking again in ${Math.round(wait.pollMs / 1000)}s`);
    await sleep(wait.pollMs, ctx.signal);
  }
}
