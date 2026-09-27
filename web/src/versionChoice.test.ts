import { describe, it, expect } from "vitest";
import { newestVersions, selectedVersion, versionChanges, versionLabel, versionOf } from "./versionChoice.ts";

const NEW = "0.1.16-stable-20260927135112-74b90de";
const OLD = "0.1.13-stable-20260926092815-8d15d29";
const platform = { name: "example-platform", builds: ["example-engine"], running: [NEW], versions: [{ tag: NEW, older: false }, { tag: OLD, older: true }] };
const mixed = { name: "example-report", builds: [], running: [NEW, OLD], versions: [{ tag: NEW, older: false }, { tag: OLD, older: true }] };

describe("the Versions dialog's choice", () => {
  it("shows the running version as chosen until the operator picks another, and none where a part runs two", () => {
    expect(selectedVersion(platform, {})).toBe(NEW);
    expect(selectedVersion(platform, { "example-platform": OLD })).toBe(OLD);
    expect(selectedVersion(mixed, {})).toBeUndefined();
  });

  it("plans only what differs from what runs: the running version chosen again moves nothing, one version for a mixed part moves it", () => {
    expect(versionChanges([platform, mixed], { "example-platform": NEW })).toEqual({});
    expect(versionChanges([platform, mixed], { "example-platform": OLD, "example-report": NEW })).toEqual({ "example-platform": OLD, "example-report": NEW });
  });

  it("puts every part that offers a version on its newest", () => {
    expect(newestVersions([platform, { ...mixed, versions: [] }])).toEqual({ "example-platform": NEW });
  });

  it("writes a version with its date, the channel where it is not stable", () => {
    expect(versionOf(NEW)).toBe("0.1.16");
    expect(versionLabel(NEW)).toBe("0.1.16 · 27.09.2026 13:51 UTC");
    expect(versionLabel("0.3.001-beta-20270102120000")).toBe("0.3.001 · beta · 02.01.2027 12:00 UTC");
  });
});
