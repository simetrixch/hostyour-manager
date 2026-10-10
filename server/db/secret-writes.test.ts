import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "./client.ts";
import { consumerSecretEntry, forgetSecretEntry, listSecretWrites, recordSecretWrites } from "./secret-writes.ts";
import { runAsActor } from "../kernel/actor.ts";

// The book of secret writes: which keys of a consumer's Vault entry this Manager wrote, never a value.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

describe("the book of secret writes", () => {
  const entry = consumerSecretEntry("prod", "acme");

  it("names the entry the seeder writes, below the KV mount", () => {
    expect(entry).toBe("prod/consumer/acme/app");
  });

  it("records each key of a write, rewrites a key written again, and forgets one entry alone", () => {
    recordSecretWrites(db.db, { entry, keys: ["A", "B"], act: "seeded", runId: "run_1" });
    recordSecretWrites(db.db, { entry: consumerSecretEntry("prod", "other"), keys: ["A"], act: "seeded", runId: "run_9" });
    recordSecretWrites(db.db, { entry, keys: ["B"], act: "set", runId: "run_2" });
    const rows = listSecretWrites(db.db, entry).map((w) => [w.key, w.act, w.runId]).sort();
    expect(rows).toEqual([["A", "seeded", "run_1"], ["B", "set", "run_2"]]);
    forgetSecretEntry(db.db, entry);
    expect(listSecretWrites(db.db, entry)).toEqual([]);
    expect(listSecretWrites(db.db, consumerSecretEntry("prod", "other")).map((w) => w.key)).toEqual(["A"]);
  });

  it("names who wrote a key first and last, keeps a forgotten entry as deleted rows no read returns, and adds a new live row when a key is written again", () => {
    runAsActor("op_a", () => recordSecretWrites(db.db, { entry, keys: ["A"], act: "seeded", runId: "run_1" }));
    runAsActor("op_b", () => recordSecretWrites(db.db, { entry, keys: ["A"], act: "set", runId: "run_2" }));
    const written = listSecretWrites(db.db, entry);
    expect(written).toEqual([{ entry, key: "A", act: "set", runId: "run_2", writtenAt: expect.any(Date) }]);
    runAsActor("op_c", () => forgetSecretEntry(db.db, entry));
    expect(listSecretWrites(db.db, entry)).toEqual([]);
    runAsActor("op_d", () => recordSecretWrites(db.db, { entry, keys: ["A"], act: "seeded", runId: "run_3" }));
    expect(listSecretWrites(db.db, entry).map((w) => [w.key, w.act, w.runId])).toEqual([["A", "seeded", "run_3"]]);
    expect(db.sqlite.prepare("SELECT act, owner, modified_by, deleted_by, deleted IS NOT NULL AS gone FROM secret_writes ORDER BY id").all()).toEqual([
      { act: "set", owner: "op_a", modified_by: "op_c", deleted_by: "op_c", gone: 1 },
      { act: "seeded", owner: "op_d", modified_by: "op_d", deleted_by: null, gone: 0 },
    ]);
  });
});
