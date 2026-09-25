import { describe, it, expect, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RELEASE_KIT_FILES } from "./release-kit.ts";

// THE TWO TWINS OF THE RELEASE KIT ANSWER THE SAME BYTES, AND THIS RUNS THEM TO FIND OUT.
//
// assets/release.sh and assets/release.ps1 are the two files every consumer repository receives, and
// each one tells its reader that the other answers identically (assets/release.sh:5,
// assets/release.ps1:4-5). This is what holds those two sentences. The assets are run where they
// stand: each one finds its repository with `git rev-parse --show-toplevel`, so the working directory
// decides what it acts on and no second copy has to exist anywhere.
//
// WHAT IS COMPARED: the exit status, every byte of standard output and every byte of standard error,
// over the refusals and the whole success path of a unit that pins nothing. The paths that need a
// build plane (the wait, the pin) need `gh` and a network and are not reached here; what those add is
// the same printing helpers, held to ASCII by the census below.
//
// TWO CONSTRAINTS THE COMPARISON RESTS ON, each of which a defect broke once:
//
//   NORMALISE IN THIS PROCESS, never through a tool that rewrites what it is given. A PowerShell host
//   ends every line with two bytes where the shell writes one, and `sed` on Windows reads its input
//   in text mode and drops a carriage return without saying so, so a comparison piped through `sed`
//   cannot go red on a line-ending difference at all. The probe below plants a carriage return and
//   requires the normaliser to keep it.
//
//   EACH SCRIPT PRINTS THROUGH ITS NAMED HELPERS AND THROUGH NOTHING ELSE, which is what makes the
//   ASCII census below total: the census reads the lines that call a helper, so a second printer
//   would print lines it never sees. ASCII is the rule because [Console]::Error.WriteLine writes in
//   the console's code page, where a `—` in a printed string arrives as `-` and every refusal
//   carrying one differs between the two.

const SCRIPTS = {
  sh: fileURLToPath(new URL("./assets/release.sh", import.meta.url)),
  ps1: fileURLToPath(new URL("./assets/release.ps1", import.meta.url)),
};

/** Run one command and answer everything it produced, without throwing on a refusal: a refusal is
 *  exactly what most of these scenarios are, and its bytes are the subject. */
function run(file: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The release scripts themselves, run WITHOUT blocking this worker (hostyour-manager#239): a
 *  release run takes 5-20 s, and a file of them spent over a minute inside spawnSync, during which
 *  the worker could answer none of vitest's own RPC — its `onTaskUpdate` timed out and the whole
 *  suite was reported red with every test green. The git calls of the fixtures stay synchronous:
 *  milliseconds each. */
function runAsync(file: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !("code" in err && typeof (err as { code?: unknown }).code === "number")) { reject(err); return; }
      resolve({ status: err ? ((err as { code?: number }).code ?? null) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mgr-twins-"));
  dirs.push(dir);
  return dir;
}

/** Every bash this machine offers: the ones on PATH, then the ones that ship beside the `git` on
 *  PATH. The bash used has to see the same filesystem as pwsh and use the same git, or two runs would
 *  differ in the operating system rather than in the script — on Windows the `bash` on PATH is
 *  usually the WSL launcher, which answers a path of this filesystem with "No such file or
 *  directory" and carries a git of its own, whose repository paths are spelled /mnt/<drive>. Which
 *  candidate is right is not read off its name; it is decided by the probe below. */
function bashCandidates(): string[] {
  if (process.platform !== "win32") return ["bash"];
  const where = (name: string): string[] =>
    run("where.exe", [name], tmpdir()).stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  // git is at <install>/cmd/git.exe and at <install>/mingw64/bin/git.exe, and its bash is at
  // <install>/bin/bash.exe. Both spellings are answered, and a wrong guess simply fails the probe.
  const besideGit = where("git").flatMap((git) => [join(dirname(dirname(git)), "bin", "bash.exe"), join(dirname(dirname(dirname(git))), "bin", "bash.exe")]);
  return [...where("bash"), ...besideGit];
}

/** Every line the asset prints opens with this, through `warn` and `die`. An interpreter that could
 *  not run it prints its own error instead, and that is what the probe below tells apart. */
const SAYS = "release: ";

/** Can this bash run THE ASSET, named by a path of this filesystem, far enough to reach the asset's
 *  own refusal? Asked as the thing every scenario below asks of it, because neither a name on the
 *  PATH nor a script of our own is that question. Two interpreters on this machine run a plain
 *  script and not this one: the WSL launcher takes no path of this filesystem at all, and a BusyBox
 *  `bash.exe` on the PATH answers `syntax error: unexpected "("` on the `[[ ]]` the asset validates
 *  its version with. Either would make every comparison below one between two failures. The refusal
 *  is only read as far as the prefix, so the scenario that asserts its bytes can still go red. */
function bashRuns(bash: string): boolean {
  return run(bash, [SCRIPTS.sh, "1.2", "stable", "dev"], tempDir()).stderr.startsWith(SAYS);
}

/** The same question of pwsh, which is how the twin is started here and on a consumer's machine. */
function pwshRuns(): boolean {
  const dir = tempDir();
  const probe = join(dir, "probe.ps1");
  writeFileSync(probe, "[Console]::Out.Write('ok')\n");
  return run("pwsh", ["-NoProfile", "-NonInteractive", "-File", probe], dir).stdout === "ok";
}

/** What a scenario that spawns interpreters is given. Each one builds two git repositories and runs
 *  two interpreters over them, which is minutes' worth of nothing on a loaded machine and well past
 *  the default a pure in-process test is given. */
const RUNS = { timeout: 120_000 };

/** Empty where no candidate ran the probe, which is what the loud skip below reports. */
const BASH = bashCandidates().find(bashRuns) ?? "";
const USABLE = { sh: BASH !== "", ps1: pwshRuns() };
const BOTH = USABLE.sh && USABLE.ps1;

/** Replaces the volatile values a release writes, and NOTHING else. Every other byte survives, the
 *  carriage return included, because a line ending is one of the two differences this comparison
 *  exists to see. */
function normalise(text: string, root: string): string {
  const roots = [root, root.split("\\").join("/"), root.split("/").join("\\")];
  let out = text;
  for (const spelling of roots) out = out.split(spelling).join("<root>");
  // The whole commit id FIRST: one out of every few is 14 digits before it is anything else, and a
  // timestamp rule reading it first would leave the tail of a sha standing beside a <ts14>.
  return out
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b\d{14}\b/g, "<ts14>")
    .replace(/\b[0-9a-f]{7}\b/g, "<sha7>");
}

/** A repository the release scripts can act on, built the same way for both spellings so the only
 *  difference between two runs is which spelling performed it. `core.autocrlf false` keeps git's own
 *  normalisation warnings — a property of the developer's global configuration, not of these
 *  scripts — out of a comparison that is about what the two spellings print. */
function fixtureRepo(opts: { manifest?: string; packageJson?: boolean; workspace?: boolean; origin?: boolean; dirty?: boolean }): Fixture {
  const base = tempDir();
  const work = join(base, "work");
  mkdirSync(work);
  const git = (...args: string[]): void => {
    const r = run("git", args, work);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q", "-b", "master");
  git("config", "user.email", "twins@example.invalid");
  git("config", "user.name", "Twins");
  git("config", "core.autocrlf", "false");
  if (opts.manifest !== undefined) {
    mkdirSync(join(work, "deploy"));
    writeFileSync(join(work, "deploy", "platform.yaml"), opts.manifest);
  }
  if (opts.packageJson) writeFileSync(join(work, "package.json"), '{\n  "name": "probe",\n  "version": "0.0.1"\n}\n');
  if (opts.workspace) {
    // Two packages beside the root: one that declares a version, one that declares none.
    mkdirSync(join(work, "packages", "a"), { recursive: true });
    mkdirSync(join(work, "packages", "b"), { recursive: true });
    writeFileSync(join(work, "packages", "a", "package.json"), '{\n  "name": "a",\n  "version": "0.1.0",\n  "dependencies": { "x": "1.0.0" }\n}\n');
    writeFileSync(join(work, "packages", "b", "package.json"), '{\n  "name": "b"\n}\n');
  }
  git("add", "-A");
  git("commit", "-qm", "init", "--allow-empty");
  if (opts.origin) {
    const origin = join(base, "origin.git");
    const init = run("git", ["init", "--bare", "-q", origin], base);
    if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr}`);
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "HEAD:master");
  }
  if (opts.dirty) writeFileSync(join(work, "uncommitted.txt"), "not committed\n");
  return { cwd: work, root: base };
}

const MANIFEST = "name: probe-unit\nbuilds:\n  - name: probe\n";

/** One more commit on the fixture's master, pushed to origin: the tree has moved past whatever was
 *  released before it, the way a fix landing after a refused release moves it. */
function moveMaster(f: Fixture): void {
  writeFileSync(join(f.cwd, "fix.txt"), "landed after the release\n");
  for (const args of [["add", "fix.txt"], ["commit", "-qm", "fix"], ["push", "-q", "origin", "HEAD:master"]]) {
    const r = run("git", args, f.cwd);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

/** A repository whose 1.2.3-stable release already stands on origin, put on dev by the bash spelling:
 *  the rerun is the subject here, and the first run's bytes are what the success-path scenario
 *  asserts. With `moved`, master has one commit on top of the released one. */
function releasedRepo(opts: { moved: boolean }): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const first = run(BASH, [SCRIPTS.sh, "1.2.3", "stable", "dev"], f.cwd);
  if (first.status !== 0) throw new Error(`the first release failed: ${first.stderr}`);
  if (opts.moved) moveMaster(f);
  return f;
}

/** A repository carrying a 1.2.3-stable tag that never reached origin and names the commit before
 *  HEAD — what a run whose push was refused leaves behind once the fix has landed. */
function residueRepo(): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const tag = run("git", ["tag", "-a", "1.2.3-stable-20200101000000", "-m", "residue"], f.cwd);
  if (tag.status !== 0) throw new Error(`git tag failed: ${tag.stderr}`);
  moveMaster(f);
  return f;
}

/** A release whose tag's push never landed: the tag stands on HEAD here and origin lacks it (#227). */
function owedPushRepo(): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const tag = run("git", ["tag", "-a", "1.2.3-stable-20200101000000", "-m", "owed"], f.cwd);
  if (tag.status !== 0) throw new Error(`git tag failed: ${tag.stderr}`);
  return f;
}

/** Every ref origin holds, with its commit — the whole of what a release may move. */
const originRefs = (f: Fixture): string => run("git", ["ls-remote", "origin"], f.cwd).stdout;
const head = (f: Fixture): string => run("git", ["rev-parse", "HEAD"], f.cwd).stdout.trim();
const releaseTags = (f: Fixture): string[] => run("git", ["tag", "-l", "1.2.3-stable-*"], f.cwd).stdout.split("\n").filter((l) => l.length > 0);

/** A directory that is no repository at all — where the two refusals needing none are performed. */
function bareDir(): Fixture {
  const dir = tempDir();
  return { cwd: dir, root: dir };
}

/** Where a scenario is performed, and the directory every path in its output sits under. The two are
 *  not the same: git names the bare origin beside the working tree, so normalising the working tree
 *  alone would leave the one path that differs between two runs standing. */
interface Fixture {
  cwd: string;
  root: string;
}

/** One scenario, performed twice on two identical repositories. Each side answers with its fixture
 *  as well, so a scenario can read what the run left on origin. */
async function bothSpellings(build: () => Fixture, args: string[]): Promise<{ sh: ReturnType<typeof run> & Fixture; ps1: ReturnType<typeof run> & Fixture }> {
  const sh = build();
  const ps1 = build();
  return {
    sh: { ...(await runAsync(BASH, [SCRIPTS.sh, ...args], sh.cwd)), ...sh },
    ps1: { ...(await runAsync("pwsh", ["-NoProfile", "-NonInteractive", "-File", SCRIPTS.ps1, ...args], ps1.cwd)), ...ps1 },
  };
}

function expectSameBytes(o: Awaited<ReturnType<typeof bothSpellings>>): { stdout: string; stderr: string } {
  const sh = { out: normalise(o.sh.stdout, o.sh.root), err: normalise(o.sh.stderr, o.sh.root) };
  const ps1 = { out: normalise(o.ps1.stdout, o.ps1.root), err: normalise(o.ps1.stderr, o.ps1.root) };
  expect(ps1.out).toBe(sh.out);
  expect(ps1.err).toBe(sh.err);
  expect(o.ps1.status).toBe(o.sh.status);
  return { stdout: sh.out, stderr: sh.err };
}

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    const line = "release: probe-unit 1.2.3-stable-20260904103359 (commit 17f0eb9) is on its way to dev\n";
    expect(normalise(line, "/nowhere")).toBe("release: probe-unit 1.2.3-stable-<ts14> (commit <sha7>) is on its way to dev\n");
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

  it("refuses a malformed version identically", RUNS, async () => {
    const { stderr, stdout } = expectSameBytes(await bothSpellings(() => bareDir(), ["1.2", "stable", "dev"]));
    expect(stderr).toBe("release: version must be x.y.z with no leading zeros (got '1.2')\n");
    expect(stdout).toBe("");
  });

  it("warns about the channel ceiling and refuses a directory that is no repository, identically", RUNS, async () => {
    const { stderr } = expectSameBytes(await bothSpellings(() => bareDir(), ["1.2.3", "alpha", "prod"]));
    // The ceiling WARNS and continues; the refusal underneath is the next thing either spelling says.
    expect(stderr).toContain("release: WARNING - channel alpha admits only: dev.");
    expect(stderr).toContain("release: not inside a git repository\n");
  });

  it("refuses a dirty worktree identically", RUNS, async () => {
    const { stderr } = expectSameBytes(await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, dirty: true }), ["1.2.3", "stable", "dev"]));
    expect(stderr).toBe("release: worktree is dirty - commit or stash before releasing\n");
  });

  it("refuses a manifest that states no name identically, naming the same path", RUNS, async () => {
    // The path is composed by each spelling out of the repository root git answers with. Written with
    // a backslash on one side it would differ here by every separator in it.
    const { stderr } = expectSameBytes(await bothSpellings(() => fixtureRepo({}), ["1.2.3", "stable", "dev"]));
    expect(stderr).toBe(
      "release: the manifest <root>/work/deploy/platform.yaml states no name - it is what the release line and any pin are written under\n",
    );
  });

  it("performs the whole success path identically, down to the byte", RUNS, async () => {
    // A unit that declares no platformRepo: it stamps the version, mints and pushes the tag, pushes
    // the deploy ref, and reports. Nothing here reaches the network — origin is a bare repository
    // beside the working tree — so this is the whole of what such a release does.
    const { stdout, stderr } = expectSameBytes(
      await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true }), ["1.2.3", "stable", "dev"]),
    );
    expect(stdout).toBe([
      "release: package.json declares 1.2.3",
      "release: minted 1.2.3-stable-<ts14>",
      "release: deploy/dev stands at <sha7>",
      "release: the manifest <root>/work/deploy/platform.yaml names no platformRepo, so nothing is pinned from here - the deploy ref above is what the platform reacts to",
      "release: probe-unit 1.2.3-stable-<ts14> (commit <sha7>) is on its way to dev",
      "release: the platform builds these image tags, or skips the build when they already exist:",
      "    probe:1.2.3-stable-<ts14>-<sha7>",
      "",
    ].join("\n"));
    // git's own push lines are on standard error, and they are the same on both sides too.
    expect(stderr).toContain("deploy/dev/1.2.3-stable-<ts14>");
  });

  it("stamps every package.json the repository tracks in the one release commit, identically", RUNS, async () => {
    const o = await bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, workspace: true, origin: true }), ["1.2.3", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(stdout.split("\n").slice(0, 3)).toEqual([
      "release: packages/b/package.json declares no version - nothing to stamp",
      "release: package.json declares 1.2.3",
      "release: packages/a/package.json declares 1.2.3",
    ]);
    for (const f of [o.sh, o.ps1]) {
      const shown = run("git", ["show", "--name-only", "--format=%s", "HEAD~0"], f.cwd).stdout;
      expect(shown.split("\n").filter(Boolean)).toEqual([expect.stringMatching(/^release: 1\.2\.3-stable-\d{14}$/), "package.json", "packages/a/package.json"]);
      expect(readFileSync(join(f.cwd, "packages", "a", "package.json"), "utf8")).toContain('"version": "1.2.3",\n  "dependencies": { "x": "1.0.0" }');
      expect(readFileSync(join(f.cwd, "packages", "b", "package.json"), "utf8")).toBe('{\n  "name": "b"\n}\n');
    }
  });

  // A RERUN FOR A VERSION THAT ALREADY STANDS ON ORIGIN, in its three shapes. A version names one
  // commit (#173): the tag on HEAD is reused and the delivery ref moves; the tag on another commit is
  // refused before any push and the refusal names the next number; a tag that never reached origin is
  // residue and is cut again. Each is performed by both spellings and read back off origin.

  it("refuses a rerun whose tag stands on origin on another commit, before any push, naming the next number", RUNS, async () => {
    const before = new Map<string, string>();
    const o = await bothSpellings(() => {
      const f = releasedRepo({ moved: true });
      before.set(f.cwd, originRefs(f));
      return f;
    }, ["1.2.3", "stable", "test"]);
    const { stdout, stderr } = expectSameBytes(o);
    expect(o.sh.status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "release: 1.2.3-stable-<ts14> stands on origin at <sha7> and HEAD is <sha7>. A version names one commit, so 1.2.3 is burnt: release 1.2.4 instead. Nothing was pushed.\n",
    );
    for (const f of [o.sh, o.ps1]) {
      // Nothing on origin moved: not the delivery branch of the stage asked for, not the one of the
      // stage already released, not the tag.
      expect(originRefs(f)).toBe(before.get(f.cwd));
      expect(originRefs(f)).not.toContain("refs/heads/deploy/test");
      expect(originRefs(f)).not.toContain(`${head(f)}\trefs/heads/deploy/dev`);
    }
  });

  it("reuses a tag that stands on origin on HEAD and moves the delivery ref — a further stage, or a retry", RUNS, async () => {
    const o = await bothSpellings(() => releasedRepo({ moved: false }), ["1.2.3", "stable", "test"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: reusing the existing release 1.2.3-stable-<ts14> - one release per version+channel, so putting it on test rebuilds nothing\n");
    expect(stdout).toContain("release: deploy/test stands at <sha7>\n");
    expect(stdout).not.toContain("minted");
    for (const f of [o.sh, o.ps1]) {
      const [tag] = releaseTags(f);
      expect(releaseTags(f)).toHaveLength(1);
      expect(originRefs(f)).toContain(`${head(f)}\trefs/heads/deploy/test\n`);
      expect(originRefs(f)).toContain(`refs/tags/deploy/test/${tag}\n`);
    }
  });

  it("drops a tag that never reached origin and names another commit, and cuts the release again", RUNS, async () => {
    const o = await bothSpellings(() => residueRepo(), ["1.2.3", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain(
      "release: 1.2.3-stable-<ts14> stands on this machine only and names <sha7>, not the commit being released. A run whose push was refused left it behind; it is dropped and cut again.\n",
    );
    expect(stdout).toContain("release: minted 1.2.3-stable-<ts14>\n");
    for (const f of [o.sh, o.ps1]) {
      const tags = releaseTags(f);
      expect(tags).toHaveLength(1);
      expect(tags[0]).not.toBe("1.2.3-stable-20200101000000");
      expect(originRefs(f)).toContain(`refs/tags/${tags[0]}\n`);
      expect(originRefs(f)).toContain(`${head(f)}\trefs/heads/deploy/dev\n`);
    }
  });

  it("pushes a tag that stands on HEAD here and is missing on origin, then reuses it — the push a cut run still owed (#227)", RUNS, async () => {
    const o = await bothSpellings(() => owedPushRepo(), ["1.2.3", "stable", "dev"]);
    const { stdout } = expectSameBytes(o);
    expect(o.sh.status).toBe(0);
    expect(stdout).toContain("release: 1.2.3-stable-<ts14> stands on this machine only, on the commit being released - its push never reached origin; pushed now\n");
    expect(stdout).toContain("release: reusing the existing release 1.2.3-stable-<ts14> - one release per version+channel, so putting it on dev rebuilds nothing\n");
    expect(stdout).not.toContain("minted");
    for (const f of [o.sh, o.ps1]) {
      expect(releaseTags(f)).toEqual(["1.2.3-stable-20200101000000"]);
      expect(originRefs(f)).toContain("refs/tags/1.2.3-stable-20200101000000\n");
      expect(originRefs(f)).toContain(`${head(f)}\trefs/heads/deploy/dev\n`);
    }
  });

  it("COUNTER-PROBE: the comparison sees a difference when there is one", RUNS, () => {
    // Two runs of the SAME spelling with different arguments must not compare equal, or every
    // assertion above would be comparing something to itself.
    const a = run(BASH, [SCRIPTS.sh, "1.2", "stable", "dev"], tempDir());
    const b = run(BASH, [SCRIPTS.sh, "1.2.3", "banana", "dev"], tempDir());
    expect(normalise(b.stderr, "/nowhere")).not.toBe(normalise(a.stderr, "/nowhere"));
  });
});
