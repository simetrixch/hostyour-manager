import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTime } from "ulid";
import { openDb, type DbHandle } from "./client.ts";
import { writeAudit } from "./audit-writer.ts";

// The audit table has no ordinal and its `ts` is milliseconds, so `id` is the only key that can put
// the trail in order. These tests are about that one property: an id written later must sort after
// an id written earlier, including when both were written inside the same millisecond.
describe("audit id ordering (db/audit-writer.ts)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-aud-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return db;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const WRITES = 300;

  /** Write WRITES rows as fast as the process can, each carrying the position it was written at, and
   *  read them back the way an operator reads a trail. */
  function writeAndReadBack(db: DbHandle): { id: string; position: number }[] {
    for (let i = 0; i < WRITES; i++) {
      writeAudit(db.db, { actor: "op_probe", action: "probe.write", detail: { position: i } });
    }
    const rows = db.sqlite
      .prepare("SELECT id, detail_json FROM audit WHERE action = 'probe.write' ORDER BY id")
      .all() as { id: string; detail_json: string }[];
    return rows.map((r) => ({ id: r.id, position: (JSON.parse(r.detail_json) as { position: number }).position }));
  }

  const millisecondOf = (id: string): number => decodeTime(id.slice("aud_".length));

  it("rows written inside one millisecond come back in the order they were written", () => {
    const read = writeAndReadBack(fresh());

    // How much this covered: pairs whose millisecond prefixes differ are ordered by the clock and say
    // nothing about the tiebreak. Only the same-millisecond pairs exercise it, so the count of those
    // is asserted — a run where every write got its own millisecond would pass the ordering check
    // below while measuring nothing about it.
    const milliseconds = read.map((r) => millisecondOf(r.id));
    const sameMillisecondPairs = milliseconds.filter((ms, i) => i > 0 && ms === milliseconds[i - 1]).length;
    expect(sameMillisecondPairs, `${WRITES} writes produced no two ids inside one millisecond, so the ordering assertion below was never exercised`).toBeGreaterThan(0);

    expect(read.map((r) => r.position)).toEqual([...Array(WRITES).keys()]);
  });

  // The counter-probe of the assertion above: it compares a decoded payload against the positions
  // 0..N-1, and that comparison must be able to see a single pair out of place. A trail read back
  // with two neighbours swapped is what the defect looked like, so it is built here by hand and the
  // same comparison is required to reject it.
  it("the ordering assertion rejects a trail with one adjacent pair swapped", () => {
    const positions = writeAndReadBack(fresh()).map((r) => r.position);
    const swapped = positions.map((p, i) => (i === 0 ? positions[1] : i === 1 ? positions[0] : p));

    expect(swapped).not.toEqual([...Array(WRITES).keys()]);
  });

  it("ids keep rising across a gap in time, so the trail orders whole-second-apart rows too", async () => {
    const db = fresh();
    writeAudit(db.db, { actor: "op_probe", action: "probe.gap", detail: { position: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeAudit(db.db, { actor: "op_probe", action: "probe.gap", detail: { position: 1 } });

    const rows = db.sqlite
      .prepare("SELECT id, detail_json FROM audit WHERE action = 'probe.gap' ORDER BY id")
      .all() as { id: string; detail_json: string }[];
    expect(rows.map((r) => (JSON.parse(r.detail_json) as { position: number }).position)).toEqual([0, 1]);
    const milliseconds = rows.map((r) => millisecondOf(r.id));
    expect(new Set(milliseconds).size, "both writes landed in one millisecond, so no gap in time was exercised").toBe(2);
    expect([...milliseconds].sort((a, b) => a - b)).toEqual(milliseconds);
  });
});
