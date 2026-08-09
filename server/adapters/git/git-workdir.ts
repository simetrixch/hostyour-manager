// The containment layer every git role reads a checkout through: one lexical guard and two readers,
// so a path can never leave the workdir and can never touch .git — whether it comes from a
// registration path, a values-chain path or a consumer's own chart path. Kept beside git-exec.ts (the
// process layer) and out of git.ts (the roles), which is what keeps that file inside its line budget.
import { readdir, readFile as fsReadFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { errValidation } from "../../kernel/errors.ts";

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
