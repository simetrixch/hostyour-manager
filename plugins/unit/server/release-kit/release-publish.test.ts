import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RELEASE_KIT_WORKFLOW } from "./release-kit.ts";
import { removeTempDirs, run, tempDir } from "./release-twins.fixture.ts";

// The shell of the kit workflow's publish job, run where it stands: each step's `run:` is read out of
// the workflow the kit ships and performed by bash in a fixture repository, with the variables the
// runner would set. What needs the network (pnpm install, the registry) is a stub on PATH that records
// what it was asked, so the scan, the registry login and the dist-tag rule are measured as written.

afterAll(removeTempDirs);

type Step = { id?: string; name?: string; run?: string; uses?: string; if?: string };
const workflow = parseYaml(RELEASE_KIT_WORKFLOW.content) as { jobs: { publish: { steps: Step[]; permissions: Record<string, string> } } };
const steps = workflow.jobs.publish.steps;
const script = (name: string): string => {
  const step = steps.find((s) => s.name === name);
  if (!step?.run) throw new Error(`the publish job has no step "${name}" with a script`);
  return step.run;
};

const JQ = run("jq", ["--version"], tempDir()).status === 0;

/** A repository whose tracked files are `files`, and the runner's scratch places beside it. */
function fixture(files: Record<string, string>): { cwd: string; temp: string; output: string; home: string } {
  const base = tempDir();
  const cwd = join(base, "work");
  const temp = join(base, "runner-temp");
  const home = join(base, "home");
  for (const dir of [cwd, temp, home]) mkdirSync(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  for (const args of [["init", "-q", "-b", "master"], ["add", "-A"], ["-c", "user.email=t@e.invalid", "-c", "user.name=T", "commit", "-qm", "init", "--allow-empty"]]) {
    const r = run("git", args, cwd);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return { cwd, temp, output: join(base, "github-output"), home };
}

/** A git call in the fixture that has to succeed. */
function git(cwd: string, ...args: string[]): string {
  const r = run("git", ["-c", "user.email=t@e.invalid", "-c", "user.name=T", ...args], cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** One step's script under bash, with the runner's variables, the step's own `env`, and an optional
 *  PATH in front. */
function perform(f: ReturnType<typeof fixture>, body: string, pathFront?: string, stepEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const env = { RUNNER_TEMP: f.temp, GITHUB_OUTPUT: f.output, HOME: f.home, PATH: pathFront ? `${pathFront}:${process.env.PATH}` : process.env.PATH, ...stepEnv };
  const file = join(f.temp, "step.sh");
  writeFileSync(file, `set -e\n${body}`);
  return run("env", [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "bash", file], f.cwd);
}

const pkg = (fields: Record<string, unknown>): string => `${JSON.stringify(fields, null, 2)}\n`;
const REGISTRY = "https://npm.pkg.github.com";

describe("the publish job of the kit workflow", () => {
  it("runs with contents read and packages write, and scans before any tool is set up", () => {
    expect(workflow.jobs.publish.permissions).toEqual({ contents: "read", packages: "write" });
    const scanAt = steps.findIndex((s) => s.id === "scan");
    const pnpmAt = steps.findIndex((s) => s.uses?.startsWith("pnpm/action-setup"));
    expect(scanAt).toBeGreaterThan(-1);
    expect(pnpmAt).toBeGreaterThan(scanAt);
    for (const s of steps.slice(scanAt + 1)) expect(s.if).toBe("steps.scan.outputs.found == 'true'");
  });
});

describe.skipIf(!JQ)("the publish job's shell, run", () => {
  if (!JQ) {
    // eslint-disable-next-line no-console -- a skipped measurement must be loud: a silent skip reads as a pass
    console.warn("no jq on this machine — the publish job's scan has not been run against a repository here");
  }

  it("finds nothing to publish where every package is private or names no registry, and says so", () => {
    // A unit's own tree: a private root without packageManager (digita-jobs has none), a private
    // workspace package, and one that forgot `private` but names no registry.
    const f = fixture({
      "package.json": pkg({ name: "unit", private: true, version: "0.3.0" }),
      "packages/a/package.json": pkg({ name: "@x/a", private: true, version: "0.3.0", publishConfig: { registry: REGISTRY } }),
      "packages/b/package.json": pkg({ name: "@x/b", version: "0.3.0" }),
    });
    const r = perform(f, script("Find the packages to publish"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to publish");
    expect(readFileSync(f.output, "utf8")).toBe("found=false\n");
  });

  it("lists every package that is not private and names publishConfig.registry, with its folder", () => {
    const f = fixture({
      "package.json": pkg({ name: "root", private: true, version: "0.3.0", packageManager: "pnpm@11.7.0" }),
      "minimal/package.json": pkg({ name: "@x/minimal", version: "0.3.1", publishConfig: { registry: REGISTRY } }),
      "build-tools/css/package.json": pkg({ name: "css-tools", private: true, version: "0.3.1" }),
    });
    const r = perform(f, script("Find the packages to publish"));
    expect(r.status).toBe(0);
    expect(readFileSync(f.output, "utf8")).toBe("found=true\n");
    expect(readFileSync(join(f.temp, "publishable.tsv"), "utf8")).toBe(`minimal\t@x/minimal\t${REGISTRY}\n`);
  });

  it("finds a package in a folder whose name git would quote", () => {
    // PLANTED DEFECT: without core.quotePath=false git prints "caf\\303\\251/package.json", jq
    // cannot open that, and the only package to publish is dropped with a green job.
    const f = fixture({ "café/package.json": pkg({ name: "@x/cafe", version: "0.3.1", publishConfig: { registry: REGISTRY } }) });
    expect(perform(f, script("Find the packages to publish")).status).toBe(0);
    expect(readFileSync(f.output, "utf8")).toBe("found=true\n");
    expect(readFileSync(join(f.temp, "publishable.tsv"), "utf8")).toBe(`café\t@x/cafe\t${REGISTRY}\n`);
  });

  it("finds nothing in a repository without any package.json", () => {
    const f = fixture({ "README.md": "no packages\n" });
    const r = perform(f, script("Find the packages to publish"));
    expect(r.status).toBe(0);
    expect(readFileSync(f.output, "utf8")).toBe("found=false\n");
  });

  it("logs in to each registry once, by host, and names no scope", () => {
    const f = fixture({});
    writeFileSync(join(f.temp, "publishable.tsv"), `a\t@x/a\t${REGISTRY}\nb\t@x/b\t${REGISTRY}/\n`);
    expect(perform(f, script("Log in to the package registries")).status).toBe(0);
    expect(readFileSync(join(f.home, ".npmrc"), "utf8")).toBe("//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n");
  });

  it("publishes what the registry lacks under latest or the prerelease id, and skips what it holds", () => {
    const f = fixture({
      "stable/package.json": pkg({ name: "@x/stable", version: "0.3.1" }),
      "beta/package.json": pkg({ name: "@x/beta", version: "0.3.1-beta" }),
      "held/package.json": pkg({ name: "@x/held", version: "0.3.1" }),
    });
    writeFileSync(join(f.temp, "publishable.tsv"), ["stable\t@x/stable", "beta\t@x/beta", "held\t@x/held"].map((l) => `${l}\t${REGISTRY}\n`).join(""));
    // npm answers `view` as the registry would: it holds @x/held@0.3.1 and nothing else, and records a
    // publish. pnpm packs the folder it runs in and answers with the tarball's path, as `pack --json` does.
    const bin = join(f.temp, "bin");
    mkdirSync(bin);
    const log = join(f.temp, "calls.log");
    const npm = (held: string): string =>
      `#!/bin/sh\nif [ "$1" = view ]; then [ "$2" = "${held}" ] && exit 0; exit 1; fi\necho "npm $*" >> "${log}"\n`;
    writeFileSync(join(bin, "npm"), npm("@x/held@0.3.1"));
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\necho "$(basename "$PWD"): pnpm $*" >> "${log}"\nprintf '{"filename": "%s/%s.tgz"}\\n' "$4" "$(basename "$PWD")"\n`,
    );
    for (const name of ["npm", "pnpm"]) chmodSync(join(bin, name), 0o755);
    const r = perform(f, script("Publish what is not yet published"), bin);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("publish: @x/held@0.3.1 is published already");
    const packed = join(f.temp, "packed");
    expect(readFileSync(log, "utf8")).toBe([
      `stable: pnpm pack --json --pack-destination ${packed}`,
      `npm publish ${packed}/stable.tgz --tag latest`,
      `beta: pnpm pack --json --pack-destination ${packed}`,
      `npm publish ${packed}/beta.tgz --tag beta`,
      "",
    ].join("\n"));
    // pnpm publish asks GitHub for an OIDC id token and warns on every package without id-token: write.
    expect(readFileSync(log, "utf8")).not.toContain("pnpm publish");
    // COUNTER-PROBE: with a registry that holds nothing, the same step does publish @x/held, so the
    // skip above is the registry's answer and not a package the loop never reached.
    writeFileSync(join(bin, "npm"), npm("nothing"));
    writeFileSync(log, "");
    expect(perform(f, script("Publish what is not yet published"), bin).status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(`npm publish ${packed}/held.tgz --tag latest`);
  });

  it("checks out the newest release tag of the version and channel a dispatched run names, and the pushed tag on a push", () => {
    const f = fixture({ "README.md": "x\n" });
    git(f.cwd, "tag", "1.2.3-stable-20200101000000");
    git(f.cwd, "commit", "-q", "--allow-empty", "-m", "later");
    git(f.cwd, "tag", "1.2.3-stable-20210101000000");
    git(f.cwd, "tag", "1.2.3-beta-20220101000000");
    const newest = git(f.cwd, "rev-parse", "1.2.3-stable-20210101000000^{commit}");
    const dispatched = perform(f, script("Check out the release tag"), undefined, { GITHUB_EVENT_NAME: "workflow_dispatch", VERSION: "1.2.3", CHANNEL: "stable" });
    expect(dispatched.status).toBe(0);
    expect(dispatched.stdout).toContain("publish: publishing from 1.2.3-stable-20210101000000");
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(newest);
    const pushed = perform(f, script("Check out the release tag"), undefined, { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "1.2.3-stable-20200101000000" });
    expect(pushed.stdout).toContain("publish: publishing from 1.2.3-stable-20200101000000");
    const missing = perform(f, script("Check out the release tag"), undefined, { GITHUB_EVENT_NAME: "workflow_dispatch", VERSION: "9.9.9", CHANNEL: "stable" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("publish: no release tag 9.9.9-stable-* stands on origin");
  });

  it("refuses a release commit that is not on the default branch, and passes one that is", () => {
    // A clone of a bare origin, as the runner's checkout is, so refs/remotes/origin/master exists.
    const f = fixture({ "README.md": "x\n" });
    const origin = join(f.temp, "origin.git");
    git(f.temp, "init", "-q", "--bare", origin);
    git(f.cwd, "remote", "add", "origin", origin);
    git(f.cwd, "push", "-q", "origin", "HEAD:master");
    git(f.cwd, "fetch", "-q", "origin");
    const step = script("Refuse a release commit that is not on the default branch");
    expect(perform(f, step, undefined, { DEFAULT_BRANCH: "master" }).status).toBe(0);
    // A dispatched run: the job `release` pushed a stamp commit, and actions/checkout set
    // origin/master back to the commit the run started at. PLANTED DEFECT: without the step's own
    // fetch, the release commit reads as not on master and nothing is published.
    const started = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "commit", "-q", "--allow-empty", "-m", "release: 1.2.3-stable-20260101000000");
    git(f.cwd, "push", "-q", "origin", "HEAD:master");
    git(f.cwd, "update-ref", "refs/remotes/origin/master", started);
    expect(perform(f, step, undefined, { DEFAULT_BRANCH: "master" }).status).toBe(0);
    const unreadable = perform(f, step, undefined, { DEFAULT_BRANCH: "no-such-branch" });
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain("publish: no-such-branch could not be read from origin");
    git(f.cwd, "checkout", "-q", "-b", "side");
    git(f.cwd, "commit", "-q", "--allow-empty", "-m", "never merged");
    const refused = perform(f, step, undefined, { DEFAULT_BRANCH: "master" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/publish: the release commit [0-9a-f]{7} is not on master, so nothing of it is published/);
  });

  it("builds the packages with their workspace dependencies, and refuses one outside the workspace", () => {
    const f = fixture({ "README.md": "x\n" });
    mkdirSync(join(f.cwd, "a"));
    mkdirSync(join(f.cwd, "loose"));
    const bin = join(f.temp, "bin");
    mkdirSync(bin);
    const log = join(f.temp, "calls.log");
    // pnpm answers `ls` with the workspace it would have installed: the root and the folder a/.
    const members = JSON.stringify([{ path: f.cwd }, { path: join(f.cwd, "a") }]);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\ncase "$1" in\n  ls) printf '%s\\n' '${members}' ;;\n  *) echo "pnpm $*" >> "${log}" ;;\nesac\n`);
    chmodSync(join(bin, "pnpm"), 0o755);
    const step = script("Install and build the packages");
    writeFileSync(join(f.temp, "publishable.tsv"), `a\t@x/a\t${REGISTRY}\n`);
    expect(perform(f, step, bin).status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("pnpm install --frozen-lockfile\npnpm --filter @x/a... run --if-present build\n");
    writeFileSync(log, "");
    writeFileSync(join(f.temp, "publishable.tsv"), `a\t@x/a\t${REGISTRY}\nloose\t@x/loose\t${REGISTRY}\n`);
    const refused = perform(f, step, bin);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("publish: @x/loose (loose) is no package of this pnpm workspace, so nothing here builds it");
    expect(readFileSync(log, "utf8")).toBe("pnpm install --frozen-lockfile\n");
  });
});
