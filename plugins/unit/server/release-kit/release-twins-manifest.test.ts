import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOTH, MANIFEST, RUNS, bothSpellings, expectSameBytes, fixtureRepo, removeTempDirs, run } from "./release-twins.fixture.ts";

// How the two spellings of the release kit stamp the version into every package.json the repository
// tracks, run against each other: a published package in npm's strict form beside a private one as
// released, a file in a directory a .gitignore names, every file in the one release commit, and no
// commit where every file already declares the version.

afterAll(removeTempDirs);

describe.skipIf(!BOTH)("both release-kit assets, stamping package.json", () => {
  it("stamps every package.json in the strict form, a private one too: 0.3.0 for the release 0.3.000", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, privateRoot: true, workspace: true, origin: true }), ["0.3.000", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(stdout.split("\n").slice(0, 5)).toEqual([
      "release: packages/b/package.json declares no version - nothing to stamp",
      "release: package.json declares 0.3.0",
      "release: packages/a/package.json declares 0.3.0",
      "release: packages/ü/package.json declares 0.3.0",
      "release: minted 0.3.000-stable-<ts14>",
    ]);
    for (const f of [o.sh, o.ps1]) {
      expect(readFileSync(join(f.cwd, "package.json"), "utf8")).toContain('"version": "0.3.0"');
      expect(readFileSync(join(f.cwd, "packages", "a", "package.json"), "utf8")).toContain('"version": "0.3.0",');
    }
  });

  it("stamps a tracked package.json that stands in a directory a .gitignore names", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, ignoredPackage: true, origin: true }), ["0.3.000", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(stdout.split("\n").slice(0, 3)).toEqual([
      "release: package.json declares 0.3.0",
      "release: packages/storage/package.json declares 0.3.0",
      "release: minted 0.3.000-stable-<ts14>",
    ]);
    for (const f of [o.sh, o.ps1]) {
      expect(readFileSync(join(f.cwd, "packages", "storage", "package.json"), "utf8")).toContain('"version": "0.3.0"');
    }
  });

  it("stamps every package.json the repository tracks in the one release commit, identically", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, workspace: true, origin: true }), ["1.2.3", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(stdout.split("\n").slice(0, 4)).toEqual([
      "release: packages/b/package.json declares no version - nothing to stamp",
      "release: package.json declares 1.2.3",
      "release: packages/a/package.json declares 1.2.3",
      "release: packages/ü/package.json declares 1.2.3",
    ]);
    for (const f of [o.sh, o.ps1]) {
      const shown = run("git", ["-c", "core.quotePath=false", "show", "--name-only", "--format=%s", "HEAD"], f.cwd).stdout;
      expect(shown.split("\n").filter(Boolean)).toEqual([expect.stringMatching(/^release: 1\.2\.3-stable-\d{14}$/), "package.json", "packages/a/package.json", "packages/ü/package.json"]);
      expect(readFileSync(join(f.cwd, "packages", "a", "package.json"), "utf8")).toContain('"version": "1.2.3",\n  "dependencies": { "x": "1.0.0" }');
      expect(readFileSync(join(f.cwd, "packages", "b", "package.json"), "utf8")).toBe('{\n  "name": "b"\n}\n');
      // Only the version line moves: the byte order mark and the CRLF endings stay.
      expect(readFileSync(join(f.cwd, "packages", "ü", "package.json"), "utf8")).toBe('﻿{\r\n  "name": "u",\r\n  "version": "1.2.3"\r\n}\r\n');
    }
  });

  it("commits nothing when every package.json already declares the version", RUNS, async () => {
    const o = await bothSpellings(() => {
      const f = fixtureRepo({ manifest: MANIFEST, origin: true });
      writeFileSync(join(f.cwd, "package.json"), '{\n  "name": "probe",\n  "version": "1.2.3"\n}\n');
      for (const args of [["add", "package.json"], ["commit", "-qm", "at the version"], ["push", "-q", "origin", "HEAD:master"]]) run("git", args, f.cwd);
      return f;
    }, ["1.2.3", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: minted 1.2.3-stable-<ts14>\n");
    expect(stdout).not.toContain("declares");
    for (const f of [o.sh, o.ps1]) expect(run("git", ["log", "-1", "--format=%s"], f.cwd).stdout.trim()).toBe("at the version");
  });
});
