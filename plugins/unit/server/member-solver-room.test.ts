import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openDb } from "#core/server/db/client.ts";
import { UNIT_SIZE_SEED } from "../shared/unit-size.ts";

// The forward step of the member rows' solver room (migration 0001 of the unit ledger), run on the
// rows an installation held before it. A database opened without the unit's tree holds unit_sizes as
// the core's baseline created it, the table 0001 ran on; so the rows are written and read in SQL.
const SQL = readFileSync(new URL("./migrations/0001_member-cert-solver-room.sql", import.meta.url), "utf8");
const INSERT = "INSERT INTO unit_sizes (component, name, requests_cpu, requests_memory, limits_cpu, limits_memory, pods, persistent_volume_claims) VALUES (?, ?, ?, ?, ?, ?, ?, 1)";
const FIGURES = "SELECT component, name, requests_cpu AS requestsCpu, requests_memory AS requestsMemory, limits_cpu AS limitsCpu, limits_memory AS limitsMemory, pods, persistent_volume_claims AS persistentVolumeClaims FROM unit_sizes";

describe("migration 0001: a standing member row gains one cert-manager solver", () => {
  type Row = [name: string, requestsCpu: string, requestsMemory: string, limitsCpu: string, limitsMemory: string, pods?: number];
  /** The member rows (and one base row) after the migration ran over `rows`, keyed component/name. */
  const migrated = (rows: Row[]) => {
    const { sqlite } = openDb(":memory:");
    for (const [name, requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods = 8] of rows) {
      sqlite.prepare(INSERT).run("member", name, requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods);
    }
    sqlite.prepare(INSERT).run("base", "small", "400m", "1Gi", "1500m", "2Gi", 8);
    sqlite.exec(SQL);
    const figures = sqlite.prepare(FIGURES).all() as { component: string; name: string }[];
    return Object.fromEntries(figures.map(({ component, name, ...q }) => [`${component}/${name}`, q]));
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
