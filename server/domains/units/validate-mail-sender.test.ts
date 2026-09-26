import { describe, it, expect } from "vitest";
import { validateOnboard, type OnboardTarget } from "./validate.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { APEX_CHAIN, FakeAttestedBuilds, SHA, deps, g1Pass, manifestWith, pinFile, report, req, target } from "./validate.fixture.ts";

/** APEX_CHAIN with the target's own map stating the tailnet address the relay reaches the entry on. */
const REACHABLE = APEX_CHAIN.map((f) => (f.path === clusterMapPath("s1.example") ? { ...f, content: `${f.content}  apiHost: 100.64.0.11\n` } : f));

describe("G29 mail sender — one stage, one unit carrying an SMTP entry", () => {
  const withEntry = (): ConsumerManifest => ({ ...manifestWith(["acme-api"]), smtpEntry: { service: "acme-mta", port: 2525 } });
  const run = (senders: { unit: string; cluster: string; entry: { service: string; port: number } }[], manifest: ConsumerManifest, on: OnboardTarget = target({ clusterValueFiles: REACHABLE })) =>
    validateOnboard(req(), on, deps(
      new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-dev.yaml": pinFile("acme-api") } }),
      new FakeGateRunner({ report: report(g1Pass, "pass", manifest) }),
      { registrations: new FakeAttestedBuilds([], senders) },
    ));

  it("passes the first sender of a stage, and a re-onboard of the sender itself", async () => {
    expect((await run([], withEntry())).report.gates.find((g) => g.id === "G29")).toMatchObject({ status: "pass", detail: "the stage's only mail sender" });
    const again = await run([{ unit: "acme", cluster: "apps1", entry: { service: "acme-mta", port: 2525 } }], withEntry());
    expect(again.report.gates.find((g) => g.id === "G29")?.status).toBe("pass");
  });

  it("refuses a second sender at the stage, naming the one that stands and its cluster", async () => {
    const outcome = await run([{ unit: "post", cluster: "apps1", entry: { service: "post-mta", port: 2525 } }], withEntry());
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "G29")).toMatchObject({ status: "fail", found: expect.stringContaining("post (on apps1)") });
  });

  it("refuses a sender whose target cluster's map carries no apiHost — the relay could not reach its entry", async () => {
    const outcome = await run([], withEntry(), target({ clusterValueFiles: APEX_CHAIN }));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "G29")).toMatchObject({ status: "fail", found: "the map of s1.example carries no global.apiHost" });
  });

  it("does not run for a unit that declares no SMTP entry, nor for a build-only target, which stands on no cluster", async () => {
    const outcome = await run([{ unit: "post", cluster: "apps1", entry: { service: "post-mta", port: 2525 } }], manifestWith(["acme-api"]));
    expect(outcome.report.gates.find((g) => g.id === "G29")).toBeUndefined();
    const { chartPath: _deployable, ...buildOnly } = target({ clusterValueFiles: [] });
    expect((await run([], withEntry(), buildOnly)).report.gates.find((g) => g.id === "G29")).toBeUndefined();
  });
});
