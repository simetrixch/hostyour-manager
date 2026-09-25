// The unit records of ONE cluster, repointed from one FQDN of it onto another — cluster-rename's act
// on the zones, bound into that run by the composition root: the run belongs to the cluster family
// and cannot reach this domain itself. A unit record is a CNAME onto its cluster's FQDN
// (unit-dns.ts), so moving that FQDN is a content update of every record naming it, and nothing
// else — the unit's host, its certificates and its workloads stay as they are.
import { and, eq, notInArray } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { apps, clusters, tenants } from "../../db/schema/inventory.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { errValidation } from "../../kernel/errors.ts";
import { APP_SETTLED_STATUS, TENANT_SETTLED_STATUS, type DnsWriteOwnerKind, type Stage } from "../../../shared/enums.ts";
import { consumerUnitHost, tenantRecordName } from "../../../shared/unit-host.ts";

export interface RepointUnitRecordsDeps {
  dns: DnsProvider | undefined;
  /** The public apex a cluster's units serve under at a stage, read off the cluster's own map. */
  unitApex: (domain: string, stage: Stage) => Promise<string>;
}

/** Every unit record of the cluster that points at `from`, pointed at `to`: each consumer's host and
 *  each tenant's wildcard of the cluster's units that are not settled. Each record is READ before
 *  it is written, and one pointing anywhere else is left and named — it is not this cluster's to
 *  move. Every write enters the book of DNS writes, as a unit's own provision-dns does. Answers the
 *  records it moved. */
export async function repointUnitRecords(
  deps: RepointUnitRecordsDeps,
  ctx: StepCtx,
  input: { clusterId: string; from: string; to: string },
): Promise<string[]> {
  const dns = deps.dns;
  if (!dns) {
    throw errValidation("repointing the unit records of a renamed cluster requires the DNS provider, and none is wired on this manager (CLOUDFLARE_DNS_API_TOKEN unset)");
  }
  // THE DOMAIN THE CLUSTER'S MAP STANDS AT NOW, which is where its unit apex is read. The rename
  // moves the row and the map before it moves the records, and an abort moves the records back
  // before the map and the row — so both directions read the apex where the map stands.
  const row = ctx.db.select({ domain: clusters.domain }).from(clusters).where(eq(clusters.id, input.clusterId)).get();
  if (!row) throw errValidation(`cluster ${input.clusterId} has no row — there is no unit record to repoint`);
  const units: { kind: Extract<DnsWriteOwnerKind, "consumer" | "tenant">; owner: string; stage: Stage; record: (apex: string) => string }[] = [
    ...ctx.db
      .select({ name: apps.name, host: apps.host, stage: apps.stage })
      .from(apps)
      .where(and(eq(apps.clusterId, input.clusterId), notInArray(apps.status, [...APP_SETTLED_STATUS])))
      .all()
      .map((a) => ({ kind: "consumer" as const, owner: a.name, stage: a.stage, record: (apex: string) => consumerUnitHost(a.host, a.stage, apex) })),
    ...ctx.db
      .select({ guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage, routing: tenants.routing })
      .from(tenants)
      .where(and(eq(tenants.clusterId, input.clusterId), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
      .all()
      .map((t) => ({ kind: "tenant" as const, owner: t.guid, stage: t.stage, record: (apex: string) => tenantRecordName(t.routing, t.subdomain, t.stage, apex) })),
  ];
  const moved: string[] = [];
  for (const unit of units) {
    const name = unit.record(await deps.unitApex(row.domain, unit.stage));
    const standing = await dns.readRecordContent({ name, type: "CNAME", signal: ctx.signal });
    if (standing !== input.from) {
      ctx.log("meta", standing === input.to
        ? `${name} already points at ${input.to}`
        : `${name} points at ${standing ?? "nothing"}, not at ${input.from} — it is not this cluster's to move, and is left as it stands`);
      continue;
    }
    await dns.upsertRecord({ name, type: "CNAME", content: input.to, signal: ctx.signal });
    recordDnsWrite(ctx.db, {
      name, type: "CNAME", content: input.to, act: "updated",
      owner: { kind: unit.kind, name: unit.owner, stage: unit.stage }, runId: ctx.runId,
    });
    ctx.log("meta", `DNS record ${name} → CNAME ${input.to} (it pointed at ${input.from})`);
    moved.push(name);
  }
  return moved;
}
