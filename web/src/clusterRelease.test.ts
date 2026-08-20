import { describe, it, expect } from "vitest";
import { releaseChip } from "./clusterRelease.ts";

// The Releases panel and every server card read a version out of exactly one place. What these cases
// guard is the empty case: a cluster nothing has pinned must come out of here saying so, because the
// alternative — printing whatever version happens to be nearby — is unfalsifiable on the screen.

const TAG = "1.2.0-stable-20260728120000";

describe("releaseChip", () => {
  it("prints the pinned tag WHOLE and says where it stands", () => {
    const chip = releaseChip({ kind: "pinned", tag: TAG });
    expect(chip?.label).toBe(`release: ${TAG}`);
    expect(chip?.detail).toContain("The cluster map pins");
    expect(chip?.detail).toContain(TAG);
    expect(chip?.className).not.toContain("warn");
  });

  it("a cluster with no pin reads UNKNOWN and carries no version at all", () => {
    // THE counter-probe, at the surface an operator actually looks at. The reason names the case;
    // the label may not name a version, because none was stated.
    const chip = releaseChip({ kind: "unknown", reason: "clusters/active/s1.example.com.yaml carries no release key" });
    expect(chip?.label).toBe("release: unknown");
    expect(chip?.label).not.toMatch(/\d+\.\d+\.\d+/);
    expect(chip?.className).toContain("warn");
    expect(chip?.detail).toContain("carries no release key");
  });

  it("carries the reason through verbatim, whichever of the empty cases it was", () => {
    for (const reason of [
      "no cluster map for s1.example.com",
      "the platform repo is not configured (GITHUB_REPO/GITHUB_WRITE_PAT unset)",
    ]) {
      expect(releaseChip({ kind: "unknown", reason })?.detail).toContain(reason);
    }
  });

  it("a machine that is not a cluster gets NO chip — it stands on no release and never did", () => {
    expect(releaseChip({ kind: "no-cluster" })).toBeNull();
  });
});
