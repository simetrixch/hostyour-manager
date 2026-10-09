import { describe, expect, it } from "vitest";
import { onboardInput, type OnboardFormFields } from "./onboardInput.ts";

const FIELDS: OnboardFormFields = {
  consumerName: " acme ", repoURL: " https://github.com/x/acme.git ", stage: "prod", clusterId: "cls_1", owner: " team ", chartPath: "deploy/chart", size: "small",
};

describe("onboardInput", () => {
  it("PLANTED: a CI-only unit sends the form and the three things it names, and no stage, cluster, chart or size even when the form still holds them", () => {
    expect(onboardInput("ci-only", FIELDS)).toEqual({ form: "ci-only", consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team" });
  });

  it("a deployable unit keeps its cluster, stage, chart and size, and carries no form", () => {
    expect(onboardInput("deployable", FIELDS)).toEqual({
      consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team", stage: "prod", clusterId: "cls_1", chartPath: "deploy/chart", size: "small",
    });
  });

  it("a build-only unit sends its stage and size but no cluster", () => {
    const input = onboardInput("build-only", { ...FIELDS, chartPath: " " });
    expect(input).toMatchObject({ stage: "prod", size: "small" });
    expect(input).not.toHaveProperty("clusterId");
    expect(input).not.toHaveProperty("chartPath");
    expect(input).not.toHaveProperty("form");
  });
});
