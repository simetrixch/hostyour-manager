// gate-runner/src/workspace.ts
// The workspace (clone) file source. The gate runs as a one-shot Tekton task, so the repo is already
// on disk (a git clone at the pinned SHA in the `source` workspace): git's own content-addressing at
// the resolved 40-char SHA IS the integrity proof (the Manager resolved + pinned that SHA before
// dispatching the run). This module walks that cloned tree into the gates' read-only ctx.files
// (repo-relative forward-slash path -> UTF-8 contents; binary files omitted), with a fail-closed
// binary/UTF-8 rule, a total-read cap, and a workspace-escape guard on every entry.
// It EXCLUDES .git/ — git internals are not repo content the gates inspect.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/** The total-read budget across every file handed to the gates. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Decode a file's bytes as UTF-8, or return null if it is binary / not valid UTF-8 (so it is
 *  read-but-omitted from ctx.files). A NUL byte marks binary; the round-trip catches invalid
 *  UTF-8 sequences, which `toString("utf8")` silently rewrites to U+FFFD (changing the bytes). */
export function decodeUtf8(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : null;
}

/** Walk every regular file under `root` (realpath-checked to stay inside `wsReal`), as a workspace-
 *  relative forward-slash path, EXCLUDING any `.git` directory. Symlinks are skipped (not regular
 *  files); a symlink whose target escapes the workspace throws (fail-closed) — a hostile repo cannot
 *  smuggle an out-of-tree read through a link. */
async function walkRepoFiles(root: string, wsReal: string): Promise<string[]> {
  const prefix = wsReal + sep;
  const out: string[] = [];
  const relOf = (full: string): string => relative(wsReal, full).split(sep).join("/");
  const assertInside = async (full: string): Promise<void> => {
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      throw new Error(`workspace: could not resolve path ${relOf(full)} (fail-closed)`);
    }
    if (real !== wsReal && !real.startsWith(prefix)) {
      throw new Error(`workspace: entry escapes the workspace: ${relOf(full)} -> ${real}`);
    }
  };
  const recurse = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Exclude the clone's .git wherever it appears (the clone dir, or a nested submodule's .git).
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        await assertInside(full); // a link is allowed only if it stays inside; a regular file it is not
        continue;
      }
      if (entry.isDirectory()) {
        await assertInside(full);
        await recurse(full);
        continue;
      }
      if (entry.isFile()) {
        await assertInside(full);
        out.push(relOf(full));
      }
      // FIFOs, sockets, devices: not regular files, silently ignored.
    }
  };
  await recurse(root);
  return out;
}

/** Read a cloned repo directory into the gates' read-only ctx.files map (repo-relative path -> UTF-8;
 *  binary files omitted). Throws (fails closed) on a symlink escaping the workspace or the total read
 *  exceeding the 64 MiB cap. */
export async function readWorkspace(dir: string, signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  const wsReal = await realpath(resolve(dir));
  const files = new Map<string, string>();
  const paths = await walkRepoFiles(wsReal, wsReal);
  let totalBytes = 0;
  for (const rel of paths) {
    if (signal?.aborted) throw new Error("workspace: aborted");
    const full = join(wsReal, ...rel.split("/"));
    totalBytes += (await stat(full)).size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`workspace: total file bytes exceed the ${MAX_TOTAL_BYTES}-byte cap (fail-closed)`);
    }
    const text = decodeUtf8(await readFile(full));
    if (text !== null) files.set(rel, text); // binary files are read-but-omitted from ctx.files
  }
  return files;
}
