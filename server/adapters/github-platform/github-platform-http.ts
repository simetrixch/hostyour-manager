// GitHub REST adapter for the PLATFORM repo — the one fixed GITHUB_WRITE_PAT client, beside
// adapters/github-consumer (a consumer's own repo, its own per-call PAT).
// Used by the Branches view (list + compare) and the Reset wizard (delete branches + strip
// pointer files). The token is the Manager-dedicated GITHUB_WRITE_PAT (fine-grained,
// Contents: read+write on THIS repo) — deliberately NOT the slave-copied read-only
// GITOPS_REPO_PAT — injected into the Manager as env (config.github).
// Pure fetch, no SDK: keeps the dependency surface + the CSP story trivial.

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

export interface GitHubPlatformConfig {
  owner: string;
  repo: string;
  token: string;
  /** Override for tests; defaults to the public API. */
  apiBase?: string;
}

export class GitHubPlatformError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubPlatformError";
    this.status = status;
  }
}

type FetchLike = typeof fetch;

/** Refuse a ref name with empty or dot-segments (`.`/`..`) — those survive encodeURIComponent
 *  and could traverse the git-refs path (e.g. `heads/../../x`). Install-branch + master names
 *  never contain them, so this only ever rejects an attack/typo, never a legitimate branch. */
function assertSaneRef(name: string): void {
  if (name.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new GitHubPlatformError(`refusing suspicious ref name: ${name}`);
  }
}

/** Build a GitHub client. `fetchImpl` is injectable so tests never hit the network. */
export function createGitHubPlatform(cfg: GitHubPlatformConfig, fetchImpl: FetchLike = fetch): GitHubPlatform {
  const apiBase = (cfg.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const repoPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "hostyour-manager",
  };

  // `allow` lists non-2xx statuses the CALLER handles itself (default: 404). Anything else on a
  // non-ok response throws with GitHub's own message.
  async function req(path: string, init?: RequestInit, allow: number[] = [404]): Promise<Response> {
    let res: Response;
    try {
      // Auth headers ALWAYS win over caller headers (a caller `authorization` must never override
      // the PAT); content-type is not in the base set, so per-call content-type still applies.
      res = await fetchImpl(`${apiBase}${path}`, { ...init, headers: { ...(init?.headers ?? {}), ...headers } });
    } catch (e) {
      throw new GitHubPlatformError(`GitHub request failed (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok && !allow.includes(res.status)) {
      // Surface GitHub's own message (message field) — never a generic mask.
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new GitHubPlatformError(`GitHub ${init?.method ?? "GET"} ${path} → ${res.status}: ${body?.message ?? res.statusText}`, res.status);
    }
    return res;
  }

  // Shared by deletePaths + listBlobs: resolve a branch to its HEAD sha, its root tree sha, and
  // the recursive list of blob paths. Refuses a truncated tree — a blind delete against a partial
  // listing could silently skip a target, so we never pretend the listing is complete.
  async function loadTree(branch: string): Promise<{ headSha: string; baseTree: string; blobs: string[] }> {
    const enc = branch.split("/").map(encodeURIComponent).join("/");
    const refRes = await req(`${repoPath}/git/ref/heads/${enc}`);
    if (refRes.status === 404) throw new GitHubPlatformError(`branch not found: ${branch}`, 404);
    const headSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;
    const commitRes = await req(`${repoPath}/git/commits/${headSha}`, undefined, []);
    const baseTree = ((await commitRes.json()) as { tree: { sha: string } }).tree.sha;
    const treeRes = await req(`${repoPath}/git/trees/${baseTree}?recursive=1`, undefined, []);
    const tree = (await treeRes.json()) as { truncated: boolean; tree: { path: string; type: string }[] };
    if (tree.truncated) throw new GitHubPlatformError(`tree listing for ${branch} is truncated — refusing a blind delete`);
    const blobs = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
    return { headSha, baseTree, blobs };
  }

  return {
    async listBranches(): Promise<BranchRef[]> {
      const out: BranchRef[] = [];
      let complete = false;
      for (let page = 1; page <= 20; page++) {
        // allow: [] — a 404 (repo renamed / PAT lost access) must throw a GitHubPlatformError with
        // GitHub's message, not fall through and blow up as "rows is not iterable".
        const res = await req(`${repoPath}/branches?per_page=100&page=${page}`, undefined, []);
        const rows = (await res.json()) as { name: string; commit: { sha: string } }[];
        for (const b of rows) out.push({ name: b.name, sha: b.commit.sha });
        if (rows.length < 100) { complete = true; break; } // reached the last (partial) page
      }
      // Refuse a truncated enumeration (>2000 branches ⇒ page 20 was full). A caller that derives a
      // SAFETY set from this list — the registry reaper's referenced floor — must never act on a partial
      // branch list (a missed branch = an unprotected live pin). Mirror loadTree's truncation refusal.
      if (!complete) throw new GitHubPlatformError(`branch listing exceeded 2000 (20 pages of 100) — refusing a truncated enumeration`);
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    async compare(base: string, head: string): Promise<BranchComparison> {
      const res = await req(`${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      if (res.status === 404) throw new GitHubPlatformError(`branch not found comparing ${base}...${head}`, 404);
      const data = (await res.json()) as {
        ahead_by: number;
        behind_by: number;
        total_commits: number;
        files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
      };
      const files = data.files ?? [];
      return {
        aheadBy: data.ahead_by,
        behindBy: data.behind_by,
        files: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          ...(f.patch !== undefined ? { patch: f.patch } : {}),
        })),
        // GitHub caps the compare files list at 300; flag it so the UI never implies completeness.
        truncated: files.length >= 300,
      };
    },

    async deleteBranch(name: string): Promise<void> {
      assertSaneRef(name);
      // 204 = deleted; 404/422 = the ref is already gone — both fine (idempotent). Anything else
      // (e.g. 403 protected branch) throws via req with GitHub's message.
      await req(`${repoPath}/git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" }, [404, 422]);
    },

    async deletePaths(branch: string, paths: string[], message: string): Promise<{ removed: string[]; commitSha: string | null }> {
      assertSaneRef(branch);
      const { headSha, baseTree, blobs } = await loadTree(branch);
      const present = new Set(blobs);
      const removed = paths.filter((p) => present.has(p));
      if (removed.length === 0) return { removed, commitSha: null };
      const json = { "content-type": "application/json" };
      // sha:null per entry DELETES the path (documented git-data tree semantics).
      const newTreeRes = await req(`${repoPath}/git/trees`, {
        method: "POST", headers: json,
        body: JSON.stringify({ base_tree: baseTree, tree: removed.map((path) => ({ path, mode: "100644", type: "blob", sha: null })) }),
      }, []);
      const newTree = ((await newTreeRes.json()) as { sha: string }).sha;
      const newCommitRes = await req(`${repoPath}/git/commits`, {
        method: "POST", headers: json,
        body: JSON.stringify({ message, tree: newTree, parents: [headSha] }),
      }, []);
      const commitSha = ((await newCommitRes.json()) as { sha: string }).sha;
      // force:false ⇒ a concurrent push (non-fast-forward) makes this throw, never clobber.
      await req(`${repoPath}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        { method: "PATCH", headers: json, body: JSON.stringify({ sha: commitSha, force: false }) }, []);
      return { removed, commitSha };
    },

    async listBlobs(branch: string): Promise<string[]> {
      assertSaneRef(branch);
      return (await loadTree(branch)).blobs;
    },
  };
}
