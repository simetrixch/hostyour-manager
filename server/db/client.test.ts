import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "./client.ts";

describe("openDb — migration phase + append-only invariants", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-db-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("migrates a fresh DB with foreign keys on and integrity ok", () => {
    const { sqlite } = fresh();
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("re-opens idempotently (migrate is a no-op the second time)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-db-"));
    dirs.push(dir);
    const file = join(dir, "manager.db");
    const h1 = openDb(file);
    handles.push(h1);
    h1.sqlite.close();
    expect(() => {
      handles.push(openDb(file));
    }).not.toThrow();
  });

  it("enforces append-only on events and audit (UPDATE and DELETE both raise)", () => {
    const { sqlite } = fresh();
    sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?,?,?,?,?,?,?,?)")
      .run("run_x", "noop", "server", "srv_x", "{}", "{}", "planned", "op_system");
    sqlite.prepare("INSERT INTO events (id, run_id, stream, seq, text) VALUES (?,?,?,?,?)").run("evt_x", "run_x", "stdout", 0, "hello");
    sqlite.prepare("INSERT INTO audit (id, actor, action) VALUES (?,?,?)").run("aud_x", "system", "run.started");

    expect(() => sqlite.prepare("UPDATE events SET text='y' WHERE id='evt_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM events WHERE id='evt_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("UPDATE audit SET action='x' WHERE id='aud_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM audit WHERE id='aud_x'").run()).toThrow(/append-only/);
  });

  it("the runs plan_json CHECK rejects a planned run with no plan, but allows a failed one", () => {
    const { sqlite } = fresh();
    const insert = (id: string, status: string) =>
      sqlite
        .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, status, started_by) VALUES (?,?,?,?,?,?,?)")
        .run(id, "noop", "server", "srv_y", "{}", status, "op_system");
    expect(() => insert("run_bad", "planned")).toThrow(); // planned + NULL plan_json violates the CHECK
    expect(() => insert("run_ok", "failed")).not.toThrow(); // failed may carry no plan
  });

  it("seeds the reserved system operators op_system + op_emergency", () => {
    const { sqlite } = fresh();
    const rows = sqlite.prepare("SELECT username FROM operators ORDER BY username").all() as { username: string }[];
    expect(rows.map((r) => r.username)).toEqual(["emergency", "system"]);
  });
});
