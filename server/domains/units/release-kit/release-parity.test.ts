import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_KIT_FILES } from "./release-kit.ts";

// THE TWO SPELLINGS ANSWER THE SAME BYTES, AND THIS RUNS THEM TO FIND OUT.
//
// release.sh and release.ps1 are held to answering identically. That claim used to rest on a
// comparison that could not see two of the ways they differed. Both were measured while building the
// platform's own release pair:
//
//   PRINTED EM DASHES WERE MANGLED. [Console]::Error.WriteLine writes in the console's code page, so
//   a `—` in a printed string arrived as `-`. Every refusal carrying one differed between the two.
//
//   LINE ENDINGS DIFFERED BY A BYTE. A PowerShell host ends every line with two bytes where the shell
//   writes one — nine bytes on a short message — and it stood unnoticed because the comparison used
//   `sed` as its normaliser: `sed` on Windows reads in text mode and silently drops a carriage
//   return. Measured: a two-carriage-return input came back with zero. The comparison was green while
//   the difference stood.
//
// So this normalises in this process and never through a tool that rewrites what it is given, and it
// carries the probe below: a normaliser that starts dropping a carriage return fails the probe rather
// than quietly passing every comparison after it.
//
// WHAT IS COMPARED: the exit status, every byte of standard output and every byte of standard error,
// over the refusals and the whole success path of a unit that pins nothing. The paths that need a
// build plane (the wait, the pin) need `gh` and a network and are not reached here; what those add is
// the same printing helpers, held to ASCII by the census below.

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPTS = {
  sh: join(REPO_ROOT, "release", "release.sh"),
  ps1: join(REPO_ROOT, "release", "release.ps1"),
};

/** Run one command and answer everything it produced, without throwing on a refusal: a refusal is
 *  exactly what most of these scenarios are, and its bytes are the subject. */
function run(file: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mgr-parity-"));
  dirs.push(dir);
  return dir;
}

/** Can that interpreter be reached AND enter a directory of this filesystem? Asked as the thing it
 *  will actually be asked to do, because a name on the PATH is not the same question: a `bash` that
 *  cannot take a path of this operating system would answer every scenario with its own error. */
function usable(kind: "sh" | "ps1"): boolean {
  const dir = tempDir();
  const r = kind === "sh"
    ? run("bash", ["-c", "printf ok"], dir)
    : run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('ok')"], dir);
  return r.stdout === "ok";
}

/** What a scenario that spawns interpreters is given. Each one builds two git repositories and runs
 *  two interpreters over them, which is minutes' worth of nothing on a loaded machine and well past
 *  the default a pure in-process test is given. */
const RUNS = { timeout: 120_000 };

const USABLE = { sh: usable("sh"), ps1: usable("ps1") };
const BOTH = USABLE.sh && USABLE.ps1;

/**
 * The volatile values a release writes, and NOTHING else. Every other byte survives, the carriage
 * return included — which is the whole point: the difference this normaliser must not hide is the one
 * that hid for weeks.
 *
 * It is a function in this process and not a tool the text is piped through. `sed` on Windows reads
 * its input in text mode and drops a carriage return without saying so, so a comparison built on it
 * cannot go red on a line-ending difference at all.
 */
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
function fixtureRepo(opts: { manifest?: string; packageJson?: boolean; origin?: boolean; dirty?: boolean }): Fixture {
  const base = tempDir();
  const work = join(base, "work");
  mkdirSync(work);
  const git = (...args: string[]): void => {
    const r = run("git", args, work);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q", "-b", "master");
  git("config", "user.email", "parity@example.invalid");
  git("config", "user.name", "Parity");
  git("config", "core.autocrlf", "false");
  if (opts.manifest !== undefined) {
    mkdirSync(join(work, "deploy"));
    writeFileSync(join(work, "deploy", "platform.yaml"), opts.manifest);
  }
  if (opts.packageJson) writeFileSync(join(work, "package.json"), '{\n  "name": "probe",\n  "version": "0.0.1"\n}\n');
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

/** One scenario, performed twice on two identical repositories. */
function bothSpellings(build: () => Fixture, args: string[]): { sh: ReturnType<typeof run> & { root: string }; ps1: ReturnType<typeof run> & { root: string } } {
  const sh = build();
  const ps1 = build();
  return {
    sh: { ...run("bash", [SCRIPTS.sh, ...args], sh.cwd), root: sh.root },
    ps1: { ...run("pwsh", ["-NoProfile", "-NonInteractive", "-File", SCRIPTS.ps1, ...args], ps1.cwd), root: ps1.root },
  };
}

function expectSameBytes(o: ReturnType<typeof bothSpellings>): { stdout: string; stderr: string } {
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
    // is one byte per line, and the previous normaliser dropped exactly that byte: `sed` on Windows
    // read a two-carriage-return input and answered with zero.
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

describe("every printed line of both spellings is ASCII", () => {
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

describe.skipIf(!BOTH)("both spellings, run", () => {
  if (!BOTH) {
    // eslint-disable-next-line no-console -- a skipped comparison must be loud: a silent skip reads as a pass
    console.warn(
      `no ${!USABLE.sh ? "bash" : "pwsh"} this suite can reach on a path of this filesystem — install it, or the two ` +
      "spellings of the release script have never been run against each other on this machine",
    );
  }

  it("refuses a malformed version identically", RUNS, () => {
    const { stderr, stdout } = expectSameBytes(bothSpellings(() => bareDir(), ["1.2", "stable", "dev"]));
    expect(stderr).toBe("release: version must be x.y.z with no leading zeros (got '1.2')\n");
    expect(stdout).toBe("");
  });

  it("warns about the channel ceiling and refuses a directory that is no repository, identically", RUNS, () => {
    const { stderr } = expectSameBytes(bothSpellings(() => bareDir(), ["1.2.3", "alpha", "prod"]));
    // The ceiling WARNS and continues; the refusal underneath is the next thing either spelling says.
    expect(stderr).toContain("release: WARNING - channel alpha admits only: dev.");
    expect(stderr).toContain("release: not inside a git repository\n");
  });

  it("refuses a dirty worktree identically", RUNS, () => {
    const { stderr } = expectSameBytes(bothSpellings(() => fixtureRepo({ manifest: MANIFEST, dirty: true }), ["1.2.3", "stable", "dev"]));
    expect(stderr).toBe("release: worktree is dirty - commit or stash before releasing\n");
  });

  it("refuses a manifest that states no name identically, naming the same path", RUNS, () => {
    // The path is composed by each spelling out of the repository root git answers with. Written with
    // a backslash on one side it would differ here by every separator in it.
    const { stderr } = expectSameBytes(bothSpellings(() => fixtureRepo({}), ["1.2.3", "stable", "dev"]));
    expect(stderr).toBe(
      "release: the manifest <root>/work/deploy/platform.yaml states no name - it is what the release line and any pin are written under\n",
    );
  });

  it("performs the whole success path identically, down to the byte", RUNS, () => {
    // A unit that declares no platformRepo: it stamps the version, mints and pushes the tag, pushes
    // the deploy ref, and reports. Nothing here reaches the network — origin is a bare repository
    // beside the working tree — so this is the whole of what such a release does.
    const { stdout, stderr } = expectSameBytes(
      bothSpellings(() => fixtureRepo({ manifest: MANIFEST, packageJson: true, origin: true }), ["1.2.3", "stable", "dev"]),
    );
    expect(stdout).toBe([
      "release: package.json declares 1.2.3",
      "release: minted 1.2.3-stable-<ts14>",
      "release: the manifest <root>/work/deploy/platform.yaml names no platformRepo, so nothing is pinned from here - the deploy ref above is what the platform reacts to",
      "release: probe-unit 1.2.3-stable-<ts14> (commit <sha7>) is on its way to dev",
      "release: the platform builds these image tags, or skips the build when they already exist:",
      "    probe:1.2.3-stable-<ts14>-<sha7>",
      "",
    ].join("\n"));
    // git's own push lines are on standard error, and they are the same on both sides too.
    expect(stderr).toContain("deploy/dev/1.2.3-stable-<ts14>");
  });

  it("COUNTER-PROBE: the comparison sees a difference when there is one", RUNS, () => {
    // Two runs of the SAME spelling with different arguments must not compare equal, or every
    // assertion above would be comparing something to itself.
    const a = run("bash", [SCRIPTS.sh, "1.2", "stable", "dev"], tempDir());
    const b = run("bash", [SCRIPTS.sh, "1.2.3", "banana", "dev"], tempDir());
    expect(normalise(b.stderr, "/nowhere")).not.toBe(normalise(a.stderr, "/nowhere"));
  });
});
