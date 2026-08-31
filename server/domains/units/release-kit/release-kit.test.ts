// Guards the embedded release-kit assets against corruption: the three files
// are loaded VERBATIM from ./assets, and their target paths are the single source of truth for the
// onboard write + the offboard/purge git-rm. A build/copy that mangled the scripts (a template-literal
// escape, a line-ending rewrite) or dropped a file would break every consumer's release flow silently,
// so this pins the paths exactly and asserts a stable sentinel line per file survived the bytes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RELEASE_KIT_FILES, RELEASE_KIT_PATHS } from "./release-kit.ts";

/** This repository's OWN copy of a kit file, at the consumer-repo target path the kit writes to. */
const ownCopy = (kitPath: string): string => readFileSync(new URL(`../../../../${kitPath}`, import.meta.url), "utf8");

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

  // This repository is a consumer unit of itself, so onboarding it runs inject-release-kit over its
  // own release/ directory. The kit REPLACES, so anything its own copy carries and the asset does
  // not is deleted by that act — which is how the pin write and the manifest stamp were lost. The
  // fix is that there is nothing extra to lose: the asset IS the script this repository runs, and
  // these two assertions are what keeps it that way.
  it("IS this repository's own release script, byte for byte — an onboarding of this repo cannot take anything away", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));
    // Read first, so an equality that passes cannot mean two empty strings: readFileSync throws on
    // a path that is not there, and these two lines say the bytes are the real scripts.
    expect(ownCopy("release/release.sh").startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(ownCopy("release/release.ps1")).toContain("[CmdletBinding()]");
    expect(ownCopy("release/release.sh")).toBe(byPath["release/release.sh"]);
    expect(ownCopy("release/release.ps1")).toBe(byPath["release/release.ps1"]);
  });

  it("carries the manifest stamp, the build wait and the pin write — the three the short kit dropped", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));
    const sh = byPath["release/release.sh"]!;
    const ps1 = byPath["release/release.ps1"]!;

    // The manifest stamp: the version the tag names is written into package.json BEFORE the tag.
    expect(sh).toContain("stamp_manifest_version");
    expect(sh).toContain('git commit --quiet -m "release: $TAG"');
    expect(ps1).toContain("Set-ManifestVersion");
    expect(ps1).toContain('git commit --quiet -m "release: $Tag"');

    // The wait: a tag is a name and not a release until the images exist.
    expect(sh).toContain("gh run watch");
    expect(ps1).toContain("gh run watch");

    // The pin write, and the commit body that identifies who wrote it.
    expect(sh).toContain('git -C "$PLATFORM_REPO_DIR" push --quiet origin "$branch"');
    expect(sh).toContain('-m "Written by the release of ${NAME}, once its images were built."');
    expect(ps1).toContain("git -C $platformRepoDir push --quiet origin $Branch");
    expect(ps1).toContain('-m "Written by the release of $name, once its images were built."');
  });

  it("reaches the wait and the pin ONLY where the manifest declares platformRepo — a customer repo enters neither", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));
    const sh = byPath["release/release.sh"]!;
    const ps1 = byPath["release/release.ps1"]!;

    // The gate itself, and the line a repo without one is told instead.
    expect(sh).toContain('if [ -z "$PLATFORM_REPO" ]; then');
    expect(sh).toContain("names no platformRepo, so nothing is pinned from here");
    expect(ps1).toContain("if (-not $platformRepo) {");
    expect(ps1).toContain("names no platformRepo, so nothing is pinned from here");

    // A repository in another language has no package.json: the stamp says so and the release runs on.
    expect(sh).toContain("this repository carries no package.json — no version manifest to stamp");
    expect(ps1).toContain("this repository carries no package.json — no version manifest to stamp");
  });

  it("refuses a release it could not pin BEFORE it mints anything — the probe is the push, not the clone", () => {
    const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));
    const sh = byPath["release/release.sh"]!;
    const ps1 = byPath["release/release.ps1"]!;

    expect(sh).toContain('GIT_TERMINAL_PROMPT=0 git -C "$PLATFORM_REPO_DIR" push --dry-run --quiet origin HEAD');
    expect(sh).toContain("nothing has been minted or pushed");
    expect(ps1).toContain("git -C $platformRepoDir push --dry-run --quiet origin HEAD");
    expect(ps1).toContain("nothing has been minted or pushed");

    // The pre-flight stands BEFORE the mint in both spellings: a refusal after the tag exists would
    // leave a release nothing can re-mint, because a release tag is minted once per version+channel.
    for (const [script, mint] of [[sh, 'git tag -a "$TAG"'], [ps1, "git tag -a $tag"]] as const) {
      const probe = script.indexOf("push --dry-run --quiet origin HEAD");
      expect(probe).toBeGreaterThan(-1);
      expect(script.indexOf(mint)).toBeGreaterThan(probe);
    }
  });
});
