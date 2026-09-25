import { describe, it, expect } from "vitest";
import { FakeGitHubApp } from "./fake.ts";

// The fake holds the same contract the HTTP client is tested on (github-app-http.test.ts): a scripted
// token and owner, and a create that is idempotent by `org/name`. A run test that passes
// against a fake with a different belief about "already exists" proves nothing about the run.
describe("FakeGitHubApp", () => {
  it("answers the scripted token and owner", async () => {
    const fake = new FakeGitHubApp();
    fake.token = "ghs_scripted";
    fake.org = "acme";
    expect(await fake.installationToken()).toBe("ghs_scripted");
    expect(await fake.installationOrg()).toBe("acme");
    expect(fake.identityFingerprint()).toMatch(/^sha256:/);
  });

  it("creates a repository once and answers {created:false} for a seeded or repeated name", async () => {
    const fake = new FakeGitHubApp();
    fake.seedRepository("acme", "standing-apps");
    const input = { org: "acme", name: "new-apps", description: "d", private: true };
    expect(await fake.createRepository({ ...input, name: "standing-apps" })).toEqual({ created: false });
    expect(await fake.createRepository(input)).toEqual({ created: true });
    expect(await fake.createRepository(input)).toEqual({ created: false });
    expect(fake.hasRepository("acme", "new-apps")).toBe(true);
    // Only the call that made the repository is recorded — the same name twice is one create.
    expect(fake.created).toEqual([input]);
  });

  it("throws the scripted failure from every call", async () => {
    const fake = new FakeGitHubApp();
    fake.failWith = new Error("fake: the installation is suspended");
    await expect(fake.installationToken()).rejects.toThrow(/suspended/);
    await expect(fake.installationOrg()).rejects.toThrow(/suspended/);
    await expect(fake.createRepository({ org: "acme", name: "x", description: "", private: true })).rejects.toThrow(/suspended/);
  });
});
