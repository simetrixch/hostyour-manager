import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../db/client.ts";
import { AppError } from "../kernel/errors.ts";
import { acquireLocks, releaseLocks, listLocks, deriveServerLocks } from "./locks.ts";

describe("lock manager", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-lk-"));
    dirs.push(dir);
    const h = openDb(join(dir, "controller.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedRun(sqlite: DbHandle["sqlite"], id: string): void {
    sqlite.prepare("INSERT OR IGNORE INTO operators (id, username, display_name) VALUES ('op','op','op')").run();
    sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, "noop", "server", "srv", "{}", "{}", "approved", "op");
  }

  const busyCode = (fn: () => void): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return e instanceof AppError ? e.code : "?";
    }
  };

  it("deriveServerLocks keeps only ownsHost targets", () => {
    expect(
      deriveServerLocks([
        { serverId: "s1", ownsHost: true, label: "a" },
        { serverId: "s2", ownsHost: false, label: "b" },
      ]),
    ).toEqual([{ resource: "server", key: "s1" }]);
  });

  it("acquires disjoint claims for different runs", () => {
    const { db, sqlite } = fresh();
    seedRun(sqlite, "run_a");
    seedRun(sqlite, "run_b");
    acquireLocks(db, "run_a", [{ resource: "server", key: "s1" }]);
    acquireLocks(db, "run_b", [{ resource: "server", key: "s2" }]);
    expect(listLocks(db)).toHaveLength(2);
  });

  it("a conflicting (resource,key) throws RESOURCE_BUSY", () => {
    const { db, sqlite } = fresh();
    seedRun(sqlite, "run_a");
    seedRun(sqlite, "run_b");
    acquireLocks(db, "run_a", [{ resource: "master-kube", key: "m" }]);
    expect(busyCode(() => acquireLocks(db, "run_b", [{ resource: "master-kube", key: "m" }]))).toBe("RESOURCE_BUSY");
  });

  it("acquisition is all-or-nothing (a partial conflict inserts nothing)", () => {
    const { db, sqlite } = fresh();
    seedRun(sqlite, "run_a");
    seedRun(sqlite, "run_b");
    acquireLocks(db, "run_a", [{ resource: "master-vault", key: "m" }]);
    expect(
      busyCode(() =>
        acquireLocks(db, "run_b", [
          { resource: "git-branch", key: "m1" },
          { resource: "master-vault", key: "m" },
        ]),
      ),
    ).toBe("RESOURCE_BUSY");
    expect(listLocks(db).some((l) => l.resource === "git-branch")).toBe(false);
  });

  it("manager:self conflicts with any existing claim, both directions", () => {
    const { db, sqlite } = fresh();
    seedRun(sqlite, "run_a");
    seedRun(sqlite, "run_b");
    seedRun(sqlite, "run_c");
    acquireLocks(db, "run_a", [{ resource: "server", key: "s1" }]);
    expect(busyCode(() => acquireLocks(db, "run_b", [{ resource: "manager", key: "self" }]))).toBe("RESOURCE_BUSY");
    releaseLocks(db, "run_a");
    acquireLocks(db, "run_b", [{ resource: "manager", key: "self" }]);
    expect(busyCode(() => acquireLocks(db, "run_c", [{ resource: "server", key: "s9" }]))).toBe("RESOURCE_BUSY");
  });

  it("release frees the run's claims", () => {
    const { db, sqlite } = fresh();
    seedRun(sqlite, "run_a");
    acquireLocks(db, "run_a", [{ resource: "server", key: "s1" }]);
    releaseLocks(db, "run_a");
    expect(listLocks(db)).toHaveLength(0);
  });
});
