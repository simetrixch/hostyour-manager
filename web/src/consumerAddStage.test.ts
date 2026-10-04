import { describe, expect, it } from "vitest";
import { addStageHref, addStageForm } from "./consumerAddStage.ts";

const prod = { name: "acme", stage: "prod" as const, repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart" };

describe("a consumer's Add stage", () => {
  it("opens the onboard form at the stage pressed, carrying what the standing stage already states", () => {
    const href = addStageHref(prod, "test");
    expect(href.startsWith("/consumers/onboard?")).toBe(true);
    const form = addStageForm(new URLSearchParams(href.slice(href.indexOf("?") + 1)));
    expect(form).toEqual({ consumerName: "acme", repoURL: "https://github.com/x/acme.git", stage: "test", chartPath: "deploy/chart" });
  });
  it("is no Add stage at all without a stage that may be added", () => {
    expect(addStageForm(new URLSearchParams("name=acme&repo=https://github.com/x/acme.git"))).toBeNull();
    expect(addStageForm(new URLSearchParams("name=acme&repo=https://github.com/x/acme.git&stage=qa"))).toBeNull();
  });
});
