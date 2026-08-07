import { describe, it, expect } from "vitest";
import { RELEASE_TAG_RE, parseReleaseTag } from "./release.ts";

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
