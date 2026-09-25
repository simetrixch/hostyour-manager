import { describe, it, expect } from "vitest";
import { validateOnboard } from "./validate.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { GateRunner, GateJobProgress } from "../../adapters/gate-runner/port.ts";
import { MANIFEST_FED_GATE_IDS } from "./gates/compose.ts";
import { RELEASE_KIT_WORKFLOW } from "./release-kit/release-kit.ts";
import { SHA, req, target, report, g1Pass, g1Fail, FakeAttestedBuilds, deps, manifestWith, APEX_CHAIN, pinFile } from "./validate.fixture.ts";

/** The gates a passing onboarding is judged by: the sandbox's, then these from the Manager. The
 *  fixtures below emit the sandbox side as one G1, so the assertions on the composed report check
 *  the manager side against this tail. */
const MANAGER_GATES = ["G17", "G23", "G28", "G16", "G18", "G19", "G24"];

describe("validateOnboard", () => {
  it("pass: streams every gate, dispatches the gate-run, and emits the three manager gates", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const lines: string[] = [];
    const outcome = await validateOnboard(req(), target(), deps(repo, runner, { log: (l) => lines.push(l) }));

    expect(outcome.verdict).toBe("pass");
    expect(outcome.resolvedSha).toBe(SHA);
    expect(runner.submitted).toHaveLength(1);
    expect(runner.submitted[0]!.resolvedSha).toBe(SHA);
    expect(runner.submitted[0]).not.toHaveProperty("repoCredentialId");
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", ...MANAGER_GATES]);
    // Every gate reaches the run log — the sandbox ones as they land, the manager ones as they are
    // authored, so the card and the log agree on what was checked.
    expect(lines.some((l) => l.startsWith("G1 pass"))).toBe(true);
    expect(lines.some((l) => l.startsWith("G18 pass"))).toBe(true);
    expect(lines.some((l) => l.includes("cloned"))).toBe(true);
  });

  // WHAT THE FENCE PROOF RESTS ON, on the record of a run that PASSED it. Three of the four legs of
  // the sandbox attestation are probes the runner made from inside; the fourth — that the must-fail
  // targets were listening — is the Manager's word and nothing measures it, so a denied connect to a
  // target nobody proved was there proves nothing. Without this line a run that passed says none of that.
  it("writes what the fence proof rests on into the run log, naming the target nothing measured", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const declared = "10.1.1.9:16443";
    const passing = report(g1Pass, "pass", manifestWith(["acme-api"]));
    const runner = new FakeGateRunner({ report: { ...passing, sandbox: { ...passing.sandbox, mustFailTargets: [declared] } } });
    const lines: string[] = [];
    await validateOnboard(req(), target(), deps(repo, runner, { log: (l) => lines.push(l) }));
    // The target the fence was proven against is on the record, beside the fact that the Manager is
    // the only thing that said it was there.
    expect(lines.some((l) => l.includes(declared))).toBe(true);
  });

  it("emits G16 and G18 although the ref is NOT a release tag and the repo has never released", async () => {
    // Nothing about the gates hangs on a release identity any more: the channel ceiling is the
    // release pipeline's rule, and the image tag is the pipeline's to mint.
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req({ ref: "main" }), target(), deps(repo, runner));
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", ...MANAGER_GATES]);
    expect(outcome.verdict).toBe("pass");
  });

  it("a repo WITHOUT builds still shows every gate, and G18 hard-fails on the empty builds[]", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA });
    // A manifest with no builds must still deploy something, so it declares a chart.
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith([])) });
    const outcome = await validateOnboard(req(), target(), deps(repo, runner));
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", ...MANAGER_GATES]);
    const g18 = outcome.report.gates.find((g) => g.id === "G18");
    expect(g18?.severity).toBe("hard");
    expect(g18?.status).toBe("fail");
    expect(g18?.found).toBe("no build declared in deploy/platform.yaml");
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });

  it("build-only (no chartPath): G18 is emitted with both halves, the chart half reporting no object", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["manager"], false)) });
    const { chartPath: _chartPath, ...buildOnly } = target();
    const outcome = await validateOnboard(req(), buildOnly, deps(repo, runner));
    const g18 = outcome.report.gates.find((g) => g.id === "G18");
    expect(g18?.status).toBe("pass");
    expect(g18?.found).toContain("build-only — no chart to check");
    // The gate-run is dispatched with NO chart directory at all, and the absence is what the runner
    // reads. Travelling as an empty string makes the runner's CLI take it for an unset required
    // input and refuse — killing every build-only run before a gate could look at anything.
    expect(runner.submitted[0]!.chartPath).toBeUndefined();
    expect("chartPath" in runner.submitted[0]!).toBe(false);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.builds).toEqual(["manager"]);
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
    const outcome = await validateOnboard(req(), target(), deps(repo, runner, { registrations: attested }));
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
    const outcome = await validateOnboard(req(), target(), deps(repo, runner, { registrations: attested }));
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
    const outcome = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), deps(repo, runner, { registrations: attested }));
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

  // A MANAGER-SIDE GATE MUST NOT JUDGE A REPOSITORY FROM AN INPUT THE REPORT NEVER CARRIED.
  // Measured on a real installation: the report carried manifest null, and G16/G18/G19/G24 read that
  // as an empty declaration. G18 rejected the onboarding with "no build declared in
  // deploy/platform.yaml" about a file that declares three builds, and the person that sentence is
  // written for works in the customer's repository and never opens this source.
  describe("a report that carries no manifest", () => {
    it("does not run the manifest-fed gates, and no gate says anything about the repository's files", async () => {
      const repo = new FakeRepoReader({ resolvedSha: SHA });
      const runner = new FakeGateRunner({ report: report(g1Fail, "fail") });
      const outcome = await validateOnboard(req(), target(), deps(repo, runner));

      const ids = outcome.report.gates.map((g) => g.id);
      // The three manager-side gates whose subject the Manager holds itself still stand: the clone it
      // made, the name the operator submitted, and the workflow file. None reads the manifest.
      expect(ids).toEqual(["G1", "G17", "G23", "G28", "G26"]);
      expect(MANIFEST_FED_GATE_IDS.length).toBeGreaterThan(0); // the exclusion below is not vacuous
      expect(ids.filter((id) => MANIFEST_FED_GATE_IDS.includes(id))).toEqual([]);

      // The row that stands in their place says which ones did not run, one by one.
      const g26 = outcome.report.gates.find((g) => g.id === "G26");
      expect(g26?.severity).toBe("hard");
      expect(g26?.status).toBe("fail");
      expect(g26?.reason).not.toBeNull();
      for (const id of MANIFEST_FED_GATE_IDS) expect(g26?.found).toContain(id);

      // A run nothing could judge is not a run that passed.
      expect(outcome.verdict).toBe("fail");
      expect(outcome.builds).toBeNull();
    });

    it("holds for a build-only unit too — the form does not restore an input the report never carried", async () => {
      const repo = new FakeRepoReader({ resolvedSha: SHA });
      const runner = new FakeGateRunner({ report: report(g1Fail, "fail") });
      const { chartPath: _chartPath, ...buildOnly } = target();
      const outcome = await validateOnboard(req(), buildOnly, deps(repo, runner));
      expect(outcome.report.gates.map((g) => g.id)).toEqual(["G1", "G17", "G23", "G28", "G26"]);
      expect(outcome.verdict).toBe("fail");
    });

    // THE TENANT LIST IS READ UNCONDITIONALLY AND DELIBERATELY, above the branch, because G23 always
    // needs it — measured with a counting dependency: one read in a no-manifest run. So this holds
    // the REGISTRATION half alone, and says so: a title claiming the tenant list too is what somebody
    // greps for when they want to know whether that read is guarded, and it is not.
    it("reads no registration for gates that are not going to run", async () => {
      const repo = new FakeRepoReader({ resolvedSha: SHA });
      const runner = new FakeGateRunner({ report: report(g1Fail, "fail") });
      const attested = new FakeAttestedBuilds([{ unit: "unit-a", build: "shared-api" }]);
      await validateOnboard(req(), target(), deps(repo, runner, { registrations: attested }));
      expect(attested.asked).toEqual([]);
      expect(attested.askedFqdns).toEqual([]);
    });

    // THE ACCOUNTING CHECK, and it is what keeps MANIFEST_FED_GATE_IDS from going stale. Every
    // manager-side gate a full run emits must, in the no-manifest run, either RUN or be NAMED as one
    // that did not. A gate added to validateOnboard's manifest branch and forgotten in the list turns
    // this red instead of silently judging a repository from a default.
    it("accounts for every manager-side gate a full run emits", async () => {
      const repoFull = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
      // A FULL run is a deployable target on a chain that names the apex: G27 judges the zone under the
      // unit's host, and a chain naming none has no host to judge (that is the plan's refusal, not a gate).
      const full = await validateOnboard(
        req(),
        target({ clusterValueFiles: APEX_CHAIN }),
        deps(repoFull, new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) })),
      );
      const none = await validateOnboard(
        req(),
        target(),
        deps(new FakeRepoReader({ resolvedSha: SHA }), new FakeGateRunner({ report: report(g1Fail, "fail") })),
      );

      const managerSide = full.report.gates.map((g) => g.id).filter((id) => id !== "G1");
      const ran = none.report.gates.map((g) => g.id);
      expect(managerSide.length).toBeGreaterThan(0);
      const unaccounted = managerSide.filter((id) => !ran.includes(id) && !MANIFEST_FED_GATE_IDS.includes(id));
      expect(unaccounted, `manager-side gates a no-manifest run neither runs nor names as unrun: ${unaccounted.join(", ")}`).toEqual([]);
      // ...and the list names nothing that no run emits, so it cannot be padded into passing.
      for (const id of MANIFEST_FED_GATE_IDS) expect(managerSide).toContain(id);
    });

    // INNOCENT CASE: with a manifest in the report, G18 still reports the repository's own fault in
    // its own words — so the silence above is the absent input, not a gate that stopped judging.
    it("INNOCENT CASE: a manifest that really declares no build still fails G18, and G26 never appears", async () => {
      const repo = new FakeRepoReader({ resolvedSha: SHA });
      const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith([])) });
      const outcome = await validateOnboard(req(), target(), deps(repo, runner));
      const g18 = outcome.report.gates.find((g) => g.id === "G18");
      expect(g18?.status).toBe("fail");
      expect(g18?.found).toBe("no build declared in deploy/platform.yaml");
      expect(outcome.report.gates.some((g) => g.id === "G26")).toBe(false);
    });
  });

  it("private repo: the credential opens the Manager clone AND is passed to the gate-run so its pipeline can clone", async () => {
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

/** A runner whose poll never settles (or throws) — the manager-side view of a stuck or
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

// The passing runs above carry no workflow file, so "absent passes" is what every one of them proves;
// the kit's own bytes and an older kit are release-workflow.test.ts's. This is the wiring: the file
// is read off the Manager's own clone, and a foreign one rejects the run before anything is written.
describe("G28 release workflow — the kit's path is read at validation, before anything is written", () => {
  it("refuses a workflow the unit owns at the kit's path", async () => {
    const files = { "deploy/chart/values-dev.yaml": pinFile("acme-api"), [RELEASE_KIT_WORKFLOW.path]: "name: Publish\non:\n  push:\n    tags: ['v*.*.*']\njobs: {}\n" };
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req(), target(), deps(new FakeRepoReader({ resolvedSha: SHA, files }), runner));
    const g28 = outcome.report.gates.find((g) => g.id === "G28");
    expect(g28).toMatchObject({ severity: "hard", status: "fail" });
    expect(g28?.found).toContain(RELEASE_KIT_WORKFLOW.path);
    expect(g28?.reason).toMatch(/move it to another file/);
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
  });
});

describe("G27 unit host — the zone is read at validation, before anything is written", () => {
  it("runs for a deployable target whose chain names the apex, and a leftover passes with the record it will replace", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const asked: string[] = [];
    const outcome = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), deps(repo, runner, {
      standingHost: async (host, clusterFqdn) => { asked.push(`${host} on ${clusterFqdn}`); return { kind: "leftover", type: "A", content: "157.90.201.150" }; },
    }));
    expect(asked).toEqual(["acme.dev.units.example.com on s1.example"]);
    const g27 = outcome.report.gates.find((g) => g.id === "G27");
    expect(g27?.status).toBe("pass");
    expect(g27?.found).toContain("157.90.201.150");
    expect(outcome.verdict).toBe("pass");
  });

  it("rejects the onboarding on a collision with another cluster of this installation — no step has run", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const outcome = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), deps(repo, runner, {
      standingHost: async () => ({ kind: "collision", cluster: "s2.example" }),
    }));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.builds).toBeNull();
    expect(outcome.report.gates.find((g) => g.id === "G27")?.found).toContain("s2.example");
  });

  it("rejects a deployable target on a manager with no DNS provider, where provision-dns would have died at step thirteen", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"])) });
    const d = deps(repo, runner);
    delete (d as { standingHost?: unknown }).standingHost;
    const outcome = await validateOnboard(req(), target({ clusterValueFiles: APEX_CHAIN }), d);
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "G27")?.found).toContain("no DNS provider");
  });

  it("does not run for a build-only unit — nothing is written under a host", async () => {
    const repo = new FakeRepoReader({ resolvedSha: SHA });
    const runner = new FakeGateRunner({ report: report(g1Pass, "pass", manifestWith(["acme-api"], false)) });
    const { chartPath: _chartPath, ...buildOnly } = target({ clusterValueFiles: APEX_CHAIN });
    const outcome = await validateOnboard(req(), buildOnly, deps(repo, runner, {
      standingHost: async () => ({ kind: "collision", cluster: "s2.example" }),
    }));
    expect(outcome.report.gates.find((g) => g.id === "G27")).toBeUndefined();
  });
});
