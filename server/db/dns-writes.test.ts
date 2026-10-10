import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "./client.ts";
import { findDnsWrite, forgetDnsWrite, listDnsWrites, recordDnsWrite } from "./dns-writes.ts";
import { runAsActor } from "../kernel/actor.ts";

// The book holds ONE row per record (name and type). What these tests hold: an insert and an update
// are two acts on two records, a second write of the same record rewrites its row rather than adding
// one, and forgetting takes the row out — twice, without complaint, because the deletion beside it
// is idempotent too.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const HOST = { name: "post.example.net", type: "A" as const, owner: { kind: "consumer" as const, name: "post", stage: "prod" as const } };

describe("the book of DNS writes", () => {
  it("records an insert and an update as two rows, newest first — the same order on every read, even for two writes in one millisecond — each with its owner and run", () => {
    recordDnsWrite(db.db, { ...HOST, content: "203.0.113.9", act: "inserted", runId: "run_1" });
    recordDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", act: "updated", owner: { kind: "mail", name: "example.com" }, runId: "run_2" });
    const rows = listDnsWrites(db.db);
    expect(rows.map((r) => `${r.act} ${r.type} ${r.name} → ${r.content} by ${r.runId}`)).toEqual([
      "updated TXT _dmarc.example.com → v=DMARC1; p=none by run_2",
      "inserted A post.example.net → 203.0.113.9 by run_1",
    ]);
    expect(rows[1]!.owner).toEqual({ kind: "consumer", name: "post", stage: "prod" });
    // A sender domain stands at no stage, and the row says so by carrying none.
    expect(rows[0]!.owner).toEqual({ kind: "mail", name: "example.com" });
    expect(rows[0]!.writtenAt.getTime()).toBeGreaterThanOrEqual(rows[1]!.writtenAt.getTime());
  });

  it("rewrites the row of a record written a second time — the act, the content, the run and the time are the latest write's", () => {
    recordDnsWrite(db.db, { ...HOST, content: "203.0.113.9", act: "inserted", runId: "run_1" });
    const first = listDnsWrites(db.db)[0]!.writtenAt;
    recordDnsWrite(db.db, { ...HOST, content: "203.0.113.20", act: "updated", runId: "run_2" });
    const rows = listDnsWrites(db.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: HOST.name, type: "A", content: "203.0.113.20", act: "updated", runId: "run_2" });
    expect(rows[0]!.writtenAt.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it("keeps an A and a TXT of one name apart — the record is the name AND the type", () => {
    recordDnsWrite(db.db, { name: "example.com", type: "A", content: "203.0.113.9", act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_1" });
    recordDnsWrite(db.db, { name: "example.com", type: "TXT", content: "v=spf1 ip4:203.0.113.9 -all", act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_1" });
    expect(listDnsWrites(db.db)).toHaveLength(2);
    forgetDnsWrite(db.db, { name: "example.com", type: "TXT" });
    expect(listDnsWrites(db.db).map((r) => r.type)).toEqual(["A"]);
  });

  it("forgets a record, and forgetting one the book never carried is the no-op", () => {
    recordDnsWrite(db.db, { ...HOST, content: "203.0.113.9", act: "inserted", runId: "run_1" });
    forgetDnsWrite(db.db, { name: HOST.name, type: "A" });
    expect(listDnsWrites(db.db)).toEqual([]);
    expect(() => forgetDnsWrite(db.db, { name: HOST.name, type: "A" })).not.toThrow();
  });

  it("names who wrote a record first and last, keeps a forgotten record as a deleted row no read returns, and adds a new live row when it is written again", () => {
    const record = { name: HOST.name, type: "A" as const };
    runAsActor("op_a", () => recordDnsWrite(db.db, { ...HOST, content: "203.0.113.9", act: "inserted", runId: "run_1" }));
    runAsActor("op_b", () => recordDnsWrite(db.db, { ...HOST, content: "203.0.113.20", act: "updated", runId: "run_2" }));
    runAsActor("op_c", () => forgetDnsWrite(db.db, record));
    runAsActor("op_c", () => forgetDnsWrite(db.db, record)); // a second take-back finds no live row
    expect(findDnsWrite(db.db, record)).toBeNull();
    expect(listDnsWrites(db.db)).toEqual([]);
    runAsActor("op_d", () => recordDnsWrite(db.db, { ...HOST, content: "203.0.113.30", act: "inserted", runId: "run_3" }));
    expect(findDnsWrite(db.db, record)).toMatchObject({ content: "203.0.113.30", runId: "run_3" });
    expect(db.sqlite.prepare("SELECT content, owner, modified_by, deleted_by, deleted IS NOT NULL AS gone FROM dns_writes ORDER BY id").all()).toEqual([
      { content: "203.0.113.20", owner: "op_a", modified_by: "op_c", deleted_by: "op_c", gone: 1 },
      { content: "203.0.113.30", owner: "op_d", modified_by: "op_d", deleted_by: null, gone: 0 },
    ]);
  });
});
