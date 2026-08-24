// Guards the embedded release-kit assets against corruption: the three files
// are loaded VERBATIM from ./assets, and their target paths are the single source of truth for the
// onboard write + the offboard/purge git-rm. A build/copy that mangled the scripts (a template-literal
// escape, a line-ending rewrite) or dropped a file would break every consumer's release flow silently,
// so this pins the paths exactly and asserts a stable sentinel line per file survived the bytes.
import { describe, it, expect } from "vitest";
import { RELEASE_KIT_FILES, RELEASE_KIT_PATHS } from "./release-kit.ts";

describe("release-kit embedded assets", () => {
  it("exposes exactly the three consumer-repo target paths (the single source of truth)", () => {
    expect(RELEASE_KIT_PATHS).toEqual(["release/release.ps1", "release/release.sh", ".github/workflows/release.yml"]);
    // RELEASE_KIT_PATHS is derived from RELEASE_KIT_FILES — they can never drift.
    expect(RELEASE_KIT_FILES.map((f) => f.path)).toEqual([...RELEASE_KIT_PATHS]);
  });

  it("loads each file non-empty, with a sentinel line proving the verbatim bytes survived", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));

    const ps1 = byPath["release/release.ps1"]!;
    expect(ps1.length).toBeGreaterThan(0);
    expect(ps1).toContain("[CmdletBinding()]");
    // A $()/$var line — exactly what a template literal would have mangled.
    expect(ps1).toContain('git push origin "refs/tags/$tag"');

    const sh = byPath["release/release.sh"]!;
    expect(sh.length).toBeGreaterThan(0);
    expect(sh).toContain("#!/usr/bin/env bash");
    expect(sh).toContain('git push origin "refs/tags/${TAG}"');

    const yml = byPath[".github/workflows/release.yml"]!;
    expect(yml.length).toBeGreaterThan(0);
    // The GitHub ${{ }} expression + the bot identity survived verbatim.
    expect(yml).toContain('bash release/release.sh "${{ inputs.version }}" "${{ inputs.channel }}" "${{ inputs.stage }}"');
    expect(yml).toContain('git config user.name  "example-release[bot]"');
    // De-personalized to "this consumer" — the example-auth lead comment must be gone.
    expect(yml).toContain("on one stage, from the GitHub UI");
    expect(yml).not.toContain("example-auth");
  });

  it("takes THREE arguments — version, channel and the stage the release is put on", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));

    expect(byPath["release/release.sh"]!).toContain("usage: release/release.sh <x.y.z> <stable|beta|alpha> <dev|test|prod>");
    expect(byPath["release/release.sh"]!).toContain('STAGE="${3:-}"');
    expect(byPath["release/release.ps1"]!).toContain("[ValidateSet('dev', 'test', 'prod')][string]$Stage");
    // The workflow's third dispatch input, and the three stages it offers.
    expect(byPath[".github/workflows/release.yml"]!).toMatch(/stage:\s*\n\s*description:/);
    expect(byPath[".github/workflows/release.yml"]!).toMatch(/- dev\n\s+- test\n\s+- prod/);
  });

  it("pushes the deploy ref by DELETING it first — re-pushing a ref that already stands fires no webhook", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));

    const sh = byPath["release/release.sh"]!;
    expect(sh).toContain('DEPLOY_REF="refs/tags/deploy/${STAGE}/${TAG}"');
    expect(sh).toContain('git push origin ":${DEPLOY_REF}"');
    expect(sh).toContain('git push origin "${SHA}:${DEPLOY_REF}"');

    const ps1 = byPath["release/release.ps1"]!;
    expect(ps1).toContain('$deployRef = "refs/tags/deploy/$Stage/$tag"');
    expect(ps1).toContain('git push origin ":$deployRef"');
    expect(ps1).toContain('git push origin "${sha}:$deployRef"');
  });

  it("keeps mint-once and REUSES the tag for a further stage — one release, one image, many stages", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));

    expect(byPath["release/release.sh"]!).toContain('PREFIX="${VERSION}-${CHANNEL}-"');
    expect(byPath["release/release.sh"]!).toContain("reusing the existing release");
    expect(byPath["release/release.ps1"]!).toContain('$prefix = "$Version-$Channel-"');
    expect(byPath["release/release.ps1"]!).toContain("reusing the existing release");
  });

  it("checks the channel ceiling locally but WARNS instead of refusing — only the pipeline may refuse", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));

    const sh = byPath["release/release.sh"]!;
    expect(sh).toContain('ADMITS="dev test"'); // beta
    expect(sh).toContain("WARNING — channel ${CHANNEL} admits only: ${ADMITS}.");
    // A ceiling violation must NOT reach `die` — the platform's own refusal is what the ceiling
    // rests on, and a local abort would mean the pipeline never got to state it.
    expect(sh).not.toMatch(/die "channel \$\{CHANNEL\} admits/);
    expect(byPath["release/release.ps1"]!).toContain("Write-Warning");
  });
});
