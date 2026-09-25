// The REAL-git fixtures the git adapter's integration tests run against: throwaway temp roots and
// bare file:// origins, seeded through a normal clone. No network, no clusters, no credentials.
//
// It stands beside fake.ts rather than inside a test file because two test files need it — git.test.ts
// reads the reader, the consumer repo and one platform turn, git-books-branch.test.ts reads the one
// branch this adapter may create and carry — and a second copy of a fixture drifts from the first the
// day one of them is corrected.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];

/** A fresh temp directory, remembered for dropRoots(). */
export function newRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "git-impl-"));
  roots.push(r);
  return r;
}

/** Remove every root this file's tests made. Windows can hold transient locks on .git objects, and a
 *  leaked temp directory is harmless, so a failure to remove one is not a failure of the test. */
export function dropRoots(): void {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // see above
    }
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" },
  });
}

export function commitAll(cwd: string, message: string): void {
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** A bare file:// origin seeded (via a throwaway clone) with hello.txt + deploy/platform.yaml on `main`. */
export function makeOrigin(): { originDir: string; originURL: string; seed: string; sha: string } {
  const root = newRoot();
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const originDir = join(root, "origin.git");
  git(root, "init", "-q", "-b", "main", "seed");
  const seed = join(root, "seed");
  writeFileSync(join(seed, "hello.txt"), "hello platform\n");
  mkdirSync(join(seed, "deploy"));
  writeFileSync(join(seed, "deploy", "platform.yaml"), "kind: ConsumerManifest\n");
  commitAll(seed, "c1");
  git(seed, "remote", "add", "origin", originDir);
  git(seed, "push", "-q", "origin", "main");
  return { originDir, originURL: pathToFileURL(originDir).href, seed, sha: git(seed, "rev-parse", "HEAD").trim() };
}

/** A bare file:// origin carrying ONLY the trunk — the state the tenant catalog is in before any
 *  installation exists: one branch, `master`, with the product on it and no books anywhere. */
export function makeTrunkOnlyOrigin(): { originDir: string; originURL: string; seed: string; trunkSha: string } {
  const root = newRoot();
  git(root, "init", "-q", "--bare", "-b", "master", "origin.git");
  const originDir = join(root, "origin.git");
  git(root, "init", "-q", "-b", "master", "seed");
  const seed = join(root, "seed");
  mkdirSync(join(seed, "charts"));
  writeFileSync(join(seed, "charts", "Chart.yaml"), "name: example-engine\n");
  commitAll(seed, "the product");
  git(seed, "remote", "add", "origin", originDir);
  git(seed, "push", "-q", "origin", "master");
  return { originDir, originURL: pathToFileURL(originDir).href, seed, trunkSha: git(seed, "rev-parse", "HEAD").trim() };
}

/** One more commit on that origin's trunk — a chart the catalog gained after an installation's books
 *  branch was born. Returns the new trunk head. */
export function advanceTrunk(seed: string, chart: string): string {
  writeFileSync(join(seed, "charts", `${chart}.yaml`), `name: ${chart}\n`);
  commitAll(seed, `the product gains ${chart}`);
  git(seed, "push", "-q", "origin", "master");
  return git(seed, "rev-parse", "HEAD").trim();
}
