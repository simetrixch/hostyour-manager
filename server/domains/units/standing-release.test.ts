import { describe, expect, it } from "vitest";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { standingRelease } from "./standing-release.ts";

// A new stage of an app is put on a release that stands, never on a new build: the one the most
// production-near stage runs. Only an app no stage of which runs a release mints one.

const V7 = "0.4.007-stable-20261001100000";
const V8 = "0.4.008-stable-20261003100000";
const BETA = "0.4.009-beta-20261005145138";
const commit = (c: string): string => c.repeat(40);
const read = { owner: "acme-org", repo: "post", token: "t" };

function repository(branches: Record<string, string>): FakeGitHubConsumer {
  const github = new FakeGitHubConsumer();
  github.seedTags("acme-org", "post", [{ name: V7, commit: commit("a") }, { name: V8, commit: commit("b") }, { name: BETA, commit: commit("c") }, { name: `deploy/prod/${V7}`, commit: commit("a") }]);
  // Each delivery branch stands on the pin commit made on top of its release's commit.
  for (const [stage, release] of Object.entries(branches)) github.seedBranch("acme-org", "post", `deploy/${stage}`, { sha: commit(stage[0]!), parents: [release] });
  return github;
}

describe("standingRelease", () => {
  it("PLANTED DEFECT: answers the release prod runs, not the newest release and not the one another stage runs", async () => {
    const github = repository({ prod: commit("a"), test: commit("c") });
    expect(await standingRelease(github, read)).toEqual({ tag: V7, version: "0.4.007", channel: "stable", from: "prod" });
  });

  it("answers the release the most production-near stage runs where prod runs none", async () => {
    expect(await standingRelease(repository({ test: commit("b") }), read)).toEqual({ tag: V8, version: "0.4.008", channel: "stable", from: "test" });
    expect(await standingRelease(repository({ dev: commit("c") }), read)).toEqual({ tag: BETA, version: "0.4.009", channel: "beta", from: "dev" });
  });

  it("answers none for an app no stage of which runs a release: its first onboarding mints one", async () => {
    expect(await standingRelease(repository({}), read)).toBeNull();
  });
});
