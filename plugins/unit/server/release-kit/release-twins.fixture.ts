import { expect } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
//   cannot go red on a line-ending difference at all. The probe in release-twins.test.ts plants a carriage return and
//   requires the normaliser to keep it.
//
//   EACH SCRIPT PRINTS THROUGH ITS NAMED HELPERS AND THROUGH NOTHING ELSE, which is what makes the
//   ASCII census in release-twins.test.ts total: the census reads the lines that call a helper, so a second printer
//   would print lines it never sees. ASCII is the rule because [Console]::Error.WriteLine writes in
//   the console's code page, where a `—` in a printed string arrives as `-` and every refusal
//   carrying one differs between the two.

export const SCRIPTS = {
  sh: fileURLToPath(new URL("./assets/release.sh", import.meta.url)),
  ps1: fileURLToPath(new URL("./assets/release.ps1", import.meta.url)),
};

/** Run one command and answer everything it produced, without throwing on a refusal: a refusal is
 *  exactly what most of these scenarios are, and its bytes are the subject. */
export function run(file: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The release scripts themselves, run WITHOUT blocking this worker (hostyour-manager#239): a
 *  release run takes 5-20 s, and a file of them spent over a minute inside spawnSync, during which
 *  the worker could answer none of vitest's own RPC — its `onTaskUpdate` timed out and the whole
 *  suite was reported red with every test green. The git calls of the fixtures stay synchronous:
 *  milliseconds each. */
export function runAsync(file: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !("code" in err && typeof (err as { code?: unknown }).code === "number")) { reject(err); return; }
      resolve({ status: err ? ((err as { code?: number }).code ?? null) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export const dirs: string[] = [];

export function tempDir(): string {
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
export function bashCandidates(): string[] {
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
export const SAYS = "release: ";

/** Can this bash run THE ASSET, named by a path of this filesystem, far enough to reach the asset's
 *  own refusal? Asked as the thing every scenario below asks of it, because neither a name on the
 *  PATH nor a script of our own is that question. Two interpreters on this machine run a plain
 *  script and not this one: the WSL launcher takes no path of this filesystem at all, and a BusyBox
 *  `bash.exe` on the PATH answers `syntax error: unexpected "("` on the `[[ ]]` the asset validates
 *  its version with. Either would make every comparison below one between two failures. The refusal
 *  is only read as far as the prefix, so the scenario that asserts its bytes can still go red. */
export function bashRuns(bash: string): boolean {
  return run(bash, [SCRIPTS.sh, "1.2", "stable", "dev"], tempDir()).stderr.startsWith(SAYS);
}

/** The same question of pwsh, which is how the twin is started here and on a consumer's machine. */
export function pwshRuns(): boolean {
  const dir = tempDir();
  const probe = join(dir, "probe.ps1");
  writeFileSync(probe, "[Console]::Out.Write('ok')\n");
  return run("pwsh", ["-NoProfile", "-NonInteractive", "-File", probe], dir).stdout === "ok";
}

/** What a scenario that spawns interpreters is given. Each one builds two git repositories and runs
 *  two interpreters over them, which is minutes' worth of nothing on a loaded machine and well past
 *  the default a pure in-process test is given. */
export const RUNS = { timeout: 120_000 };

/** Empty where no candidate ran the probe, which is what the loud skip below reports. */
export const BASH = bashCandidates().find(bashRuns) ?? "";
export const USABLE = { sh: BASH !== "", ps1: pwshRuns() };
export const BOTH = USABLE.sh && USABLE.ps1;

/** Replaces the volatile values a release writes, and NOTHING else. Every other byte survives, the
 *  carriage return included, because a line ending is one of the two differences this comparison
 *  exists to see. */
export function normalise(text: string, root: string): string {
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
export function fixtureRepo(opts: { manifest?: string; packageJson?: boolean; privateRoot?: boolean; workspace?: boolean; ignoredPackage?: boolean; origin?: boolean; originPreReceive?: string; dirty?: boolean; afterRelease?: { sh?: string; ps1?: string } }): Fixture {
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
  // The repository's own step after the release, in whichever spellings the scenario supplies.
  if (opts.afterRelease?.sh !== undefined) writeFileSync(join(work, "deploy", "after-release.sh"), opts.afterRelease.sh);
  if (opts.afterRelease?.ps1 !== undefined) writeFileSync(join(work, "deploy", "after-release.ps1"), opts.afterRelease.ps1);
  if (opts.packageJson) writeFileSync(join(work, "package.json"), `{\n  "name": "probe",${opts.privateRoot ? '\n  "private": true,' : ""}\n  "version": "0.0.1"\n}\n`);
  if (opts.workspace) {
    // Two packages beside the root: one that declares a version, one that declares none.
    mkdirSync(join(work, "packages", "a"), { recursive: true });
    mkdirSync(join(work, "packages", "b"), { recursive: true });
    writeFileSync(join(work, "packages", "a", "package.json"), '{\n  "name": "a",\n  "version": "0.1.0",\n  "dependencies": { "x": "1.0.0" }\n}\n');
    writeFileSync(join(work, "packages", "b", "package.json"), '{\n  "name": "b"\n}\n');
    // A name git would quote, and a file with a byte order mark and CRLF endings.
    mkdirSync(join(work, "packages", "ü"), { recursive: true });
    writeFileSync(join(work, "packages", "ü", "package.json"), '﻿{\r\n  "name": "u",\r\n  "version": "0.2.0"\r\n}\r\n');
  }
  if (opts.ignoredPackage) {
    // A package tracked inside a directory a .gitignore names: added with force once, as a
    // repository whose `storage/` rule also matches packages/storage/ carries it.
    writeFileSync(join(work, ".gitignore"), "storage/\n");
    mkdirSync(join(work, "packages", "storage"), { recursive: true });
    writeFileSync(join(work, "packages", "storage", "package.json"), '{\n  "name": "storage",\n  "version": "0.1.0"\n}\n');
    git("add", "--force", "packages/storage/package.json");
  }
  git("add", "-A");
  git("commit", "-qm", "init", "--allow-empty");
  if (opts.origin) {
    const origin = join(base, "origin.git");
    const init = run("git", ["init", "--bare", "-q", origin], base);
    if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr}`);
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "HEAD:master");
    if (opts.originPreReceive !== undefined) writeFileSync(join(origin, "hooks", "pre-receive"), `#!/bin/sh\n${opts.originPreReceive}\n`, { mode: 0o755 });
  }
  if (opts.dirty) writeFileSync(join(work, "uncommitted.txt"), "not committed\n");
  return { cwd: work, root: base };
}

export const MANIFEST = "name: probe-unit\nbuilds:\n  - name: probe\n";

/** A library: no builds, no chart and no tenant block, so nothing of it deploys. */
export const LIBRARY_MANIFEST = "name: probe-lib\n";

/** One more commit on the fixture's master, pushed to origin: the tree has moved past whatever was
 *  released before it, the way a fix landing after a refused release moves it. */
export function moveMaster(f: Fixture): void {
  writeFileSync(join(f.cwd, "fix.txt"), "landed after the release\n");
  for (const args of [["add", "fix.txt"], ["commit", "-qm", "fix"], ["push", "-q", "origin", "HEAD:master"]]) {
    const r = run("git", args, f.cwd);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

/** A repository whose 1.2.003-stable release already stands on origin, put on dev by the bash spelling:
 *  the rerun is the subject here, and the first run's bytes are what the success-path scenario
 *  asserts. With `moved`, master has one commit on top of the released one. */
export function releasedRepo(opts: { moved: boolean; version?: string }): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const first = run(BASH, [SCRIPTS.sh, opts.version ?? "1.2.003", "stable", "dev"], f.cwd);
  if (first.status !== 0) throw new Error(`the first release failed: ${first.stderr}`);
  if (opts.moved) moveMaster(f);
  return f;
}

/** A repository carrying a 1.2.003-stable tag that never reached origin and names the commit before
 *  HEAD — what a run whose push was refused leaves behind once the fix has landed. */
export function residueRepo(): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const tag = run("git", ["tag", "-a", "1.2.003-stable-20200101000000", "-m", "residue"], f.cwd);
  if (tag.status !== 0) throw new Error(`git tag failed: ${tag.stderr}`);
  moveMaster(f);
  return f;
}

/** A release whose tag's push never landed: the tag stands on HEAD here and origin lacks it (#227). */
export function owedPushRepo(): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const tag = run("git", ["tag", "-a", "1.2.003-stable-20200101000000", "-m", "owed"], f.cwd);
  if (tag.status !== 0) throw new Error(`git tag failed: ${tag.stderr}`);
  return f;
}

/** A repository released from the branch `issue-7-fix`, which an issue worktree carries: with
 *  `tracking`, it tracks origin/master under its other name. With `owed`, it holds a commit origin
 *  lacks and a release tag on it, what a run cut after its mint leaves behind. */
export function issueBranchRepo(opts: { tracking: boolean; owed?: boolean }): Fixture {
  const f = fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true });
  const git = (...args: string[]): void => {
    const r = run("git", args, f.cwd);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("checkout", "-q", "-b", "issue-7-fix");
  if (opts.tracking) git("branch", "-q", "--set-upstream-to=origin/master");
  if (opts.owed) {
    writeFileSync(join(f.cwd, "stamp.txt"), "the release commit whose push was cut\n");
    git("add", "stamp.txt");
    git("commit", "-qm", "release: 1.2.003-stable-20200101000000");
    git("tag", "-a", "1.2.003-stable-20200101000000", "-m", "owed");
  }
  return f;
}

/** Every ref origin holds, with its commit — the whole of what a release may move. */
export const originRefs = (f: Fixture): string => run("git", ["ls-remote", "origin"], f.cwd).stdout;
export const head = (f: Fixture): string => run("git", ["rev-parse", "HEAD"], f.cwd).stdout.trim();
export const releaseTags = (f: Fixture): string[] => run("git", ["tag", "-l", "1.2.003-stable-*"], f.cwd).stdout.split("\n").filter((l) => l.length > 0);

/** A directory that is no repository at all — where the two refusals needing none are performed. */
export function bareDir(): Fixture {
  const dir = tempDir();
  return { cwd: dir, root: dir };
}

/** Where a scenario is performed, and the directory every path in its output sits under. The two are
 *  not the same: git names the bare origin beside the working tree, so normalising the working tree
 *  alone would leave the one path that differs between two runs standing. */
export interface Fixture {
  cwd: string;
  root: string;
}

/** One scenario, performed twice on two identical repositories. Each side answers with its fixture
 *  as well, so a scenario can read what the run left on origin. */
export async function bothSpellings(build: () => Fixture, args: string[], ps1Args: string[] = args): Promise<{ sh: ReturnType<typeof run> & Fixture; ps1: ReturnType<typeof run> & Fixture }> {
  const sh = build();
  const ps1 = build();
  return {
    sh: { ...(await runAsync(BASH, [SCRIPTS.sh, ...args], sh.cwd)), ...sh },
    ps1: { ...(await runAsync("pwsh", ["-NoProfile", "-NonInteractive", "-File", SCRIPTS.ps1, ...ps1Args], ps1.cwd)), ...ps1 },
  };
}

export function expectSameBytes(o: Awaited<ReturnType<typeof bothSpellings>>): { stdout: string; stderr: string } {
  const sh = { out: normalise(o.sh.stdout, o.sh.root), err: normalise(o.sh.stderr, o.sh.root) };
  const ps1 = { out: normalise(o.ps1.stdout, o.ps1.root), err: normalise(o.ps1.stderr, o.ps1.root) };
  expect(ps1.out).toBe(sh.out);
  expect(ps1.err).toBe(sh.err);
  expect(o.ps1.status).toBe(o.sh.status);
  return { stdout: sh.out, stderr: sh.err };
}

/** Every temporary directory a fixture made, removed: each test file calls this from its afterAll. */
export function removeTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
