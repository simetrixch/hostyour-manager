import { describe, it, expect } from "vitest";
import { Registrations, isCiOnly } from "./registrations.ts";
import { FakePlatformRepo } from "#core/server/adapters/git/testing/fake.ts";
import { seedQuota } from "../shared/unit-size.ts";

const unit = (name: string) => ({ name, repoURL: `https://github.com/x/${name}.git`, suspended: false, quiesced: false });

describe("which units only run CI", () => {
  it("marks a unit when its build.yaml builds nothing and no stage file deploys it, and no other unit", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await reg.createBuildRegistration({ unit: unit("ci"), builds: [], runId: "run_1" }, () => undefined);
    await reg.createBuildRegistration({ unit: unit("builds"), builds: ["builds-api"], runId: "run_2" }, () => undefined);
    // Planted innocent: a unit that deploys a chart and builds no image of its own also has an empty list.
    await reg.commitRegistration({
      unit: unit("chart-only"),
      builds: [],
      deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", host: "chart-only", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
      runId: "run_3",
    });
    const flags = Object.fromEntries((await reg.listBuildRegistrations()).map((r) => [r.unit, r.ciOnly]));
    expect(flags).toEqual({ ci: true, builds: false, "chart-only": false });
  });

  it("isCiOnly reads the two facts and nothing else", () => {
    expect(isCiOnly({ builds: [] }, [])).toBe(true);
    expect(isCiOnly({ builds: ["a"] }, [])).toBe(false);
    expect(isCiOnly({ builds: [] }, ["prod"])).toBe(false);
    expect(isCiOnly({}, [])).toBe(false);
  });

  it("writes a build registration with no builds as 'none' in its commit message", async () => {
    const repo = new FakePlatformRepo();
    await new Registrations(repo).createBuildRegistration({ unit: unit("ci"), builds: [], runId: "run_1" }, () => undefined);
    expect(repo.commits.at(-1)?.message).toMatch(/^register\(ci\): build none /);
  });
});
