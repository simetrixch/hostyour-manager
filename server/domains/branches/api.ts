import type { Hono } from "hono";
import type { Db } from "../../db/client.ts";
import type { Config } from "../../kernel/config.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { GitHubPlatform, BranchComparison } from "../../adapters/github-platform/github-platform-http.ts";
import { GitHubPlatformError } from "../../adapters/github-platform/github-platform-http.ts";
import { errNotFound, errNotConfigured, errUpstream } from "../../kernel/errors.ts";
import { masterFqdn } from "../inventory/read.ts";
import type { BranchKind, BranchView, BranchesView, BranchDiffView, BranchDiffFileView, BranchCompareSummary } from "../../../shared/api-types.ts";

export interface BranchApiDeps {
  db: Db;
  config: Config;
  /** Absent ⇒ GITHUB_REPO/GITHUB_WRITE_PAT are unset — every route answers 501 (honest, loud). */
  github?: GitHubPlatform;
}

/** How many compares run at once against GitHub (list endpoint). Small enough to be a polite
 *  API citizen, large enough that a dozen install branches load in ~2 round-trips. */
const COMPARE_CONCURRENCY = 6;
/** Compare-summary cache bound. Entries are immutable (keyed by both shas) — eviction only
 *  bounds memory across many pushes, it can never serve a stale diff. */
const COMPARE_CACHE_MAX = 500;
/** Drop a per-file patch above this size from the diff payload (keep the counts). A single
 *  generated-file diff can be MBs — the UI shows an honest "patch too large" line instead. */
const MAX_PATCH_BYTES = 100_000;

/** Classify a branch name against the master's FQDN — pure derivation, nothing typed.
 *  "slave" requires exactly one extra DNS label on the master's base domain
 *  (s1.example.com for master m1.example.com). */
export function classifyBranch(name: string, masterHost: string): BranchKind {
  if (name === "master") return "master";
  if (name === masterHost) return "manager";
  const dot = masterHost.indexOf(".");
  if (dot === -1) return "other"; // no base domain derivable (bare-hostname dev setups)
  const suffix = masterHost.slice(dot); // ".example.com"
  if (name.endsWith(suffix)) {
    const label = name.slice(0, -suffix.length);
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) return "slave";
  }
  return "other";
}

/** The GitHub client + the "owner/repo" it targets, or 501 if the feature is unconfigured.
 *  config.github is the single source for the repo string (no `?? ""` guess). */
function requireGitHub(deps: BranchApiDeps): { gh: GitHubPlatform; repo: string } {
  if (!deps.github || !deps.config.github) {
    throw errNotConfigured("GitHub access is not configured — set GITHUB_REPO and GITHUB_WRITE_PAT to enable the Branches view");
  }
  return { gh: deps.github, repo: `${deps.config.github.owner}/${deps.config.github.repo}` };
}

function requireMasterFqdn(deps: BranchApiDeps): string {
  const fqdn = masterFqdn(deps.db) ?? deps.config.master?.fqdn;
  if (!fqdn) {
    throw errNotConfigured("branch classification needs the master's FQDN — no role=master server is registered and MASTER_FQDN is not set");
  }
  return fqdn;
}

/** GitHub failures must surface with GitHub's own reason (the global error shape redacts
 *  non-AppErrors to a blank 500) — 404 stays 404, everything else becomes UPSTREAM 502. */
function rethrowGitHub(e: unknown, notFoundMessage: string): never {
  if (e instanceof GitHubPlatformError) {
    if (e.status === 404) throw errNotFound(notFoundMessage);
    throw errUpstream(e.message);
  }
  throw e;
}

/** Bounded-concurrency map (order-preserving). */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

/** Strip oversized patches; pass counts + status through unchanged. */
function capPatches(files: BranchComparison["files"]): BranchDiffFileView[] {
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    ...(f.patch !== undefined && f.patch.length <= MAX_PATCH_BYTES ? { patch: f.patch } : {}),
  }));
}

/**
 * Read-only Branches API. GET-only (no CSRF surface); auth via the protected chokepoint.
 * The N+1 (one compare per installer branch) is kept acceptable three ways: only installer
 * branches are compared (master/other never), compares run COMPARE_CONCURRENCY-wide, and
 * summaries are cached by (masterSha, branchSha) — immutable, so a warm list costs exactly
 * one listBranches call until someone pushes.
 */
export function registerBranchRoutes(app: Hono<AppEnv>, deps: BranchApiDeps): void {
  // Per-wire cache (tests get a fresh one per app). Key `${masterSha}:${branchSha}`.
  const compareCache = new Map<string, BranchCompareSummary>();

  app.get("/api/branches", async (c) => {
    const { gh, repo } = requireGitHub(deps);
    const fqdn = requireMasterFqdn(deps);
    const refs = await gh.listBranches().catch((e: unknown) => rethrowGitHub(e, "repository not found"));
    const masterRef = refs.find((r) => r.name === "master");
    if (!masterRef) throw errNotFound('the GitOps repo has no "master" branch — nothing to diff install branches against');

    const views = await mapLimit(refs, COMPARE_CONCURRENCY, async (ref): Promise<BranchView | null> => {
      const kind = classifyBranch(ref.name, fqdn);
      if (kind === "master" || kind === "other") return { name: ref.name, sha: ref.sha, kind };
      const key = `${masterRef.sha}:${ref.sha}`;
      let summary = compareCache.get(key);
      if (!summary) {
        let cmp: BranchComparison | undefined;
        try {
          cmp = await gh.compare("master", ref.name);
        } catch (e) {
          // Deleted between list and compare — it no longer exists; drop it from the view.
          if (e instanceof GitHubPlatformError && e.status === 404) return null;
          rethrowGitHub(e, ref.name);
        }
        summary = { aheadBy: cmp.aheadBy, behindBy: cmp.behindBy, changedFiles: cmp.files.length, truncated: cmp.truncated };
        if (compareCache.size >= COMPARE_CACHE_MAX) {
          const oldest = compareCache.keys().next().value;
          if (oldest !== undefined) compareCache.delete(oldest);
        }
        compareCache.set(key, summary);
      }
      return { name: ref.name, sha: ref.sha, kind, compare: summary };
    });

    const body: BranchesView = { repo, branches: views.filter((v): v is BranchView => v !== null) };
    return c.json(body);
  });

  app.get("/api/branches/:name/diff", async (c) => {
    const { gh } = requireGitHub(deps);
    const fqdn = requireMasterFqdn(deps);
    const name = c.req.param("name");
    try {
      const cmp = await gh.compare("master", name);
      const body: BranchDiffView = {
        name,
        kind: classifyBranch(name, fqdn),
        aheadBy: cmp.aheadBy,
        behindBy: cmp.behindBy,
        files: capPatches(cmp.files),
        truncated: cmp.truncated,
      };
      return c.json(body);
    } catch (e) {
      rethrowGitHub(e, `branch ${name} not found`);
    }
  });
}
