import { describe, it, expect } from "vitest";
import { RELEASE_TAG_RE, RELEASE_VERSION_RE, parseReleaseTag, nextReleaseVersion } from "./release.ts";

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

describe("three-digit versions (#303)", () => {
  it("accepts a third position of three digits, leading zeros included, beside the form that stands", () => {
    for (const tag of ["0.3.000-stable-20270101120000", "0.3.001-beta-20270101120000", "0.3.099-alpha-20270101120000", "0.1.16-stable-20260927135112"]) {
      expect(RELEASE_TAG_RE.test(tag), tag).toBe(true);
    }
    expect(RELEASE_VERSION_RE.test("0.3.000")).toBe(true);
    expect(parseReleaseTag("0.3.007-stable-20270101120000")).toEqual({ version: "0.3.007", channel: "stable", ts14: "20270101120000" });
  });

  it("still refuses a leading zero before the third position, and a third position of four digits with one", () => {
    for (const tag of ["03.1.000-stable-20270101120000", "0.03.000-stable-20270101120000", "0.3.0000-stable-20270101120000", "0.3.00-stable-20270101120000"]) {
      expect(RELEASE_TAG_RE.test(tag), tag).toBe(false);
    }
  });

  it("follows 0.3.000 with 0.3.001, 0.3.007 with 0.3.008 and 0.3.099 with 0.3.100, and keeps the form that stands", () => {
    expect(nextReleaseVersion(["0.3.000-stable-20270101120000"])).toBe("0.3.001");
    expect(nextReleaseVersion(["0.3.007-stable-20270101120000", "0.3.006-beta-20270101110000"])).toBe("0.3.008");
    expect(nextReleaseVersion(["0.3.099-stable-20270101120000"])).toBe("0.3.100");
    expect(nextReleaseVersion(["0.1.16-stable-20260927135112"])).toBe("0.1.17");
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


describe("future versions after historical tags", () => {
  it("keeps Core9 readable while proposing padded Core010", () => {
    const tag = "0.4.9-stable-20261004075646";
    expect(parseReleaseTag(tag)).toEqual({ version: "0.4.9", channel: "stable", ts14: "20261004075646" });
    expect(nextReleaseVersion([tag])).toBe("0.4.010");
  });
  it("proposes a padded first version for a new repository", () => {
    expect(nextReleaseVersion([])).toBe("0.1.000");
  });
});
