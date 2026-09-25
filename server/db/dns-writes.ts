import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { dnsWrites } from "./schema/dns-writes.ts";
import type { DnsWriteAct, Stage } from "../../shared/enums.ts";
import type { DnsRecordType } from "../../shared/dns.ts";

// The one writer and the one reader of the book of DNS writes (schema/dns-writes.ts). It stands
// beside the audit writer rather than inside the DNS domain because its callers are in three
// domains — the unit run kinds write a host, the mail publish run writes a sender domain's records,
// the two removal run kinds take a record back — and the boundary law lets no domain import another
// (.dependency-cruiser.cjs domains-no-crosstalk). A table writer under server/db is what every
// domain may reach.

/** What ONE write did to ONE record, as a run records it the moment the provider has answered. */
export interface DnsWrite {
  name: string;
  type: DnsRecordType;
  content: string;
  act: DnsWriteAct;
  owner: { kind: string; name: string; stage?: Stage };
  runId: string;
}

/** Enter a write into the book. A record already in it is REWRITTEN — act, content, owner, run and
 *  time are the latest write's — because the book holds one row per record and answers what this
 *  Manager last did to it. */
export function recordDnsWrite(db: Db, write: DnsWrite): void {
  const row = {
    content: write.content,
    act: write.act,
    ownerKind: write.owner.kind,
    ownerName: write.owner.name,
    ownerStage: write.owner.stage ?? null,
    runId: write.runId,
    writtenAt: new Date(),
  };
  db.insert(dnsWrites)
    .values({ name: write.name, type: write.type, ...row })
    .onConflictDoUpdate({ target: [dnsWrites.name, dnsWrites.type], set: row })
    .run();
}

/** The book's row of ONE record, or null where this Manager never wrote it — a record published
 *  before the book existed, or by a hand at the provider. */
export function findDnsWrite(db: Db, record: { name: string; type: DnsRecordType }): DnsWrite | null {
  const row = db.select().from(dnsWrites).where(and(eq(dnsWrites.name, record.name), eq(dnsWrites.type, record.type))).get();
  return row === undefined ? null : rowToWrite(row);
}

/** Take a record out of the book, beside the deletion at the provider. A record the book never
 *  carried is the idempotent no-op, exactly as the deletion of an absent record is. */
export function forgetDnsWrite(db: Db, record: { name: string; type: DnsRecordType }): void {
  db.delete(dnsWrites).where(and(eq(dnsWrites.name, record.name), eq(dnsWrites.type, record.type))).run();
}

function rowToWrite(r: typeof dnsWrites.$inferSelect): DnsWrite & { writtenAt: Date } {
  return {
    name: r.name,
    type: r.type,
    content: r.content,
    act: r.act,
    owner: { kind: r.ownerKind, name: r.ownerName, ...(r.ownerStage === null ? {} : { stage: r.ownerStage }) },
    runId: r.runId,
    writtenAt: r.writtenAt,
  };
}

/** Every row of the book, newest write first. */
export function listDnsWrites(db: Db): (DnsWrite & { writtenAt: Date })[] {
  return db.select().from(dnsWrites).orderBy(desc(dnsWrites.writtenAt), dnsWrites.name, dnsWrites.type).all().map(rowToWrite);
}
