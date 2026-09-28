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

/** One step's script under bash, with the runner's variables and an optional PATH in front. */
function perform(f: ReturnType<typeof fixture>, body: string, pathFront?: string): { status: number | null; stdout: string; stderr: string } {
  const env = { RUNNER_TEMP: f.temp, GITHUB_OUTPUT: f.output, HOME: f.home, PATH: pathFront ? `${pathFront}:${process.env.PATH}` : process.env.PATH };
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
    // npm answers `view` as the registry would: it holds @x/held@0.3.1 and nothing else.
    const bin = join(f.temp, "bin");
    mkdirSync(bin);
    const log = join(f.temp, "calls.log");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\n[ "$2" = "@x/held@0.3.1" ] && exit 0\nexit 1\n`);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$(basename "$PWD"): pnpm $*" >> "${log}"\n`);
    for (const name of ["npm", "pnpm"]) chmodSync(join(bin, name), 0o755);
    const r = perform(f, script("Publish what is not yet published"), bin);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("publish: @x/held@0.3.1 is published already");
    expect(readFileSync(log, "utf8")).toBe([
      "stable: pnpm publish --no-git-checks --tag latest",
      "beta: pnpm publish --no-git-checks --tag beta",
      "",
    ].join("\n"));
    // COUNTER-PROBE: with a registry that holds nothing, the same step does publish @x/held, so the
    // skip above is the registry's answer and not a package the loop never reached.
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 1\n");
    writeFileSync(log, "");
    expect(perform(f, script("Publish what is not yet published"), bin).status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("held: pnpm publish --no-git-checks --tag latest");
  });
});
