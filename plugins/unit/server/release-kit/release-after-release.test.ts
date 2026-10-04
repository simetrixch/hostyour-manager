import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BOTH, LIBRARY_MANIFEST, MANIFEST, RUNS, bothSpellings, expectSameBytes, fixtureRepo, originRefs, removeTempDirs } from "./release-twins.fixture.ts";

// The repository's own step after the release (deploy/after-release.sh and .ps1), run by both
// spellings of the release kit against each other. Each scenario's step prints what it was given,
// so the comparison sees the arguments and the working directory as well as the release's own lines.

afterAll(removeTempDirs);

/** A step in both spellings that prints its arguments, how many there are, and where it runs, then
 *  exits with `code`. */
const step = (code: number): { sh: string; ps1: string } => ({
  sh: `printf 'after-release %s %s %s (%s arguments) in %s\\n' "$1" "$2" "$3" "$#" "$(pwd)"\nexit ${code}\n`,
  ps1: `[Console]::Out.Write("after-release $($args[0]) $($args[1]) $($args[2]) ($($args.Count) arguments) in $((Get-Location).Path)\`n")\nexit ${code}\n`,
});

describe.skipIf(!BOTH)("the repository's own step after the release", () => {
  for (const failure of [
    { name: "deploy request", ref: "refs/tags/deploy/*", manifest: MANIFEST, released: true },
    { name: "release commit", ref: "refs/heads/master", manifest: MANIFEST, released: false },
    { name: "release tag", ref: "refs/tags/1.2.003-*", manifest: LIBRARY_MANIFEST, released: false },
  ]) {
    it(`never invokes the hook after a rejected ${failure.name} push`, RUNS, async () => {
      const o = await bothSpellings(() => fixtureRepo({
        manifest: failure.manifest,
        packageJson: true,
        origin: true,
        originPreReceive: `while read old new ref; do case "$ref" in ${failure.ref}) exit 1 ;; esac; done`,
        afterRelease: {
          sh: "printf 'called\\n' >> hook-count\n",
          ps1: '[IO.File]::AppendAllText((Join-Path (Get-Location) "hook-count"), "called`n")\n',
        },
      }), ["1.2.003", "stable", ...(failure.manifest === MANIFEST ? ["dev"] : [])]);
      const { stdout } = expectSameBytes(o);
      expect(o.sh.status).toBe(1);
      expect(stdout).not.toContain("running deploy/after-release");
      for (const result of [o.sh, o.ps1]) {
        expect(existsSync(join(result.root, "work", "hook-count"))).toBe(false);
        const refs = originRefs(result);
        expect(/refs\/tags\/1[.]2[.]003-stable-\d{14}/.test(refs)).toBe(failure.released);
        expect(refs).not.toContain("refs/tags/deploy/");
      }
    });
  }

  it("PLANTED DEFECT: runs it last, with the tag, the release commit and the stage, from the repository root", RUNS, async () => {
    const { stdout } = expectSameBytes(
      await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true, afterRelease: step(0) }), ["1.2.003", "stable", "dev"]),
    );
    expect(stdout).toContain([
      "release: running deploy/after-release 1.2.003-stable-<ts14> <sha> dev",
      "after-release 1.2.003-stable-<ts14> <sha> dev (3 arguments) in <root>/work",
      "release: probe-unit 1.2.003-stable-<ts14> (commit <sha7>) is on its way to dev",
    ].join("\n"));
  });

  it("PLANTED DEFECT: passes none as the stage of a library", RUNS, async () => {
    const { stdout } = expectSameBytes(
      await bothSpellings(() => fixtureRepo({ manifest: LIBRARY_MANIFEST, origin: true, afterRelease: step(0) }), ["1.2.003", "stable"]),
    );
    expect(stdout).toContain([
      "after-release 1.2.003-stable-<ts14> <sha> none (3 arguments) in <root>/work",
      "release: probe-lib 1.2.003-stable-<ts14> (commit <sha7>) is released; nothing is deployed",
    ].join("\n"));
  });

  it("PLANTED DEFECT: turns the release red when the step fails, and leaves the release standing", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true, afterRelease: step(7) }), ["1.2.003", "stable", "dev"]);
    const { stdout, stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stderr).toContain(
      "release: deploy/after-release failed with exit 7 - 1.2.003-stable-<ts14> is released and its deploy ref is pushed; only the after-release step is missing: run it again once fixed\n",
    );
    expect(stdout).not.toContain("is on its way");
    expect(originRefs(o.sh)).toMatch(/refs\/tags\/deploy\/dev\/1\.2\.003-stable-\d{14}/);
  });

  it("reports a failed library hook without claiming that a deploy ref was pushed", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: LIBRARY_MANIFEST, origin: true, afterRelease: step(7) }), ["1.2.003", "stable"]);
    const { stdout, stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stderr).toContain("release: deploy/after-release failed with exit 7 - 1.2.003-stable-<ts14> is released; only the after-release step is missing: run it again once fixed\n");
    expect(stdout).not.toContain("is released; nothing is deployed");
    expect(originRefs(o.sh)).not.toContain("refs/tags/deploy/");
  });

  for (const only of ["sh", "ps1"] as const) {
    const other = only === "sh" ? "ps1" : "sh";
    it(`PLANTED DEFECT: refuses a step in the ${only} spelling alone, before anything is pushed`, RUNS, async () => {
      const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true, afterRelease: { [only]: step(0)[only] } }), ["1.2.003", "stable", "dev"]);
      const { stderr } = expectSameBytes(o);
      expect(stderr).toBe(
        `release: deploy/after-release.${only} stands without its twin deploy/after-release.${other} - each release script runs its own spelling, so a repository supplies both or neither. Nothing was pushed.\n`,
      );
      expect(originRefs(o.sh)).not.toContain("refs/tags/");
    });
  }
});
