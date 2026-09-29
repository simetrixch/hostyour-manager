// The containment layer every git role reads and stages a checkout through: one lexical guard, the
// readers and the staging of writes, so a path can never leave the workdir and can never touch .git —
// whether it comes from a registration path, a values-chain path or a consumer's own chart path. Kept
// beside git-exec.ts (the process layer) and out of git.ts (the roles), which is what keeps that file
// inside its line budget.
import { chmod, mkdir, readdir, readFile as fsReadFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { errValidation } from "../../kernel/errors.ts";
import { runGit } from "./git-exec.ts";
import type { RepoFileWrite } from "./port.ts";

// Containment guard: the resolved path must stay inside the workdir and may not touch .git
// (a write there could smuggle config/hooks; reads have no business there either).
export function safePath(workdir: string, relPath: string): string {
  const root = resolve(workdir);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) throw errValidation(`path escapes the workdir: "${relPath}"`);
  const first = relative(root, abs).split(sep)[0];
  if (first === ".git") throw errValidation(`path may not touch .git: "${relPath}"`);
  return abs;
}

// Shared by every role: null when absent (or a directory), errValidation when the path — or a
// symlink inside the checkout — would land outside the workdir.
export async function readWorkdirFile(workdir: string, relPath: string): Promise<string | null> {
  const abs = safePath(workdir, relPath);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
  const root = await realpath(resolve(workdir));
  if (real !== root && !real.startsWith(root + sep)) throw errValidation(`path escapes the workdir (symlink): "${relPath}"`);
  try {
    return await fsReadFile(real, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
    throw e;
  }
}

// List the immediate entries directly under a workdir-relative directory. Same containment law as
// readWorkdirFile (lexical safePath + a realpath symlink-escape check), and the same absent-is-empty
// contract: a missing directory (or a file where a dir was expected) reads as [] rather than throwing,
// so the app-catalog degrades softly on a repo whose layout moved.
export async function listWorkdirDir(workdir: string, relPath: string): Promise<string[]> {
  const abs = safePath(workdir, relPath);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
  const root = await realpath(resolve(workdir));
  if (real !== root && !real.startsWith(root + sep)) throw errValidation(`path escapes the workdir (symlink): "${relPath}"`);
  try {
    return await readdir(real);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

// Every content a workdir-relative file has had along the checked-out branch's first-parent line,
// newest first: one per commit that added or changed it, [] where it was never written. `--first-parent`
// keeps to the branch's own line: a merge that carried another branch in counts where it changed the
// file, that branch's own commits do not. `AM` and not the exclusion form `d`: on the git of the Manager
// image (2.39) `--diff-filter=d` answers no commit at all. Same lexical guard as the readers above; the
// contents come from git's object store, not from the worktree.
export async function readWorkdirFileHistory(workdir: string, relPath: string): Promise<string[]> {
  safePath(workdir, relPath);
  const shas = (await runGit(["log", "--first-parent", "--diff-filter=AM", "--format=%H", "--", relPath], { cwd: workdir })).split("\n").filter(Boolean);
  return Promise.all(shas.map((sha) => runGit(["show", `${sha}:${relPath}`], { cwd: workdir })));
}

// Whether the checkout's index records a workdir-relative file as 100755. The index is git's own record
// of the mode, and it holds where the filesystem keeps no executable bits (core.fileMode=false).
// `:(literal)` makes git read the path as a name, never as a glob.
export async function isWorkdirFileExecutable(workdir: string, relPath: string): Promise<boolean> {
  safePath(workdir, relPath);
  return (await runGit(["ls-files", "-s", "--", `:(literal)${relPath}`], { cwd: workdir })).startsWith("100755 ");
}

// Writes and stages files and stages removes, for every role that commits. A path staged for BOTH
// (e.g. an offboard re-run where fromPath === toPath) would git-add the identical bytes and then git-rm
// the same path, committing a spurious DELETE that self-destructs the pointer; a written path always
// wins over a remove. An entry's `executable` sets the mode on disk, where `git add` reads it, and in
// the index, for a filesystem that keeps no executable bits. Both must agree: a mode left differing
// between disk and index is an unstaged change, and a push retry's `pull --rebase` refuses to run.
export async function stageWorkdirChanges(
  workdir: string,
  change: { write?: RepoFileWrite[]; remove?: string[] },
  run: (args: string[]) => Promise<string>,
): Promise<void> {
  const writes = change.write ?? [];
  const writePaths = new Set(writes.map((w) => w.path));
  const removes = (change.remove ?? []).filter((p) => !writePaths.has(p));
  for (const w of writes) {
    const abs = safePath(workdir, w.path);
    if (abs === resolve(workdir)) throw errValidation(`invalid write path: "${w.path}"`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, w.content, "utf8");
    if (w.executable !== undefined) await chmod(abs, w.executable ? 0o755 : 0o644);
  }
  if (writes.length > 0) await run(["add", "--", ...writes.map((w) => w.path)]);
  for (const [flag, executable] of [["--chmod=+x", true], ["--chmod=-x", false]] as const) {
    const paths = writes.filter((w) => w.executable === executable).map((w) => w.path);
    if (paths.length > 0) await run(["update-index", flag, "--", ...paths]);
  }
  if (removes.length > 0) {
    for (const p of removes) safePath(workdir, p);
    await run(["rm", "-q", "-r", "--ignore-unmatch", "--", ...removes]);
  }
}
