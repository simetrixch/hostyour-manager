import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, runGateCli, type CliInputs } from "./cli.ts";
import type { ConnectFn } from "./fence.ts";
import { sandboxGreen } from "./report.ts";
import { clusterMapPath } from "../../shared/cluster-values.ts";

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

function inputs(sourceDir: string, confirmedListening = true): CliInputs {
  const i = parseEnv({ ...ENV, SOURCE_DIR: sourceDir });
  return { ...i, fence: { ...i.fence, confirmedListening } };
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

describe("runGateCli fail-closed", () => {
  it("refuses to render (gate-less degraded report) when the Manager did not attest confirmed-listening", async () => {
    const report = await runGateCli(inputs(await ws(), false), green);
    expect(report.gates).toHaveLength(0);
    expect(sandboxGreen(report.sandbox)).toBe(false);
    expect(report.verdict).toBe("fail");
  });
  it("refuses to render when the egress fence is not green (an internal target is reachable)", async () => {
    const report = await runGateCli(inputs(await ws()), managerReachable);
    expect(report.gates).toHaveLength(0);
    expect(report.sandbox.managerAddrDenied).toBe(false);
    expect(report.verdict).toBe("fail");
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
