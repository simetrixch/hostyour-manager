import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openDb } from "#core/server/db/client.ts";
import { unitSizes } from "./schema.ts";
import { UNIT_SIZE_SEED } from "../shared/unit-size.ts";

// The forward step of the member rows' solver room (migration 0001 of the unit ledger), run on the
// rows an installation held before it.
const SQL = readFileSync(new URL("./migrations/0001_member-cert-solver-room.sql", import.meta.url), "utf8");

describe("migration 0001: a standing member row gains one cert-manager solver", () => {
  type Row = [name: string, requestsCpu: string, requestsMemory: string, limitsCpu: string, limitsMemory: string, pods?: number];
  /** The member rows (and one base row) after the migration ran over `rows`, keyed component/name. */
  const migrated = (rows: Row[]) => {
    const { db, sqlite } = openDb(":memory:");
    for (const [name, requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods = 8] of rows) {
      db.insert(unitSizes).values({ component: "member", name: name as "small", requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods, persistentVolumeClaims: 1 }).run();
    }
    db.insert(unitSizes).values({ component: "base", name: "small", requestsCpu: "400m", requestsMemory: "1Gi", limitsCpu: "1500m", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 }).run();
    sqlite.exec(SQL);
    return Object.fromEntries(db.select().from(unitSizes).all().map(({ updatedAt: _u, component, name, ...q }) => [`${component}/${name}`, q]));
  };

  it("brings the shipped rows to the grown seed, grows an edited row by at least one solver, and leaves other components alone", () => {
    const got = migrated([
      ["xsmall", "100m", "576Mi", "2", "2Gi"],
      ["small", "200m", "1152Mi", "4", "4Gi"],
      ["medium", "400m", "2304Mi", "6", "6Gi"],
      ["large", "800m", "4608Mi", "8", "10Gi"],
      // A fraction of a millicore or a MiB rounds UP: 1500.2m and 1536.1Mi become 1501m and 1537Mi.
      ["xlarge", "1.5002", "1.5001Gi", "8", "15Gi", 10],
    ]);
    for (const name of ["xsmall", "small", "medium", "large"] as const) expect(got[`member/${name}`]).toEqual(UNIT_SIZE_SEED.member[name]);
    expect(got["member/xlarge"]).toEqual({ requestsCpu: "1511m", requestsMemory: "1601Mi", limitsCpu: "8100m", limitsMemory: "15424Mi", pods: 11, persistentVolumeClaims: 1 });
    expect(got["base/small"]).toEqual({ requestsCpu: "400m", requestsMemory: "1Gi", limitsCpu: "1500m", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 });
  });

  it("leaves a row whole where any one figure is written in a unit it does not read", () => {
    const rows: Row[] = [
      ["xsmall", "2k", "576Mi", "2", "2Gi"],
      ["small", "200m", "9G", "4", "4Gi"],
      ["medium", "400m", "2304Mi", "2k", "6Gi"],
      ["large", "800m", "4608Mi", "8", "9G"],
    ];
    const got = migrated(rows);
    for (const [name, requestsCpu, requestsMemory, limitsCpu, limitsMemory] of rows) {
      expect(got[`member/${name}`], name).toEqual({ requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods: 8, persistentVolumeClaims: 1 });
    }
  });
});
