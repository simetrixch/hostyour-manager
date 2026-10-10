import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { DNS_WRITE_ACT, STAGE } from "../../../shared/enums.ts";
import { DNS_RECORD_TYPE } from "../../../shared/dns.ts";
import { stampColumns, deletionColumns } from "./stamps.ts";

// THE BOOK OF DNS WRITES: one live row per record a run of this Manager inserted or updated at the DNS
// provider, keyed by the record itself (name and type — a zone holds one record of a name and type
// this platform writes, and the upsert keeps it so). A later write of the same record REWRITES the
// live row: the act, the content, the run and `modified` are the latest write's, because the book
// answers "what did this Manager do to this record last", not "how often". The run kinds that take a
// record back (dns-remove, mail-dns-unpublish, the offboard and purge removals) mark the row deleted
// beside the record, and the next write of the record adds a new live row. Written and read through
// db/dns-writes.ts only.
//
// `run_id` is a loose reference by convention, NOT a Drizzle FK, for the reason schema/audit.ts
// states: a plain column keeps this file from importing schema/runs, so the boundary law "only the
// executor touches the runs schema" stays intact.
export const dnsWrites = sqliteTable("dns_writes", {
  id: text("id").primaryKey(),                                     // "dnsw_" + ulid
  name: text("name").notNull(),
  type: text("type", { enum: DNS_RECORD_TYPE }).notNull(),
  content: text("content").notNull(),
  act: text("act", { enum: DNS_WRITE_ACT }).notNull(),
  ownerKind: text("owner_kind").notNull(),
  ownerName: text("owner_name").notNull(),
  ownerStage: text("owner_stage", { enum: STAGE }),                // a unit stands at a stage; a sender domain at none
  runId: text("run_id").notNull(),
  ...stampColumns(),
  ...deletionColumns(),
}, (t) => [
  uniqueIndex("dns_writes_record_uq").on(t.name, t.type).where(sql`deleted IS NULL`),
]);
