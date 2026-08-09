import { describe, it, expect } from "vitest";
import { mapBuildsToChartPins } from "./builds.ts";

const SOURCE = "deploy/chart/values-prod.yaml";

const pins = (...entries: { name: string; image: string; tag: string }[]): string =>
  ["builds:", ...entries.map((e) => `  - name: ${e.name}\n    image: ${e.image}\n    tag: "${e.tag}"`)].join("\n") + "\n";

describe("mapBuildsToChartPins", () => {
  it("maps a declared build onto the builds[] entry whose image is that name", () => {
    const m = mapBuildsToChartPins({
      declaredBuilds: ["acme-api"],
      source: SOURCE,
      valuesStageYaml: pins({ name: "acme-api", image: "acme-api", tag: "0.1.0-stable-20260719120000-abc1234" }),
    });
    expect(m).toEqual({ missing: [], pinnedImages: ["acme-api"], error: null });
  });

  it("accepts any tag — the structure is checked, not a tag a unit that never released cannot have", () => {
    const m = mapBuildsToChartPins({
      declaredBuilds: ["acme-api"],
      source: SOURCE,
      valuesStageYaml: pins({ name: "acme-api", image: "acme-api", tag: "0.0.0-placeholder" }),
    });
    expect(m.missing).toEqual([]);
  });

  it("reports a declared build the file does not pin", () => {
    const m = mapBuildsToChartPins({
      declaredBuilds: ["acme-api", "acme-worker"],
      source: SOURCE,
      valuesStageYaml: pins({ name: "acme-api", image: "acme-api", tag: "1" }),
    });
    expect(m.missing).toEqual(["acme-worker"]);
    expect(m.pinnedImages).toEqual(["acme-api"]);
  });

  it("an absent values file pins nothing — every declared build is missing, and that is not an error", () => {
    const m = mapBuildsToChartPins({ declaredBuilds: ["acme-api"], source: SOURCE, valuesStageYaml: null });
    expect(m).toEqual({ missing: ["acme-api"], pinnedImages: [], error: null });
  });

  it("a values file with no builds key pins nothing", () => {
    const m = mapBuildsToChartPins({ declaredBuilds: ["acme-api"], source: SOURCE, valuesStageYaml: "global:\n  env: prod\n" });
    expect(m).toEqual({ missing: ["acme-api"], pinnedImages: [], error: null });
  });

  it("carries a pin-grammar refusal out as the error text instead of throwing", () => {
    // A path-qualified image is not a flat build name, so the grammar refuses it — the reader must
    // never continue on a builds[] it cannot key on.
    const m = mapBuildsToChartPins({
      declaredBuilds: ["acme-api"],
      source: SOURCE,
      valuesStageYaml: 'builds:\n  - name: acme-api\n    image: consumer/acme/acme-api\n    tag: "1"\n',
    });
    expect(m.error).toContain("pin grammar");
    expect(m.missing).toEqual(["acme-api"]);
  });

  it("carries an unparseable file out as the error text", () => {
    const m = mapBuildsToChartPins({ declaredBuilds: ["acme-api"], source: SOURCE, valuesStageYaml: "builds: [\n" });
    expect(m.error).not.toBeNull();
  });
});
