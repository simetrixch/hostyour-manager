import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "./client.ts";
import { operators } from "./schema/operators.ts";
import { operatorKeys } from "./schema/operator-keys.ts";
import { meta } from "./schema/meta.ts";
import { revokedSessions } from "./schema/revoked-sessions.ts";
import { runAsActor } from "../kernel/actor.ts";

// The stamp columns of operators, operator keys, meta and revoked sessions (db/schema/stamps.ts): drizzle writes them on every insert and update, from the actor the call
// chain is bound to. Lives outside schema/, so drizzle-kit's schema glob never reads a test.

let db: DbHandle;
afterEach(() => db?.sqlite.close());

interface Stamps { creation: number; modified: number; owner: string; modified_by: string }
const TABLES = ["operators", "operator_keys", "meta", "revoked_sessions"] as const;
type Table = (typeof TABLES)[number];
const KEYS: Record<Table, [column: string, value: string]> = {
  operators: ["id", "op_ada"],
  operator_keys: ["id", "opk_1"],
  meta: ["key", "probe"],
  revoked_sessions: ["jti", "jti_1"],
};

function seed(): void {
  db = openDb(":memory:");
  db.db.insert(operators).values({ id: "op_ada", username: "ada", displayName: "Ada" }).run();
  db.db.insert(operatorKeys).values({ id: "opk_1", label: "ada", publicKey: "ssh-ed25519 AAAA", type: "ssh-ed25519", fingerprint: "SHA256:x" }).run();
  db.db.insert(meta).values({ key: "probe", value: "1" }).run();
  db.db.insert(revokedSessions).values({ jti: "jti_1", expiresAt: 4_000_000_000 }).run();
}
function change(): void {
  db.db.update(operators).set({ email: "ada@example.com" }).where(eq(operators.id, "op_ada")).run();
  db.db.update(operatorKeys).set({ type: "ssh-ed25519" }).where(eq(operatorKeys.id, "opk_1")).run();
  db.db.update(meta).set({ value: "2" }).where(eq(meta.key, "probe")).run();
  db.db.update(revokedSessions).set({ expiresAt: 4_000_000_001 }).where(eq(revokedSessions.jti, "jti_1")).run();
}
const stampsOf = (table: Table): Stamps =>
  db.sqlite.prepare(`SELECT creation, modified, owner, modified_by FROM ${table} WHERE ${KEYS[table][0]} = ?`).get(KEYS[table][1]) as Stamps;

describe("the stamps of operators, operator keys, meta and revoked sessions", () => {
  it("name the bound operator on all four fields, and equal times, on an insert", () => {
    runAsActor("op_a", seed);
    for (const table of TABLES) {
      const row = stampsOf(table);
      expect({ table, owner: row.owner, modifiedBy: row.modified_by, same: row.modified === row.creation }).toEqual({ table, owner: "op_a", modifiedBy: "op_a", same: true });
      expect(row.creation).toBeGreaterThan(0);
    }
  });

  it("name the system outside any request", () => {
    seed();
    for (const table of TABLES) expect([table, stampsOf(table).owner, stampsOf(table).modified_by]).toEqual([table, "op_system", "op_system"]);
  });

  it("move modified and modified_by only when another operator updates the row", async () => {
    runAsActor("op_a", seed);
    const before = Object.fromEntries(TABLES.map((t) => [t, stampsOf(t)])) as Record<Table, Stamps>;
    await new Promise((r) => setTimeout(r, 5)); // the clock is read in milliseconds
    runAsActor("op_b", change);
    for (const table of TABLES) {
      const after = stampsOf(table);
      expect({ table, creation: after.creation, owner: after.owner, modifiedBy: after.modified_by }).toEqual({ table, creation: before[table].creation, owner: "op_a", modifiedBy: "op_b" });
      expect(after.modified).toBeGreaterThan(before[table].modified);
    }
  });
});
