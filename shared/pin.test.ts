import { describe, it, expect } from "vitest";
import { parseBuildPins, pinKey, stagePinFile } from "./pin.ts";

// The pin grammar is what the bump writes and what the reaper's safety floor reads. A pin the
// reader silently mis-keys is a live tag the floor does not protect, so every deviation from the
// grammar has to throw rather than be repaired.

describe("parseBuildPins", () => {
  it("reads the builds[] pins of a values file and keys them <image>:<tag>", () => {
    const pins = parseBuildPins("catalog@master:charts/example-engine/values-dev.yaml", [
      "global:",
      "  env: dev",
      "builds:",
      "  - name: example-engine",
      "    image: example-engine",
      '    tag: "0.3.0-stable-20260701000000-abc1234"',
      "  - name: example-apps",
      "    image: example-apps",
      '    tag: "0.2.0-stable-20260701000000-def5678"',
      "",
    ].join("\n"));
    expect(pins.map(pinKey)).toEqual([
      "example-engine:0.3.0-stable-20260701000000-abc1234",
      "example-apps:0.2.0-stable-20260701000000-def5678",
    ]);
  });

  it("yields [] for a values file that pins nothing — most of them do", () => {
    expect(parseBuildPins("x", "global:\n  env: dev\n")).toEqual([]);
    expect(parseBuildPins("x", "builds:\n")).toEqual([]);
  });

  it("REFUSES a host-qualified image — it would key the floor on a name the catalog never returns", () => {
    expect(() =>
      parseBuildPins("apps/controller/values-prod.yaml", 'builds:\n  - name: controller\n    image: zot.example.com/controller\n    tag: "0.2.0"\n'),
    ).toThrow(/builds\[0\] does not match the pin grammar/);
  });

  it("REFUSES a path-qualified image, an incomplete entry, a non-list builds and unparseable YAML", () => {
    expect(() => parseBuildPins("f", 'builds:\n  - name: c\n    image: consumer/x/c\n    tag: "1"\n')).toThrow(/pin grammar/);
    expect(() => parseBuildPins("f", "builds:\n  - name: c\n    image: c\n")).toThrow(/pin grammar/);
    expect(() => parseBuildPins("f", "builds: notalist\n")).toThrow(/not a list/);
    expect(() => parseBuildPins("f", "builds:\n  - [unclosed\n")).toThrow(/not parseable YAML/);
  });

  it("names the file in every refusal so the message points at the one to fix", () => {
    expect(() => parseBuildPins("hostyour-cloud@m1.example.com:apps/controller/values-prod.yaml", "builds: 7\n")).toThrow(
      /hostyour-cloud@m1\.example\.com:apps\/controller\/values-prod\.yaml/,
    );
  });
});

describe("stagePinFile", () => {
  it("names the ONE file per stage a pin may stand in", () => {
    expect(stagePinFile("dev")).toBe("values-dev.yaml");
    expect(stagePinFile("prod")).toBe("values-prod.yaml");
  });
});
