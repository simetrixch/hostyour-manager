// gate-runner/src/g1.test.ts — G1 "structure" (hard). One PASS test that returns the validated
// manifest, then one FAIL test per failure mode in the order g1.ts rejects them (missing manifest / schema-invalid /
// name mismatch / stage not a declared env / missing per-env values), plus defensive cases: a manifest that parses to
// a non-object must reject cleanly, a Chart.yaml whose name disagrees fails the identity law, and a
// build-only manifest (no chart) passes without shipping values files. Each FAIL asserts manifest is
// null (the report contract: manifest non-null IFF pass).
import { describe, expect, it } from "vitest";
import { checkStructure } from "./g1.ts";

const VALID_MANIFEST = [
  "apiVersion: hostyour.cloud/v1",
  "kind: ConsumerManifest",
  "name: acme",
  "owner: team-acme",
  "envs:",
  "  - dev",
  "  - prod",
  "chart:",
  "  path: deploy/chart",
  "",
].join("\n");

/** A chart-present bundle for consumer "acme" with dev+prod values, matching VALID_MANIFEST. */
function baseFiles(): Record<string, string> {
  return {
    "deploy/platform.yaml": VALID_MANIFEST,
    "deploy/chart/Chart.yaml": "apiVersion: v2\nname: acme\nversion: 0.1.0\n",
    "deploy/chart/values.yaml": "replicas: 1\n",
    "deploy/chart/values-dev.yaml": "replicas: 1\n",
    "deploy/chart/values-prod.yaml": "replicas: 3\n",
  };
}

function run(
  files: Record<string, string>,
  over: Partial<{ chartPath: string; targetName: string; stage: string }> = {},
) {
  return checkStructure({
    files: new Map(Object.entries(files)),
    chartPath: over.chartPath ?? "deploy/chart",
    targetName: over.targetName ?? "acme",
    stage: over.stage ?? "dev",
  });
}

describe("g1 structure", () => {
  it("(1) passes a valid manifest and returns the validated manifest", () => {
    const { result, manifest } = run(baseFiles());
    expect(result.status).toBe("pass");
    expect(result.severity).toBe("hard");
    expect(result.reason).toBeNull();
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe("acme");
    expect(manifest?.envs).toEqual(["dev", "prod"]);
    expect(manifest?.chart?.path).toBe("deploy/chart");
  });

  it("(2) fails and returns null manifest when deploy/platform.yaml is missing", () => {
    const files = baseFiles();
    delete files["deploy/platform.yaml"];
    const { result, manifest } = run(files);
    expect(result.status).toBe("fail");
    expect(result.reason).not.toBeNull();
    expect(manifest).toBeNull();
    expect(result.found).toContain("deploy/platform.yaml");
  });

  it("(3) fails and returns null when the manifest is schema-invalid (missing owner)", () => {
    const files = baseFiles();
    files["deploy/platform.yaml"] = VALID_MANIFEST.replace("owner: team-acme\n", "");
    const { result, manifest } = run(files);
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
    expect(result.found).toContain("owner");
    // The rejection names the contract version a reader checks the manifest against — the
    // version shared/consumer.ts implements, not an older one.
    expect(result.expected).toContain("contract v1.3");
  });

  it("(4) fails the identity law when manifest.name != targetName", () => {
    const { result, manifest } = run(baseFiles(), { targetName: "other" });
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
    expect(result.reason).toContain("identity law");
    expect(result.found).toContain("other");
  });

  it("(5) fails when the stage is not one of the declared envs", () => {
    const { result, manifest } = run(baseFiles(), { stage: "test" });
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
    expect(result.reason).toContain("declared env");
    expect(result.found).toContain("test");
  });

  it("(6) fails when values-prod.yaml is missing while envs includes prod", () => {
    const files = baseFiles();
    delete files["deploy/chart/values-prod.yaml"];
    const { result, manifest } = run(files);
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
    expect(result.found).toContain("values-prod.yaml");
  });

  // Defensive: a hostile platform.yaml that parses to a NON-OBJECT (a bare string) must reject
  // cleanly through safeParse, not crash.
  it("fails cleanly when platform.yaml parses to a non-object", () => {
    const files = baseFiles();
    files["deploy/platform.yaml"] = "just a string, not a mapping\n";
    const { result, manifest } = run(files);
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
  });

  // Identity law leg 2: a shipped Chart.yaml whose name disagrees with the manifest name fails, even
  // though manifest.name == targetName.
  it("fails when Chart.yaml name disagrees with the manifest name", () => {
    const files = baseFiles();
    files["deploy/chart/Chart.yaml"] = "apiVersion: v2\nname: evil\nversion: 0.1.0\n";
    const { result, manifest } = run(files);
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
    expect(result.reason).toContain("identity law");
    expect(result.found).toContain("Chart.yaml");
  });

  // A declared chart whose Chart.yaml is absent from the bundle fails check 3.
  it("fails when the manifest declares a chart but no Chart.yaml is shipped", () => {
    const files = baseFiles();
    delete files["deploy/chart/Chart.yaml"];
    const { result, manifest } = run(files);
    expect(result.status).toBe("fail");
    expect(manifest).toBeNull();
    expect(result.found).toContain("Chart.yaml");
  });

  // Deviation coverage: a build-only manifest (chart omitted, contract v1.3) ships no chart and no
  // values files, and must PASS — the per-env values requirement is gated on a declared chart.
  it("passes a build-only manifest that ships no chart or values files", () => {
    const buildOnly = [
      "apiVersion: hostyour.cloud/v1",
      "kind: ConsumerManifest",
      "name: acme",
      "owner: team-acme",
      "envs:",
      "  - dev",
      "builds:",
      "  - name: api",
      "    containerfile: Containerfile",
      "",
    ].join("\n");
    const { result, manifest } = run({ "deploy/platform.yaml": buildOnly });
    expect(result.status).toBe("pass");
    expect(result.reason).toBeNull();
    expect(manifest).not.toBeNull();
    expect(manifest?.chart).toBeUndefined();
  });

  // Regression: a direct/test caller passing a null/undefined stage or targetName must reject cleanly
  // (never crash). The CLI path validates these when it parses the task env (cli.ts parseEnv), but the
  // module contract is "never crash on any input".
  it("fails cleanly (no crash) on a null stage or an undefined targetName", () => {
    const files = new Map(Object.entries(baseFiles()));
    const nullStage = checkStructure({ files, chartPath: "deploy/chart", targetName: "acme", stage: null as unknown as string });
    expect(nullStage.result.status).toBe("fail");
    expect(nullStage.manifest).toBeNull();
    const noName = checkStructure({ files, chartPath: "deploy/chart", targetName: undefined as unknown as string, stage: "dev" });
    expect(noName.result.status).toBe("fail");
    expect(noName.manifest).toBeNull();
  });
});
