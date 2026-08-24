import { describe, it, expect } from "vitest";
import { validateOnboard, type OnboardTarget, type OnboardRequest, type ValidateDeps, type AttestedBuildReader, type AttestedFqdnReader } from "./validate.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { GateRunner, GateJobProgress } from "../../adapters/gate-runner/port.ts";
import type { GateReport, GateResult } from "../../../shared/gates.ts";
import { ConsumerManifestSchema, type ConsumerManifest } from "../../../shared/consumer.ts";

const SHA = "a".repeat(40);
const RELEASE = "1.4.0-stable-20260719120000";

/** The gates a passing onboarding is judged by: the sandbox's, then these from the Controller. The
 *  fixtures below emit the sandbox side as one G1, so the assertions on the composed report check
 *  the controller side against this tail. */
const CONTROLLER_GATES = ["G17", "G23", "G16", "G18", "G19"];

function req(over: Partial<OnboardRequest> = {}): OnboardRequest {
  return { repoURL: "https://github.com/x/acme.git", ref: RELEASE, consumerName: "acme", ...over };
}

function target(over: Partial<OnboardTarget> = {}): OnboardTarget {
  return {
    domain: "s1.example",
    stage: "dev",
    chartPath: "deploy/chart",
    clusterValueFiles: [
      { path: "platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
      { path: "platform/values-dev.yaml", content: "global:\n  env: dev\n" },
      { path: "installation/profile.yaml", content: "global:\n  endpoints:\n    vault:\n      url: https://vault.s1.example:8200\n" },
    ],
    ...over,
  };
}

function report(gate: GateResult, verdict: "pass" | "fail", manifest: ConsumerManifest | null = null): GateReport {
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "main", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [], gates: [gate],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
    verdict, reportHash: "runner-hash",
  };
}

const g1Pass: GateResult = { id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "deploy/platform.yaml validates", found: "parsed", reason: null, detail: "ok" };
const g1Fail: GateResult = { id: "G1", title: "manifest present", severity: "hard", status: "fail", expected: "deploy/platform.yaml validates", found: "missing", reason: "no manifest; the plan is rejected", detail: "missing" };

/** In-memory registration reader — the build names and fqdns OTHER units have registered. */
class FakeAttestedBuilds implements AttestedBuildReader, AttestedFqdnReader {
  readonly asked: string[] = [];
  readonly askedFqdns: string[] = [];
  constructor(
    private readonly attested: { unit: string; build: string }[] = [],
    private readonly fqdns: { unit: string; stage: "dev" | "test" | "prod"; fqdn: string }[] = [],
  ) {}
  async listAttestedBuildNames(exceptUnit: string): Promise<{ unit: string; build: string }[]> {
    this.asked.push(exceptUnit);
    return this.attested.filter((a) => a.unit !== exceptUnit);
  }
  async listAttestedFqdns(except: { unit: string; stage: "dev" | "test" | "prod" }): Promise<{ unit: string; stage: "dev" | "test" | "prod"; fqdn: string }[]> {
    this.askedFqdns.push(`${except.unit}@${except.stage}`);
    return this.fqdns.filter((a) => !(a.unit === except.unit && a.stage === except.stage));
  }
}

function deps(repo: RepoReader, runner: GateRunner, over: Partial<ValidateDeps> = {}): ValidateDeps {
  return { repo, runner, registry: new FakeAttestedBuilds(), tenantSubdomains: async () => [], log: () => {}, signal: new AbortController().signal, attestListening: true, ...over };
}

/** A manifest that declares `builds`, with a chart unless `chart` is false. */
function manifestWith(builds: string[], chart = true, fqdn?: string): ConsumerManifest {
  return ConsumerManifestSchema.parse({
    apiVersion: "hostyour.cloud/v1",
    kind: "ConsumerManifest", mongodb: "shared" as const,
    name: "acme",
    owner: "team-acme",
    envs: ["dev"],
    ...(chart ? { chart: { path: "deploy/chart" } } : {}),
    builds: builds.map((name) => ({ name, containerfile: `${name}/Containerfile` })),
    ...(fqdn !== undefined ? { fqdn } : {}),
  });
}

/** A values chain that states the unitApex — what G19 holds a declared fqdn's suffix against. */
const APEX_CHAIN = [
  { path: "platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
  { path: "platform/values-dev.yaml", content: "global:\n  env: dev\n" },
  { path: "installation/profile.yaml", content: "global:\n  unitApex: units.example.com\n" },
];

const pinFile = (...images: string[]): string =>
  ["builds:", ...images.map((i) => `  - name: ${i}\n    image: ${i}\n    tag: "0.0.0-placeholder"`)].join("\n") + "\n";

describe("validateOnboard", () => {
  it("pass: streams every gate, dispatches the gate-run, and emits the three controller gates", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const lines: string[] = [];
    const outcome = await validateOnboard(req(), target(), deps(repo, runner, { log: (l) => lines.push(l) }));

    expect(outcome.verdict).toBe("pass");
    expect(outcome.resolvedSha).toBe(SHA);
    expect(runner.submitted).toHaveLength(1);
    expect(runner.submitted[0]!.resolvedSha).toBe(SHA);
    expect(runner.submitted[0]).not.toHaveProperty("repoCredentialId");
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", ...CONTROLLER_GATES]);
    // Every gate reaches the run log — the sandbox ones as they land, the controller ones as they are
    // authored, so the card and the log agree on what was checked.
    expect(lines.some((l) => l.startsWith("G1 pass"))).toBe(true);
    expect(lines.some((l) => l.startsWith("G18 pass"))).toBe(true);
    expect(lines.some((l) => l.includes("cloned"))).toBe(true);
  });

  it("emits G16 and G18 although the ref is NOT a release tag and the repo has never released", async () => {
    // Nothing about the gates hangs on a release identity any more: the channel ceiling is the
    // release pipeline's rule, and the image tag is the pipeline's to mint.
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req({ ref: "main" }), target(), deps(repo, runner));
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", ...CONTROLLER_GATES]);
    expect(outcome.verdict).toBe("pass");
  });

  it("a repo WITHOUT builds still shows every gate, and G18 hard-fails on the empty builds[]", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA });
    // A manifest with no builds must still deploy something, so it declares a chart.
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith([])) });
    const outcome = await validateOnboard(req(), target(), deps(repo, runner));
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", ...CONTROLLER_GATES]);
    const g18 = outcome.report.gates.find((g) => g.id === "G18");
    expect(g18?.severity).toBe("hard");
    expect(g18?.status).toBe("fail");
    expect(g18?.found).toBe("no build declared in deploy/platform.yaml");
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });

  it("build-only (no chartPath): G18 is emitted with both halves, the chart half reporting no object", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["controller"], false)) });
    const { chartPath: _chartPath, ...buildOnly } = target();
    const outcome = await validateOnboard(req(), buildOnly, deps(repo, runner));
    const g18 = outcome.report.gates.find((g) => g.id === "G18");
    expect(g18?.status).toBe("pass");
    expect(g18?.found).toContain("build-only — no chart to check");
    // The gate-run is dispatched without a chart directory; the runner keys its chart checks on the
    // manifest's own chart block, which a build-only manifest does not carry.
    expect(runner.submitted[0]!.chartPath).toBe("");
    expect(outcome.verdict).toBe("pass");
    expect(outcome.builds).toEqual(["controller"]);
  });

  it("G18 hard-fails when the chart does not pin a declared build", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api", "acme-worker"])) });
    const outcome = await validateOnboard(req(), target(), deps(repo, runner));
    const g18 = outcome.report.gates.find((g) => g.id === "G18");
    expect(g18?.status).toBe("fail");
    expect(g18?.found).toContain("acme-worker");
    expect(outcome.verdict).toBe("fail");
  });

  it("G16 hard-fails naming the unit that already attested the build name", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("shared-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["shared-api"])) });
    const attested = new FakeAttestedBuilds([{ unit: "unit-a", build: "shared-api" }]);
    const outcome = await validateOnboard(req(), target(), deps(repo, runner, { registry: attested }));
    expect(attested.asked).toEqual(["acme"]); // the candidate's own registration is excluded
    const g16 = outcome.report.gates.find((g) => g.id === "G16");
    expect(g16?.status).toBe("fail");
    expect(g16?.found).toContain("unit-a");
    expect(g16?.found).toContain("shared-api");
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });

  it("G19 passes without touching the registrations when the manifest declares no fqdn", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const attested = new FakeAttestedBuilds([], [{ unit: "unit-a", stage: "prod", fqdn: "shop.example.org" }]);
    const outcome = await validateOnboard(req(), target(), deps(repo, runner, { registry: attested }));
    const g19 = outcome.report.gates.find((g) => g.id === "G19");
    expect(g19?.status).toBe("pass");
    expect(g19?.found).toContain("no fqdn declared");
    expect(attested.askedFqdns).toEqual([]); // nothing declared, nothing read
    expect(outcome.verdict).toBe("pass");
  });

  it("G19 hard-fails a declared fqdn another unit has attested, naming that unit's registration file", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"], true, "shop.example.org")) });
    const attested = new FakeAttestedBuilds([], [{ unit: "unit-a", stage: "prod", fqdn: "shop.example.org" }]);
    const outcome = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), deps(repo, runner, { registry: attested }));
    expect(attested.askedFqdns).toEqual(["acme@dev"]); // only the candidate's own registration AT THIS STAGE is excluded
    const g19 = outcome.report.gates.find((g) => g.id === "G19");
    expect(g19?.status).toBe("fail");
    expect(g19?.found).toContain("registrations/unit-a/prod.yaml");
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });

  it("G19 hard-fails a declared fqdn under the target cluster's unitApex, and passes one outside it", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const under = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"], true, "other.units.example.com")) });
    const refused = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), deps(repo, under));
    const g19 = refused.report.gates.find((g) => g.id === "G19");
    expect(g19?.status).toBe("fail");
    expect(g19?.found).toContain("units.example.com");
    expect(refused.verdict).toBe("fail");

    const outside = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"], true, "shop.example.org")) });
    const granted = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), deps(repo, outside));
    expect(granted.report.gates.find((g) => g.id === "G19")?.status).toBe("pass");
    expect(granted.verdict).toBe("pass");
  });

  it("G23 hard-fails a consumer named into another unit's build namespace — the AppProject would be pinned there", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req({ consumerName: "example-auth-build" }), target(), deps(repo, runner));
    const g23 = outcome.report.gates.find((g) => g.id === "G23");
    expect(g23?.status).toBe("fail");
    expect(g23?.found).toContain('"example-auth"');
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });

  it("G23 hard-fails a consumer named after a platform namespace — the chart would sync into it", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req({ consumerName: "mongodb" }), target(), deps(repo, runner));
    const g23 = outcome.report.gates.find((g) => g.id === "G23");
    expect(g23?.status).toBe("fail");
    expect(g23?.found).toContain("platform namespace");
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });

  it("fail: a failing hard sandbox gate yields verdict fail and no builds", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA });
    const runner = new FakeGateRunner({ report: report(g1Fail, "fail") });
    const outcome = await validateOnboard(req(), target(), deps(repo, runner));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
    // the full report is still returned so the operator sees every expected/found/reason.
    expect(outcome.report.gates.find((g) => g.id === "G1")?.reason).not.toBeNull();
  });

  it("private repo: the credential opens the Controller clone AND is passed to the gate-run so its pipeline can clone", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req({ repoCredentialId: "cred_9" }), target(), deps(repo, runner));
    expect(repo.clones[0]?.credentialId).toBe("cred_9");
    expect(runner.submitted[0]?.repoCredentialId).toBe("cred_9");
    expect(outcome.verdict).toBe("pass");
  });

  it("clone failure throws (the caller records it as a G17 preflight rejection)", async () => {
    const throwingRepo: RepoReader = {
      cloneAtRef: async () => { throw errValidation("clone failed: authentication required"); },
      readFile: async () => null,
      listDir: async () => [],
      dispose: async () => {},
    };
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass") });
    await expect(validateOnboard(req(), target(), deps(throwingRepo, runner))).rejects.toThrow(/clone failed/);
    expect(runner.submitted).toHaveLength(0);
  });
});

/** A runner whose poll never settles (or throws) — the controller-side view of a stuck or
 *  errored gate-run. Records cancel calls so the tests can assert the reap. */
class StuckRunner implements GateRunner {
  readonly cancelled: string[] = [];
  constructor(private readonly pollBehavior: () => GateJobProgress) {}
  async submit(): Promise<{ jobId: string }> { return { jobId: "job_stuck" }; }
  async poll(): Promise<GateJobProgress> { return this.pollBehavior(); }
  async cancel(jobId: string): Promise<void> { this.cancelled.push(jobId); }
}

describe("validateOnboard — every poll exit reaps the gate objects", () => {
  const gating: GateJobProgress = { phase: "gating", gatesSoFar: [] };
  const repo = (): FakeRepoReader => new FakeRepoReader({ resolvedSha: SHA });

  it("abort mid-poll cancels the gate job — the PAT-bearing credential Secret must not outlive the validation", async () => {
    const runner = new StuckRunner(() => gating);
    const ctrl = new AbortController();
    const p = validateOnboard(req(), target(), deps(repo(), runner, { signal: ctrl.signal, pollIntervalMs: 2 }));
    setTimeout(() => ctrl.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.cancelled).toEqual(["job_stuck"]);
  });

  it("one failing poll cancels before the error surfaces — a transient API error must not leak the objects", async () => {
    const runner = new StuckRunner(() => { throw new Error("read PipelineRun: 500"); });
    await expect(validateOnboard(req(), target(), deps(repo(), runner))).rejects.toThrow(/500/);
    expect(runner.cancelled).toEqual(["job_stuck"]);
  });

  it("the poll has a terminating deadline — a PipelineRun that never settles fails the validation instead of polling forever", async () => {
    const runner = new StuckRunner(() => gating);
    const p = validateOnboard(req(), target(), deps(repo(), runner, { pollIntervalMs: 1, pollBudgetMs: 15 }));
    await expect(p).rejects.toThrow(/did not settle within 15ms/);
    expect(runner.cancelled).toEqual(["job_stuck"]);
  });
});
