import { describe, it, expect, afterAll } from "vitest";
import { RELEASE_KIT_FILES } from "./release-kit.ts";
import { BASH, BOTH, LIBRARY_MANIFEST, MANIFEST, RUNS, SCRIPTS, USABLE, bareDir, bashCandidates, bothSpellings, expectSameBytes, fixtureRepo, head, normalise, originRefs, owedPushRepo, releaseTags, releasedRepo, removeTempDirs, residueRepo, run, runAsync, tempDir, type Fixture, issueBranchRepo } from "./release-twins.fixture.ts";

// The two spellings of the release kit run against each other: the normaliser and the printers the
// comparison rests on, the refusals, the whole success path, and the reruns of a version that stands
// on origin. How the two are compared is written beside the helpers, in release-twins.fixture.ts.

afterAll(removeTempDirs);

describe("the normaliser the comparison rests on", () => {
  it("PLANTED DEFECT: it keeps a carriage return it is given", () => {
    // WITHOUT THIS PROBE THE COMPARISON CANNOT BE SHOWN TO GO RED. The difference it exists to catch
    // is one byte per line, and a normaliser that drops the carriage return passes every comparison
    // after it while that difference stands.
    const withCr = "release: minted\r\nrelease: done\r\n";
    expect(normalise(withCr, "/nowhere")).toContain("\r");
    expect((normalise(withCr, "/nowhere").match(/\r/g) ?? []).length).toBe(2);
    // …and the comparison it feeds tells the two endings apart, which is what the check is for.
    expect(normalise(withCr, "/nowhere")).not.toBe(normalise("release: minted\nrelease: done\n", "/nowhere"));
  });

  it("replaces the volatile values and nothing beside them", () => {
    const line = "release: probe-unit 1.2.003-stable-20260904103359 (commit 17f0eb9) is on its way to dev\n";
    expect(normalise(line, "/nowhere")).toBe("release: probe-unit 1.2.003-stable-<ts14> (commit <sha7>) is on its way to dev\n");
    // A root path is replaced in every spelling either operating system writes it in.
    expect(normalise("at C:/tmp/x/deploy/platform.yaml", "C:/tmp/x")).toBe("at <root>/deploy/platform.yaml");
    expect(normalise("at C:\\tmp\\x\\deploy", "C:/tmp/x")).toBe("at <root>\\deploy");
  });
});

describe("every printed line of both release-kit assets is ASCII", () => {
  // The rule is on what is PRINTED, not on the file: a comment may carry whatever characters it
  // likes. Each script prints through named helpers and nothing else, so the census is over the lines
  // that call one — and the two lists below are what makes that true.
  const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));
  const PRINTERS = {
    "release/release.sh": /(^|\s)(line|say|warn|die)\s+"/,
    "release/release.ps1": /(^|\s)(Write-Line|Say|Warn|Die)\s+["']/,
  };

  for (const [path, printer] of Object.entries(PRINTERS)) {
    it(`${path} prints no byte above 127`, () => {
      const lines = byPath[path]!.split("\n");
      const printed = lines.filter((l) => !l.trimStart().startsWith("#") && printer.test(l));
      expect(printed.length).toBeGreaterThan(15); // the census measured something
      for (const l of printed) expect([...l].filter((c) => c.charCodeAt(0) > 127), l).toEqual([]);
    });
  }

  it("prints through those helpers and through nothing else", () => {
    // A second printer would be a second answer to "who writes the newline", and the census above
    // would not see the line it prints.
    const sh = byPath["release/release.sh"]!.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    expect(sh.filter((l) => /\becho\s/.test(l) && !/rev-parse --show-toplevel/.test(l))).toEqual([]);
    const ps1 = byPath["release/release.ps1"]!.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    expect(ps1.filter((l) => /Write-Host|Write-Warning|Write-Output|\.WriteLine\(/.test(l))).toEqual([]);
    // The helpers write the ending themselves rather than taking the host's.
    expect(byPath["release/release.sh"]).toContain("line() { printf '%s\\n' \"$*\"; }");
    expect(byPath["release/release.ps1"]).toContain('function Write-Line($m) { [Console]::Out.Write("$m`n") }');
  });
});

describe.skipIf(!BOTH)("both release-kit assets, run", () => {
  if (!BOTH) {
    // eslint-disable-next-line no-console -- a skipped comparison must be loud: a silent skip reads as a pass
    console.warn(
      `no ${!USABLE.sh ? `bash of ${bashCandidates().join(", ") || "(none found)"}` : "pwsh"} runs the asset named by ` +
      "a path of this filesystem — install one, or the two spellings of the release script have never been run against " +
      "each other on this machine",
    );
  }

  it.each(["0.4.9", "0.4.09", "0.4.0009", "0.4.1000"])("refuses a patch without exactly three digits: %s", RUNS, async (version) => {
    const o = await bothSpellings(() => bareDir(), [version, "stable", "prod"]);
    const { stderr, stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stderr).toBe(`release: version must be x.y.z, the third position three digits such as 000 (got '${version}')\n`);
    expect(stdout).toBe("");
  });

  it("refuses a malformed version identically", RUNS, async () => {
    const { stderr, stdout } = expectSameBytes(await bothSpellings(() => bareDir(), ["1.2", "stable", "dev"]));
    expect(stderr).toBe("release: version must be x.y.z, the third position three digits such as 000 (got '1.2')\n");
    expect(stdout).toBe("");
  });

  it("warns about the channel ceiling and refuses a directory that is no repository, identically", RUNS, async () => {
    const { stderr } = expectSameBytes(await bothSpellings(() => bareDir(), ["1.2.003", "alpha", "prod"]));
    // The ceiling WARNS and continues; the refusal underneath is the next thing either spelling says.
    expect(stderr).toContain("release: WARNING - channel alpha admits only: dev.");
    expect(stderr).toContain("release: not inside a git repository\n");
  });

  it("refuses a dirty worktree identically", RUNS, async () => {
    const { stderr } = expectSameBytes(await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, dirty: true }), ["1.2.003", "stable", "dev"]));
    expect(stderr).toBe("release: worktree is dirty - commit or stash before releasing\n");
  });

  it("refuses a manifest that states no name identically, naming the same path", RUNS, async () => {
    // The path is composed by each spelling out of the repository root git answers with. Written with
    // a backslash on one side it would differ here by every separator in it.
    const { stderr } = expectSameBytes(await bothSpellings(() => fixtureRepo({}), ["1.2.003", "stable", "dev"]));
    expect(stderr).toBe(
      "release: the manifest <root>/work/deploy/platform.yaml states no name - it is what the release line and any pin are written under\n",
    );
  });

  it("performs the whole success path identically, down to the byte", RUNS, async () => {
    // A unit that declares no platformRepo: it stamps the version, mints and pushes the tag, pushes
    // the deploy ref, and reports. Nothing here reaches the network — origin is a bare repository
    // beside the working tree — so this is the whole of what such a release does.
    const { stdout, stderr } = expectSameBytes(
      await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true }), ["1.2.003", "stable", "dev"]),
    );
    expect(stdout).toBe([
      "release: package.json declares 1.2.3",
      "release: minted 1.2.003-stable-<ts14>",
      "release: the manifest <root>/work/deploy/platform.yaml names no platformRepo, so nothing is pinned from here - the deploy ref above is what the platform reacts to",
      "release: probe-unit 1.2.003-stable-<ts14> (commit <sha7>) is on its way to dev",
      "release: the platform builds these image tags, or skips the build when they already exist:",
      "    probe:1.2.003-stable-<ts14>-<sha7>",
      "",
    ].join("\n"));
    // git's own push lines are on standard error, and they are the same on both sides too.
    expect(stderr).toContain("deploy/dev/1.2.003-stable-<ts14>");
  });

  // A RERUN FOR A VERSION THAT ALREADY STANDS ON ORIGIN, in its three shapes. A version names one
  // commit (#173): the tag on HEAD is reused and its deploy ref pushed again; the tag on another commit is
  // refused before any push and the refusal names the next number; a tag that never reached origin is
  // residue and is cut again. Each is performed by both spellings and read back off origin.

  it("refuses a rerun whose tag stands on origin on another commit, before any push, naming the next number", RUNS, async () => {
    const before = new Map<string, string>();
    const o = await bothSpellings(() => {
      const f = releasedRepo({ moved: true });
      before.set(f.cwd, originRefs(f));
      return f;
    }, ["1.2.003", "stable", "test"]);
    const { stdout, stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "release: 1.2.003-stable-<ts14> stands on origin at <sha7> and HEAD is <sha7>. A version names one commit, so 1.2.003 is burnt: release 1.2.004 instead. Nothing was pushed.\n",
    );
    for (const f of [o.sh, o.ps1]) {
      // Nothing on origin moved: not the delivery branch of the stage asked for, not the one of the
      // stage already released, not the tag.
      expect(originRefs(f)).toBe(before.get(f.cwd));
      expect(originRefs(f)).not.toContain("refs/heads/deploy/test");
      expect(originRefs(f)).not.toContain(`${head(f)}\trefs/heads/deploy/dev`);
    }
  });

  it("names the next three-digit version when a three-digit one is burnt: 0.3.008 after 0.3.007 (#303)", RUNS, async () => {
    const o = await bothSpellings(() => releasedRepo({ moved: true, version: "0.3.007" }), ["0.3.007", "stable", "test"]);
    const { stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stderr).toBe(
      "release: 0.3.007-stable-<ts14> stands on origin at <sha7> and HEAD is <sha7>. A version names one commit, so 0.3.007 is burnt: release 0.3.008 instead. Nothing was pushed.\n",
    );
  });

  it("reuses a tag that stands on origin on HEAD and pushes its deploy ref for a further stage, moving no branch (#293)", RUNS, async () => {
    const o = await bothSpellings(() => releasedRepo({ moved: false }), ["1.2.003", "stable", "test"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: reusing the existing release 1.2.003-stable-<ts14> - one release per version+channel, so putting it on test rebuilds nothing\n");
    expect(stdout).not.toContain("stands at <sha7>");
    expect(stdout).not.toContain("minted");
    for (const f of [o.sh, o.ps1]) {
      const [tag] = releaseTags(f);
      expect(releaseTags(f)).toHaveLength(1);
      expect(originRefs(f)).not.toContain("refs/heads/deploy/");
      expect(originRefs(f)).toContain(`refs/tags/deploy/test/${tag}\n`);
    }
  });

  // PUTTING A RELEASE THAT STANDS ON A STAGE AGAIN (#299): --existing / -Existing, the way a unit goes
  // back to an earlier release. The deploy ref names the release's own commit whatever is checked out,
  // nothing is minted, and a release that never stood on origin is refused before any push.

  it("puts a release that stands on origin on a stage again from a moved HEAD, at the release's own commit", RUNS, async () => {
    const o = await bothSpellings(() => releasedRepo({ moved: true }), ["1.2.003", "stable", "test", "--existing"], ["1.2.003", "stable", "test", "-Existing"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: reusing the existing release 1.2.003-stable-<ts14> - one release per version+channel, so putting it on test rebuilds nothing\n");
    expect(stdout).not.toContain("minted");
    for (const f of [o.sh, o.ps1]) {
      const [tag] = releaseTags(f);
      expect(releaseTags(f)).toHaveLength(1);
      const released = run("git", ["rev-list", "-n", "1", tag!], f.cwd).stdout.trim();
      expect(released).not.toBe(head(f));
      expect(originRefs(f)).toContain(`${released}\trefs/tags/deploy/test/${tag}\n`);
      expect(originRefs(f)).not.toContain("refs/heads/deploy/");
    }
  });

  it("refuses to put a release that never stood on origin, before any push", RUNS, async () => {
    const before = new Map<string, string>();
    const o = await bothSpellings(() => {
      const f = releasedRepo({ moved: false });
      before.set(f.cwd, originRefs(f));
      return f;
    }, ["9.9.9", "stable", "dev", "--existing"], ["9.9.9", "stable", "dev", "-Existing"]);
    const { stdout, stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("release: no release 9.9.9-stable stands on origin, so there is none to put on dev. Nothing was pushed.\n");
    for (const f of [o.sh, o.ps1]) expect(originRefs(f)).toBe(before.get(f.cwd));
  });

  it("drops a tag that never reached origin and names another commit, and cuts the release again", RUNS, async () => {
    const o = await bothSpellings(() => residueRepo(), ["1.2.003", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain(
      "release: 1.2.003-stable-<ts14> stands on this machine only and names <sha7>, not the commit being released. A run whose push was refused left it behind; it is dropped and cut again.\n",
    );
    expect(stdout).toContain("release: minted 1.2.003-stable-<ts14>\n");
    for (const f of [o.sh, o.ps1]) {
      const tags = releaseTags(f);
      expect(tags).toHaveLength(1);
      expect(tags[0]).not.toBe("1.2.003-stable-20200101000000");
      expect(originRefs(f)).toContain(`refs/tags/${tags[0]}\n`);
      expect(originRefs(f)).toContain(`refs/tags/deploy/dev/${tags[0]}\n`);
      expect(originRefs(f)).not.toContain("refs/heads/deploy/");
    }
  });

  it("pushes a tag that stands on HEAD here and is missing on origin, then reuses it — the push a cut run still owed (#227)", RUNS, async () => {
    const o = await bothSpellings(() => owedPushRepo(), ["1.2.003", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: 1.2.003-stable-<ts14> stands on this machine only, on the commit being released - its push never reached origin; pushed now\n");
    expect(stdout).toContain("release: reusing the existing release 1.2.003-stable-<ts14> - one release per version+channel, so putting it on dev rebuilds nothing\n");
    expect(stdout).not.toContain("minted");
    for (const f of [o.sh, o.ps1]) {
      expect(releaseTags(f)).toEqual(["1.2.003-stable-20200101000000"]);
      expect(originRefs(f)).toContain("refs/tags/1.2.003-stable-20200101000000\n");
      expect(originRefs(f)).toContain("refs/tags/deploy/dev/1.2.003-stable-20200101000000\n");
      expect(originRefs(f)).not.toContain("refs/heads/deploy/");
    }
  });

  // THE RELEASE COMMIT GOES WHERE THE BRANCH TRACKS: a branch that tracks origin/master under another
  // name, as an issue worktree's does, puts it on master; a branch that tracks nothing pushes to its
  // own name, as before.

  it("puts the release commit of a branch tracking origin/master under another name on master, and makes no branch of its name", RUNS, async () => {
    const o = await bothSpellings(() => issueBranchRepo({ tracking: true }), ["1.2.003", "stable", "dev"]);
    expectSameBytes(o);
    for (const f of [o.sh, o.ps1]) {
      expect(f.status).toBe(0);
      expect(originRefs(f)).toContain(`${head(f)}\trefs/heads/master\n`);
      expect(originRefs(f)).not.toContain("refs/heads/issue-7-fix");
    }
  });

  it("puts the release commit a cut run still owed on master too, from a branch tracking it under another name", RUNS, async () => {
    const o = await bothSpellings(() => issueBranchRepo({ tracking: true, owed: true }), ["1.2.003", "stable", "dev"]);
    expect(expectSameBytes(o).stdout).toContain("its push never reached origin; pushed now\n");
    for (const f of [o.sh, o.ps1]) {
      expect(f.status).toBe(0);
      expect(originRefs(f)).toContain(`${head(f)}\trefs/heads/master\n`);
      expect(originRefs(f)).not.toContain("refs/heads/issue-7-fix");
    }
  });

  it("PLANTED INNOCENT: pushes a branch that tracks nothing to its own name, and leaves master where it stood", RUNS, async () => {
    const o = await bothSpellings(() => issueBranchRepo({ tracking: false }), ["1.2.003", "stable", "dev"]);
    expectSameBytes(o);
    for (const f of [o.sh, o.ps1]) {
      expect(f.status).toBe(0);
      expect(originRefs(f)).toContain(`${head(f)}\trefs/heads/issue-7-fix\n`);
      expect(originRefs(f)).not.toContain(`${head(f)}\trefs/heads/master\n`);
    }
  });

  // A LIBRARY: a manifest with no builds, no chart and no tenant block deploys nothing, so its release
  // takes no stage and pushes no deploy ref. Everything else is put on a stage.

  it("releases a library without a stage identically, and pushes no deploy ref", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: LIBRARY_MANIFEST, packageJson: true, origin: true }), ["1.2.003", "stable"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toBe([
      "release: package.json declares 1.2.3",
      "release: minted 1.2.003-stable-<ts14>",
      "release: probe-lib 1.2.003-stable-<ts14> (commit <sha7>) is released; nothing is deployed",
      "",
    ].join("\n"));
    for (const f of [o.sh, o.ps1]) {
      expect(releaseTags(f)).toHaveLength(1);
      expect(originRefs(f)).toContain(`refs/tags/${releaseTags(f)[0]}\n`);
      expect(originRefs(f)).not.toContain("deploy/");
    }
  });

  it("PLANTED DEFECT: the deploy-ref check above goes red on a unit, which does push one", RUNS, async () => {
    const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
    expect((await runAsync(BASH, [SCRIPTS.sh, "1.2.003", "stable", "dev"], f.cwd)).status).toBe(0);
    expect(originRefs(f)).toContain("deploy/");
  });

  it("releases a library with the stage `none` exactly as without one", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: LIBRARY_MANIFEST, origin: true }), ["1.2.003", "stable", "none"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: probe-lib 1.2.003-stable-<ts14> (commit <sha7>) is released; nothing is deployed\n");
  });

  it("refuses a stage, and --existing, for a library identically, before any push", RUNS, async () => {
    const before = new Map<string, string>();
    const build = (): Fixture => {
      const f = fixtureRepo({ manifest: LIBRARY_MANIFEST, packageJson: true, origin: true });
      before.set(f.cwd, originRefs(f));
      return f;
    };
    const staged = await bothSpellings(build, ["1.2.003", "stable", "dev"]);
    const { stderr } = expectSameBytes(staged);
    expect(staged.sh.status).toBe(1);
    expect(stderr).toBe("release: probe-lib declares no builds, no chart and no tenant block, so a release of it deploys nothing and takes no stage - release it without one. Nothing was pushed.\n");
    const existing = await bothSpellings(build, ["1.2.003", "stable", "none", "--existing"], ["1.2.003", "stable", "none", "-Existing"]);
    expect(expectSameBytes(existing).stderr).toBe("release: --existing puts a release that stands on origin on a stage again, and probe-lib deploys nothing. Nothing was pushed.\n");
    for (const f of [staged.sh, staged.ps1, existing.sh, existing.ps1]) expect(originRefs(f)).toBe(before.get(f.cwd));
  });

  it("refuses a chart-only unit without a stage identically: a chart deploys, even with no builds", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: "name: probe-chart\nchart:\n  path: deploy/chart\n", origin: true }), ["1.2.003", "stable"]);
    const { stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stderr).toBe("release: probe-chart declares builds, a chart or a tenant block, so a release of it is put on a stage - name dev, test or prod. Nothing was pushed.\n");
  });

  it("names only the top-level builds as images: a tenant block's members are none", RUNS, async () => {
    // PLANTED DEFECT: a reader of every `- name:` line would print `auth` as an image this release builds.
    const fanOut = "name: probe-fanout\ntenant:\n  members:\n    - name: auth\n      chart: charts/auth\n";
    const o = await bothSpellings(() => fixtureRepo({ manifest: fanOut, origin: true }), ["1.2.003", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: probe-fanout 1.2.003-stable-<ts14> (commit <sha7>) is on its way to dev\n");
    expect(stdout).not.toContain("auth");
  });

  it("stamps a beta with its channel as the prerelease part identically: 1.2.003-beta", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true }), ["1.2.003", "beta", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: package.json declares 1.2.3-beta\n");
    // PLANTED DEFECT: the stable success path above stamps the plain version; a beta that did too would
    // publish the number a later stable of the same version needs.
    expect(stdout).not.toContain("release: package.json declares 1.2.3\n");
  });

  it("refuses a channel and a stage spelled in another case identically", RUNS, async () => {
    // PLANTED DEFECT: PowerShell compares without case by default, and `Beta` or `None` taken for the
    // real word mints a tag the bash twin refuses.
    const channel = await bothSpellings(() => bareDir(), ["1.2.003", "Beta", "dev"]);
    expect(expectSameBytes(channel).stderr).toBe("release: channel must be stable|beta|alpha (got 'Beta')\n");
    const stage = await bothSpellings(() => bareDir(), ["1.2.003", "stable", "None"]);
    expect(expectSameBytes(stage).stderr).toBe("release: stage must be dev|test|prod, or none for a library (got 'None')\n");
  });

  it("reads the chart, tenant and builds keys only as YAML spells them, identically", RUNS, async () => {
    // `Chart:` is no chart key, so this manifest deploys nothing: both twins take it for a library.
    const o = await bothSpellings(() => fixtureRepo({ manifest: "name: probe-case\nChart:\n  path: deploy/chart\nBuilds:\n  - name: x\n" }), ["1.2.003", "stable", "dev"]);
    expect(o.sh.status).toBe(1);
    expect(expectSameBytes(o).stderr).toBe("release: probe-case declares no builds, no chart and no tenant block, so a release of it deploys nothing and takes no stage - release it without one. Nothing was pushed.\n");
  });

  it("takes --existing before the stage as after it, as the twin's switch does", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: LIBRARY_MANIFEST }), ["1.2.003", "stable", "--existing"], ["1.2.003", "stable", "-Existing"]);
    expect(o.sh.status).toBe(1);
    expect(expectSameBytes(o).stderr).toBe("release: --existing puts a release that stands on origin on a stage again, and probe-lib deploys nothing. Nothing was pushed.\n");
  });

  it("COUNTER-PROBE: the comparison sees a difference when there is one", RUNS, () => {
    // Two runs of the SAME spelling with different arguments must not compare equal, or every
    // assertion above would be comparing something to itself.
    const a = run(BASH, [SCRIPTS.sh, "1.2", "stable", "dev"], tempDir());
    const b = run(BASH, [SCRIPTS.sh, "1.2.003", "banana", "dev"], tempDir());
    expect(normalise(b.stderr, "/nowhere")).not.toBe(normalise(a.stderr, "/nowhere"));
  });
});
