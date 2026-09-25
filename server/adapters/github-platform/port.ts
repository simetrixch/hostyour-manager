// The port of the PLATFORM repository on GitHub: the branches view and the reset wizard read and
// write it through this interface, and github-platform-http.ts is its implementation.

export interface BranchRef {
  name: string;
  /** HEAD commit sha of the branch. */
  sha: string;
}

export interface DiffFile {
  filename: string;
  /** "added" | "modified" | "removed" | "renamed" | … (GitHub file status). */
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunk for the file. Absent for binary/too-large files (GitHub omits it). */
  patch?: string;
}

export interface BranchComparison {
  /** Commits `head` is ahead of `base` by (i.e. the install branch's own commits). */
  aheadBy: number;
  behindBy: number;
  files: DiffFile[];
  /** True when GitHub capped the file list (very large diffs) — surface it, never pretend full. */
  truncated: boolean;
}

export interface GitHubPlatform {
  /** Every branch in the repo (paginated), sorted by name. */
  listBranches(): Promise<BranchRef[]>;
  /** Compare `base`…`head` (three-dot/merge-base semantics: files = head's own changes since it
   *  diverged from base). */
  compare(base: string, head: string): Promise<BranchComparison>;
  /** Delete a branch ref (DELETE …/git/refs/heads/<name>). Idempotent: a missing ref is tolerated. */
  deleteBranch(name: string): Promise<void>;
  /** Delete `paths` from `branch` in ONE commit via the git-data API (ref → tree → commit →
   *  ref update). Paths absent on the branch are skipped; when none exist the branch is left
   *  untouched (commitSha: null) — idempotent. Throws GitHubPlatformError when the branch is missing,
   *  the tree listing is truncated (refuse a blind delete, never pretend), or the ref update
   *  races a concurrent push (non-fast-forward). */
  deletePaths(branch: string, paths: string[], message: string): Promise<{ removed: string[]; commitSha: string | null }>;
  /** All blob paths on `branch` (recursive tree). Throws on a missing branch or a truncated
   *  listing — never a silently partial answer. */
  listBlobs(branch: string): Promise<string[]>;
}

export class GitHubPlatformError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubPlatformError";
    this.status = status;
  }
}
