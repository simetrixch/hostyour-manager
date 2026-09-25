import { describe, it, expect } from "vitest";
import { RELEASE_TAG_RE, parseReleaseTag, nextReleaseVersion } from "./release.ts";

describe("release tag grammar", () => {
  it("accepts x.y.z-<channel>-<ts14> for every channel", () => {
    expect(RELEASE_TAG_RE.test("0.6.0-stable-20260719120000")).toBe(true);
    expect(RELEASE_TAG_RE.test("1.4.0-beta-20260718150233")).toBe(true);
    expect(RELEASE_TAG_RE.test("10.20.30-alpha-19991231235959")).toBe(true);
  });

  it("rejects malformed tags", () => {
    expect(RELEASE_TAG_RE.test("0.6.0")).toBe(false); // no channel/ts
    expect(RELEASE_TAG_RE.test("0.6.0-stable")).toBe(false); // no ts
    expect(RELEASE_TAG_RE.test("v0.6.0-stable-20260719120000")).toBe(false); // leading v
    expect(RELEASE_TAG_RE.test("0.6.0-rc-20260719120000")).toBe(false); // unknown channel
    expect(RELEASE_TAG_RE.test("0.6.0-stable-2026071912")).toBe(false); // short ts
    expect(RELEASE_TAG_RE.test("0.6.0-stable-20260719120000-abc123")).toBe(false); // image tag, not release tag
    expect(RELEASE_TAG_RE.test("01.2.3-stable-20260719120000")).toBe(false); // leading zero segment
  });

  it("parses the parts", () => {
    expect(parseReleaseTag("0.6.0-stable-20260719120000")).toEqual({
      version: "0.6.0",
      channel: "stable",
      ts14: "20260719120000",
    });
    expect(parseReleaseTag("nope")).toBeNull();
  });

  it("RELEASE_TAG_RE is anchored (no substring matches)", () => {
    expect(RELEASE_TAG_RE.test("prefix 0.6.0-stable-20260719120000")).toBe(false);
  });
});

describe("nextReleaseVersion", () => {
  it("takes the highest release version across every channel and bumps the patch", () => {
    expect(nextReleaseVersion(["0.1.0-stable-20260909094733", "0.1.2-stable-20260909121415", "0.1.1-beta-20260909114034"])).toBe("0.1.3");
  });

  it("compares numerically, so 0.8.10 stands above 0.8.9", () => {
    expect(nextReleaseVersion(["0.8.9-stable-20260901000000", "0.8.10-stable-20260902000000"])).toBe("0.8.11");
  });

  it("passes over what is not a release tag — a v prefix, an image tag, a deploy ref", () => {
    expect(nextReleaseVersion(["v2.0.0", "0.1.2-stable-20260909121415-77dba19", "deploy/prod/0.1.2-stable-20260909121415", "0.1.2-stable-20260909121415"])).toBe("0.1.3");
  });

  it("starts a repository with no release at 0.1.0, or at what the caller names", () => {
    expect(nextReleaseVersion([])).toBe("0.1.0");
    expect(nextReleaseVersion(["v1"], "1.0.0")).toBe("1.0.0");
  });
});
