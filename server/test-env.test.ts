import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vitest.setup.ts strips git's own environment before any test runs (#284). Proven by what a
// fixture does: a `git init` in a temp directory creates ITS repository there, whatever GIT_DIR the
// test run was started with.
describe("the test environment", () => {
  it("carries none of git's repository variables, so a fixture's git stays in its own directory", () => {
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) expect(process.env[key], key).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "test-env-"));
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
      expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).stdout.trim().toLowerCase()).toContain("test-env-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
