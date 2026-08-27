import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, runGateCli, type CliInputs } from "./cli.ts";
import type { ConnectFn } from "./fence.ts";
import { sandboxGreen } from "../../shared/gates.ts";
import { clusterMapPath } from "../../shared/cluster-values.ts";
import { POST_RENDER_GATES, SANDBOX_GATE_IDS } from "./gate-list.ts";
import { SANDBOX_FENCE_GATE_ID } from "./gates/sandbox-fence.gate.ts";

const made: string[] = [];
async function ws(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gr-cli-"));
  made.push(d);
  return d;
}
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const ENV = {
  TARGET_NAME: "acme",
  STAGE: "prod",
  CHART_PATH: "deploy/chart",
  CLUSTER_VALUE_FILES: JSON.stringify([
    { path: "clusters/platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
    { path: "clusters/platform/values-prod.yaml", content: "global:\n  env: prod\n" },
    { path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    vault:\n      url: https://vault.m1.example:8200\n" },
  ]),
  REPO_URL: "https://github.com/x/acme.git",
  REQUESTED_REF: "main",
  RESOLVED_SHA: "a".repeat(40),
  SOURCE_DIR: "/src",
  REPORT_OUT: "/out/report.json",
  RUNNER_VERSION: "t",
  KUBE_VERSION: "1.30.0",
  MUST_FAIL_TARGETS: "10.1.1.1:443",
  MANAGER_ADDR: "10.152.183.5:8080",
  MUST_PASS_TARGET: "github.com:443",
  CONFIRMED_LISTENING: "true",
} satisfies NodeJS.ProcessEnv;

function inputs(sourceDir: string, declaredListening = true): CliInputs {
  const i = parseEnv({ ...ENV, SOURCE_DIR: sourceDir });
  return { ...i, fence: { ...i.fence, declaredListening } };
}

// github reachable, everything internal blocked => fence green.
const green: ConnectFn = (host) => Promise.resolve(host === "github.com");
// the manager address is ALSO reachable => not denied => fence degraded.
const managerReachable: ConnectFn = (host) => Promise.resolve(host === "github.com" || host === "10.152.183.5");

describe("parseEnv", () => {
  it("parses a valid task env into CliInputs", () => {
    const i = parseEnv(ENV);
    expect(i.meta.targetName).toBe("acme");
    expect(i.meta.stage).toBe("prod");
    expect(i.meta.clusterValueFiles.map((f) => f.path)).toEqual([
      "clusters/platform/values-common.yaml",
      "clusters/platform/values-prod.yaml",
      clusterMapPath("m1.example"),
    ]);
    expect(i.fence.mustFailTargets).toEqual(["10.1.1.1:443"]);
    expect(i.fence.mustPassTarget).toBe("github.com:443");
  });
  it("throws on a missing required var, a bad STAGE, and malformed CLUSTER_VALUE_FILES", () => {
    expect(() => parseEnv({ ...ENV, TARGET_NAME: "" })).toThrow(/TARGET_NAME/);
    expect(() => parseEnv({ ...ENV, STAGE: "staging" })).toThrow(/STAGE/);
    expect(() => parseEnv({ ...ENV, CLUSTER_VALUE_FILES: "[not json" })).toThrow();
  });
});

// A REFUSED RUN READS NOTHING, AND THE REPORT HAS TO SAY SO. Measured on apps3 on 2026-08-26: the
// refusal returned a schema-valid report whose `gates` were empty and whose `manifest` was null, and
// the Manager composed its own gates on top and rejected the onboarding with "no build declared in
// deploy/platform.yaml" about a file declaring three. An empty gate list says only "no gate failed".
describe("runGateCli fail-closed", () => {
  it("refuses to read the repository when the Manager did not attest confirmed-listening, and names every gate that did not run", async () => {
    const report = await runGateCli(inputs(await ws(), false), green);
    expect(sandboxGreen(report.sandbox)).toBe(false);
    expect(report.verdict).toBe("fail");

    // ONE row, and it is the refusal — not an empty list, and not a check gate.
    expect(report.gates.map((g) => g.id)).toEqual([SANDBOX_FENCE_GATE_ID]);
    const refusal = report.gates[0];
    expect(refusal?.severity).toBe("hard");
    expect(refusal?.status).toBe("fail");
    expect(refusal?.reason).not.toBeNull();

    // Named one by one rather than counted: a count does not say which parts of the repository went
    // uninspected. The roster is derived, so a gate added to gate-list.ts is named without an edit here.
    expect(SANDBOX_GATE_IDS.length).toBeGreaterThan(0); // the loop below is not vacuous
    for (const id of SANDBOX_GATE_IDS) expect(refusal?.found).toContain(id);
  });

  it("refuses when the egress fence is not green (an internal target is reachable)", async () => {
    const report = await runGateCli(inputs(await ws()), managerReachable);
    expect(report.sandbox.managerAddrDenied).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(report.gates.map((g) => g.id)).toEqual([SANDBOX_FENCE_GATE_ID]);
  });

  // THE OUTCOME THAT MATTERS, and the one the apps3 report failed: a refused run's report cannot be
  // made to say ANYTHING about the repository. A tree that would fail G1 and a tree that would pass
  // it produce the identical rows, so nothing downstream can read a repository fault out of one.
  it("says the same thing about a repository whose manifest is fine and one that has no manifest at all", async () => {
    const good = await runGateCli(buildOnlyInputs(await buildOnlyRepo()), managerReachable);
    const empty = await runGateCli(buildOnlyInputs(await ws()), managerReachable);
    // THE LIST IS HELD NON-EMPTY FIRST, and that is not belt and braces. With gates: [] — the exact
    // apps3 shape — both `map` calls answer [] and both `gates[0]?.found` answer undefined, so every
    // comparison below holds on the very report this check exists to refuse. An assertion that
    // passes on the defect it is written against is not the one that catches it.
    expect(good.gates.length).toBeGreaterThan(0);
    expect(good.gates.map((g) => g.id)).toEqual(empty.gates.map((g) => g.id));
    expect(good.gates[0]?.found).toBe(empty.gates[0]?.found);
    expect(good.manifest).toBeNull();
    expect(empty.manifest).toBeNull();

    // INNOCENT CASE beside it: with the fence holding, those same two trees answer DIFFERENTLY — so
    // the sameness above is the refusal refusing to look, not a run that never looks at anything.
    const goodGreen = await runGateCli(buildOnlyInputs(await buildOnlyRepo()), green);
    const emptyGreen = await runGateCli(buildOnlyInputs(await ws()), green);
    expect(goodGreen.verdict).toBe("pass");
    expect(emptyGreen.verdict).toBe("fail");
    expect(goodGreen.manifest).not.toBeNull();
  });
});

describe("runGateCli green path", () => {
  it("runs the gates over the cloned workspace; a repo with no platform.yaml fails G1 (no render)", async () => {
    const dir = await ws();
    await writeFile(join(dir, "readme.txt"), "not a consumer repo");
    const report = await runGateCli(inputs(dir), green);
    expect(sandboxGreen(report.sandbox)).toBe(true);
    expect(report.gates.length).toBeGreaterThan(0); // G1 ran
    expect(report.gates[0]?.id).toBe("G1");
    expect(report.verdict).toBe("fail"); // G1 fails => plan rejected, render never attempted
  });
});

// A BUILD-ONLY unit — one whose manifest declares builds and no chart — is not an edge case: the
// platform's own manager and the tenant fan-out repo are both build-only, so this is the shape a
// from-zero master runs first. It has no chart directory, so the run carries no chart path at all.
//
// What used to happen: the empty string the Manager sent for "no chart" was read as an unset required
// input, the CLI threw before a single gate ran, and the whole PipelineRun died with a wiring
// complaint. What must happen now is that the absence is a form the gates know and REPORT.
const BUILD_ONLY_MANIFEST = [
  "apiVersion: hostyour.cloud/v1",
  "kind: ConsumerManifest",
  "name: acme",
  "owner: acme@example.invalid",
  "envs: [prod]",
  "builds:",
  "  - name: acme-api",
  "    containerfile: docker/Containerfile",
  "",
].join("\n");

/** A build-only repo on disk. `extraManifest` appends to the manifest so a test can plant a chart
 *  declaration into a unit the run says has none. */
async function buildOnlyRepo(extraManifest = ""): Promise<string> {
  const dir = await ws();
  await mkdir(join(dir, "deploy"), { recursive: true });
  await writeFile(join(dir, "deploy", "platform.yaml"), BUILD_ONLY_MANIFEST + extraManifest);
  await mkdir(join(dir, "docker"), { recursive: true });
  await writeFile(join(dir, "docker", "Containerfile"), "FROM scratch\n");
  return dir;
}

/** The env of a build-only run: everything as usual, and CHART_PATH carrying the empty string the
 *  Tekton param must hold (it is a declared string with no default, so the run cannot omit it). */
function buildOnlyInputs(sourceDir: string): CliInputs {
  return parseEnv({ ...ENV, SOURCE_DIR: sourceDir, CHART_PATH: "" });
}

describe("a unit that ships no chart", () => {
  it("parses an empty CHART_PATH as the absence of a chart instead of refusing the run", () => {
    expect(parseEnv({ ...ENV, CHART_PATH: "" }).meta.chartPath).toBeNull();
    expect(parseEnv({ ...ENV, CHART_PATH: "   " }).meta.chartPath).toBeNull();
    const { CHART_PATH: _unset, ...withoutChartPath } = ENV;
    expect(parseEnv(withoutChartPath).meta.chartPath).toBeNull();
    // The innocent case, so a null answer cannot mean the parse simply stopped reading the variable.
    expect(parseEnv(ENV).meta.chartPath).toBe("deploy/chart");
  });

  it("INNOCENT CASE: a build-only unit passes, and the gates that could not run are NAMED, not green", async () => {
    const report = await runGateCli(buildOnlyInputs(await buildOnlyRepo()), green);
    expect(sandboxGreen(report.sandbox)).toBe(true);
    expect(report.verdict).toBe("pass");

    const ran = report.gates.map((g) => g.id);
    expect(ran).toContain("G1"); // the manifest was read
    expect(ran).toContain("G3"); // the render phase reported the absence

    // The rendered-document gates judge documents this run never produced. Over zero documents each
    // of them would return a pass no chart could have made go red, and a reader cannot tell that
    // apart from a repository that was inspected and found clean — so none of them may appear.
    const skipped = POST_RENDER_GATES.map((g) => g.id);
    expect(skipped.length).toBeGreaterThan(0); // the exclusion below is not vacuous
    expect(ran.filter((id) => skipped.includes(id))).toEqual([]);

    // Named one by one rather than counted, in the phase that gates them.
    const g3 = report.gates.find((g) => g.id === "G3");
    expect(g3?.status).toBe("pass");
    for (const id of skipped) expect(g3?.found).toContain(id);

    // And the manifest gate says the unit is build-only rather than staying silent about the half it
    // never applied.
    const g1 = report.gates.find((g) => g.id === "G1");
    expect(g1?.status).toBe("pass");
    expect(g1?.found).toContain("no chart");
  });

  // HOW MUCH THIS COVERS: the ids a run reaches WITHOUT helm — the two pipeline phases and the
  // pre-render gate. The post-render gates need a real render, and they come out of the same array
  // the roster is built from, so they cannot differ from it. What this catches is a THIRD phase added
  // to pipeline.ts and not to gate-list.ts, which the derivation alone would not.
  it("emits no gate id the refusal roster does not name", async () => {
    const built = await runGateCli(buildOnlyInputs(await buildOnlyRepo()), green);
    expect(built.gates.length).toBeGreaterThan(0);
    for (const g of built.gates) expect(SANDBOX_GATE_IDS, `${g.id} is emitted but no refusal would name it`).toContain(g.id);
  });

  it("PLANTED DEFECT: a manifest that declares a chart is REFUSED when the run carries no chart path", async () => {
    const dir = await buildOnlyRepo("chart:\n  path: deploy/chart\n");
    await mkdir(join(dir, "deploy", "chart"), { recursive: true });
    await writeFile(join(dir, "deploy", "chart", "Chart.yaml"), "name: acme\nversion: 0.1.0\n");
    const report = await runGateCli(buildOnlyInputs(dir), green);

    expect(report.verdict).toBe("fail");
    const g1 = report.gates.find((g) => g.id === "G1");
    expect(g1?.status).toBe("fail");
    expect(g1?.reason).not.toBeNull();
    // The refusal must say which two sides disagree, so the answer is actionable in the CUSTOMER's
    // repository: it names the manifest's own declaration and the form the run was dispatched in.
    expect(g1?.found).toContain("deploy/platform.yaml");
    expect(g1?.found).toContain("build-only");
    // Nothing may be rendered or judged past a refused manifest.
    expect(report.gates.some((g) => g.id === "G3")).toBe(false);
  });
});
