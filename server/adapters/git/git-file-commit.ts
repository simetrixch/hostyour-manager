import { runGit } from "./git-exec.ts";
import { readWorkdirFile, safePath } from "./git-workdir.ts";

/** The commit that last wrote the current file, independent of later commits to other paths.
 *  An absent file has no current owner, including when its history contains a deletion. */
export async function readWorkdirFileCommit(workdir: string, relPath: string): Promise<{ commit: string; message: string } | null> {
  safePath(workdir, relPath);
  if (await readWorkdirFile(workdir, relPath) === null) return null;
  const raw = await runGit(["log", "-1", "--first-parent", "--format=%H%n%B", "--", `:(literal)${relPath}`], { cwd: workdir });
  if (!raw.trim()) return null;
  const newline = raw.indexOf("\n");
  return { commit: raw.slice(0, newline), message: raw.slice(newline + 1).trimEnd() };
}
