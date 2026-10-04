import { describe, expect, it } from "vitest";
import { addStageHref, addStageForm, admittedStage } from "./consumerAddStage.ts";

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

describe("admittedStage", () => {
  it("keeps the stage while the channel table is not read, and while the channel admits it", () => {
    expect(admittedStage("test", null)).toBe("test");
    expect(admittedStage("test", ["dev", "test", "prod"])).toBe("test");
  });
  it("clears a stage the channel the repository answered does not admit, so select and submit agree", () => {
    expect(admittedStage("prod", ["dev"])).toBe("");
  });
});
