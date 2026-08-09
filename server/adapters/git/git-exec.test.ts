// The budget every git the adapter runs is held to. Local only — the failure being measured is a
// child that never returns, and a child reading a pipe nobody writes to produces it without a
// network, deterministically, in milliseconds.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git-exec.ts";
import { AppError } from "../../kernel/errors.ts";

/** A git that waits forever: `--stdin` reads until end-of-input, and execFile opens the child's
 *  stdin as a pipe it never writes to and never closes. This is what a remote that accepts the
 *  connection and then says nothing looks like from inside this process. */
const WAITS_FOREVER = ["hash-object", "--stdin"];

describe("the budget a git is held to", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hostyour-git-exec-"));
  const cleanUp = (): void => rmSync(cwd, { recursive: true, force: true });

  it("kills a git that never returns, and says it was the budget", async () => {
    // Without this the process waits as long as the other side does, which for a black-holed
    // network is not a bounded time. Prompts-off already ends a git waiting for INPUT; nothing
    // ended one waiting for a remote.
    const started = Date.now();
    await expect(runGit(WAITS_FOREVER, { cwd, timeoutMs: 250 })).rejects.toThrow(/exceeded the 250ms budget/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("names the budget rather than an empty reason", async () => {
    // A killed child wrote nothing to stderr, so the generic path would report
    // `git hash-object failed:` with nothing after it — the least readable failure of the two.
    const raised = await runGit(WAITS_FOREVER, { cwd, timeoutMs: 250 }).catch((e: unknown) => e);

    expect(raised).toBeInstanceOf(AppError);
    const error = raised as AppError;
    expect(error.message).toContain("git hash-object");
    expect(error.message).not.toMatch(/failed:\s*$/);
    expect(error.detail).toMatchObject({ code: "TIMEOUT" });
  });

  it("leaves a git that answers alone", async () => {
    // The counter-probe: without it every one of the assertions above would also pass on a runGit
    // that simply refused everything.
    const version = await runGit(["--version"], { cwd, timeoutMs: 30_000 });
    expect(version).toMatch(/^git version /);
  });

  it("still reports a real failure as git's own, not as the budget", async () => {
    // A git that fails inside its budget must keep carrying git's stderr. Reporting every failure
    // as a timeout would hide the reason the caller can actually act on.
    const raised = await runGit(["rev-parse", "--verify", "refs/heads/nothing-like-this"], {
      cwd,
      timeoutMs: 30_000,
    }).catch((e: unknown) => e);

    const error = raised as AppError;
    expect(error.message).toContain("git rev-parse failed");
    expect(error.message).not.toContain("budget");
  });

  it("cleans up", () => cleanUp());
});
