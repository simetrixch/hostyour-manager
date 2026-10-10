import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "./client.ts";
import { countLiveRuns } from "./reset.ts";

describe("the reset's database read (db/reset.ts)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-reset-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return db;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("countLiveRuns counts only planning/approved/running", () => {
    const db = make();
    const ins = (id: string, status: string) =>
      db.sqlite.prepare(`INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, owner, modified_by) VALUES ('${id}','noop','self','c','{}','{}','${status}','op_system','op_system')`).run();
    ins("r_plan", "planned"); // parked — not live
    ins("r_done", "succeeded");
    expect(countLiveRuns(db.sqlite)).toBe(0);
    ins("r_run", "running");
    ins("r_appr", "approved");
    expect(countLiveRuns(db.sqlite)).toBe(2);
  });
});
