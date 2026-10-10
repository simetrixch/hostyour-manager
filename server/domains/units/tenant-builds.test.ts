import { describe, it, expect } from "vitest";
import { resolveBuildUnits, channelReaching } from "./tenant-builds.ts";

// The two answers a tenant's build plan rests on, which need no run: the build units, and the channel a
// stage is served from. The steps that build are proven in create-tenant-builds.run.test.ts.

const JOBS_REPO = "https://github.com/acme/example-jobs.git";
const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
const BUILD_REPOS = [{ repo: JOBS_REPO, builds: ["example-jobs"] }, { repo: PLATFORM_REPO, builds: ["example-engine"] }];

describe("resolveBuildUnits — the missing images grouped by the repository that builds them", () => {
  it("one unit per repository, named by the repository, registered or not; an image nobody builds is unmapped", async () => {
    const r = await resolveBuildUnits({
      missing: [{ repo: "example-jobs", tag: "0.2.0" }, { repo: "example-engine", tag: "0.4.0" }, { repo: "example-nobody", tag: "1" }],
      buildRepos: BUILD_REPOS,
      registration: async (unit) => (unit === "example-platform" ? { form: "build-only" } : null),
    });
    expect(r.units).toEqual([
      { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false },
      { unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-engine"], registered: true, form: "build-only" },
    ]);
    expect(r.unmapped).toEqual([{ repo: "example-nobody", tag: "1" }]);
  });
});

describe("channelReaching — the highest channel whose ceiling admits the stage", () => {
  const table = { alpha: ["dev" as const], beta: ["dev" as const, "test" as const], stable: ["dev" as const, "test" as const, "prod" as const] };
  it("stable for prod, stable for dev too (a tenant is never a pre-release), refused where nothing reaches", () => {
    expect(channelReaching(table, "prod")).toBe("stable");
    expect(channelReaching(table, "dev")).toBe("stable");
    expect(() => channelReaching({ alpha: ["dev"] }, "prod")).toThrow(/no release channel reaches stage prod/);
  });
});
