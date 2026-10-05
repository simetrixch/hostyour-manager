import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openDb } from "#core/server/db/client.ts";
import { unitSizes } from "./schema.ts";
import { UNIT_SIZE_SEED } from "../shared/unit-size.ts";

// The forward step of the member rows' solver room (migration 0001 of the unit ledger), run on the
// rows an installation held before it.
const SQL = readFileSync(new URL("./migrations/0001_member-cert-solver-room.sql", import.meta.url), "utf8");

describe("migration 0001: a standing member row gains one cert-manager solver", () => {
  it("brings the shipped rows to the grown seed, grows an edited row the same, and leaves units it does not read and other components alone", () => {
    const { db, sqlite } = openDb(":memory:");
    const row = (component: "member" | "base", name: string, requestsCpu: string, requestsMemory: string, limitsCpu: string, limitsMemory: string, pods = 8) =>
      db.insert(unitSizes).values({ component, name: name as "small", requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods, persistentVolumeClaims: 1 }).run();
    row("member", "xsmall", "100m", "576Mi", "2", "2Gi");
    row("member", "small", "200m", "1152Mi", "4", "4Gi");
    row("member", "medium", "400m", "2304Mi", "6", "6Gi");
    row("member", "large", "800m", "4608Mi", "8", "10Gi");
    row("member", "xlarge", "1.5", "1.5Gi", "8", "15Gi", 10);
    row("member", "xxlarge", "1600m", "9G", "8", "20Gi");
    row("base", "small", "400m", "1Gi", "1500m", "2Gi");
    sqlite.exec(SQL);
    const got = Object.fromEntries(db.select().from(unitSizes).all().map(({ updatedAt: _u, component, name, ...q }) => [`${component}/${name}`, q]));
    for (const name of ["xsmall", "small", "medium", "large"] as const) expect(got[`member/${name}`]).toEqual(UNIT_SIZE_SEED.member[name]);
    expect(got["member/xlarge"]).toEqual({ requestsCpu: "1510m", requestsMemory: "1600Mi", limitsCpu: "8100m", limitsMemory: "15424Mi", pods: 11, persistentVolumeClaims: 1 });
    expect(got["member/xxlarge"]).toEqual({ requestsCpu: "1600m", requestsMemory: "9G", limitsCpu: "8", limitsMemory: "20Gi", pods: 8, persistentVolumeClaims: 1 });
    expect(got["base/small"]).toEqual({ requestsCpu: "400m", requestsMemory: "1Gi", limitsCpu: "1500m", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 });
  });
});
