// The real git adapter behind port.ts: all IO is argv-array execFile via git-exec.ts —
// no shell, and a credential can only travel through the askpass helper, never URL/argv/config.
//
//  - GitRepoReader clones a consumer repo into a fresh mkdtemp workdir (init + fetch + detached
//    checkout, so a branch, a tag, and a 40-char SHA all resolve) to resolve + pin the SHA and read
//    single files — the read credential stays Manager-side.
//  - GitPlatformRepo keeps one persistent worktree per branch under deps.workRoot: fetch +
//    hard-reset to origin/<branch>, then commit + push with a bounded pull-rebase retry (with an
//    opt-in exponential backoff — deps.pushBackoff — for the contended books branch in
//    catalog). It is also the only place a books branch is CREATED and the only place the trunk is
//    CARRIED INTO one, and only for the repository that opted in
//    (deps.carriesTrunkToBooksBranch). (The registrations path guard + write serializer live in the
//    domain.)
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { errValidation } from "../../kernel/errors.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import type { BranchScope, ClonedRepo, CommitInput, ConsumerRepo, ConsumerRepoSession, PlatformRepo, RepoReader } from "./port.ts";
import { runGit, withAskpass } from "./git-exec.ts";
import { listWorkdirDir, readWorkdirFile, safePath } from "./git-workdir.ts";

const SHA40 = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Where a fetch of the product branch is written in a worktree, and the ref the two acts that reach
 *  the trunk read it back from — creating the books branch at its head, and carrying it into one that
 *  already stands. A remote-tracking ref, so neither act can be confused with a local branch. */
const TRUNK = `refs/remotes/origin/${PRODUCT_BRANCH}`;

// Ref-name safety for a name that becomes part of a refspec: the same shape a branch must have, plus
// git's own two refusals (".." opens a range, ".lock" collides with the ref lock file).
function assertRefName(name: string, kind: string): void {
  if (!BRANCH_RE.test(name) || name.includes("..") || name.endsWith(".lock")) {
    throw errValidation(`invalid ${kind} name: "${name}"`);
  }
}

// https:// only in production (and never with userinfo — a credential belongs in the sealed store
// and reaches git through askpass, never on the URL). file:// is an explicit test-only opt-in for
// local fixture origins.
function assertRepoURL(repoURL: string, allowFileURLs: boolean | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(repoURL);
  } catch {
    throw errValidation(`repoURL is not a valid URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw errValidation("repoURL must not embed credentials — pass a credentialId instead");
  }
  if (parsed.protocol === "https:") return;
  if (allowFileURLs && parsed.protocol === "file:") return;
  throw errValidation(`repoURL must use https:// (got "${parsed.protocol}//")`);
}

export interface GitRepoReaderDeps {
  /** Opens a read credential's token bytes by id (the CredentialStore seam). Required iff clones pass a credentialId. */
  openCredential?: (credentialId: string) => Promise<Buffer>;
  /** Tests only: permit file:// origins. Production stays https://-only. */
  allowFileURLs?: boolean;
}

/** WHO THIS MANAGER COMMITS AS, wherever it writes into a repository of this platform. It is one
 *  identity and not one per call site: a reader looking at a branch has to be able to tell a
 *  commit this process made from one a person made, and two spellings of the same actor make that
 *  reading a guess. The branch regeneration a run drives is answered with these too, so what the
 *  machine writes on the manager's behalf carries the same name as what the manager writes itself. */
export const MANAGER_COMMITTER_NAME = 'hostyour-manager';
export const MANAGER_COMMITTER_EMAIL = 'manager@hostyour';

/** The two -c flags that make a commit or a tag this manager's, for whichever adapter is writing.
 *  One function and not one per class: two spellings of the same actor turn "did a person write this
 *  or did the manager?" into a guess for whoever reads the branch. */
function identity(deps: { committerName?: string; committerEmail?: string }): string[] {
  const name = deps.committerName ?? MANAGER_COMMITTER_NAME;
  const email = deps.committerEmail ?? MANAGER_COMMITTER_EMAIL;
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

export class GitRepoReader implements RepoReader {
  constructor(private readonly deps: GitRepoReaderDeps = {}) {}

  async cloneAtRef(input: { repoURL: string; ref: string; credentialId?: string; signal?: AbortSignal }): Promise<ClonedRepo> {
    const { repoURL, ref } = input;
    assertRepoURL(repoURL, this.deps.allowFileURLs);
    if (ref === "" || ref.startsWith("-")) throw errValidation(`invalid ref: "${ref}"`);
    const workdir = await mkdtemp(join(tmpdir(), "hostyour-clone-"));
    const run = (args: string[], env: Record<string, string>) =>
      runGit(args, { cwd: workdir, env, ...(input.signal ? { signal: input.signal } : {}) });
    try {
      await withAskpass(input.credentialId, this.deps.openCredential, async (env) => {
        await run(["init", "-q"], env);
        try {
          await run(["fetch", "-q", repoURL, ref], env);
          await run(["checkout", "-q", "--detach", "FETCH_HEAD"], env);
        } catch (e) {
          // Servers may refuse fetch-by-SHA (uploadpack.allowAnySHA1InWant off): fall back to
          // fetching all heads + tags, then check the SHA out of the fetched pack directly.
          if (!SHA40.test(ref)) throw e;
          await run(["fetch", "-q", repoURL, "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"], env);
          await run(["checkout", "-q", "--detach", ref], env);
        }
      });
      const resolvedSha = (await runGit(["rev-parse", "HEAD"], { cwd: workdir })).trim();
      if (!SHA40.test(resolvedSha)) throw errValidation(`git rev-parse returned a non-SHA: "${resolvedSha}"`);
      return { workdir, resolvedSha };
    } catch (e) {
      await rm(workdir, { recursive: true, force: true, maxRetries: 3 });
      throw e;
    }
  }

  async readFile(workdir: string, relPath: string): Promise<string | null> {
    return readWorkdirFile(workdir, relPath);
  }

  async listDir(workdir: string, relPath: string): Promise<string[]> {
    return listWorkdirDir(workdir, relPath);
  }

  async dispose(workdir: string): Promise<void> {
    const abs = resolve(workdir);
    const tmp = resolve(tmpdir());
    if (!abs.startsWith(tmp + sep)) throw errValidation(`refusing to remove a directory outside the OS temp dir`);
    await rm(abs, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Bounded exponential-backoff schedule for commitPush's push-reject retry loop. The consumer
 *  platform repo omits this and keeps the ORIGINAL behavior (3 retries, NO wait between them). The
 *  tenant repo (the books branch in catalog) opts in: many lifecycle runs plus Tekton's own deploy-bump
 *  commits contend on the ONE shared branch, so a re-fetch-and-rebase burst would thrash into a
 *  push-reject storm — spacing the retries with a growing, jittered wait turns the storm into
 *  ordered commits, capped by a retry budget after which the run fails loudly rather than spinning. */
export interface PushBackoff {
  /** Max rebase-retries after the first push (total push attempts = retries + 1). Default 3. */
  retries?: number;
  /** Base backoff, ms; the wait before retry N is baseDelayMs * 2^N (0 ⇒ no wait, the default). */
  baseDelayMs?: number;
  /** Upper bound on any single backoff wait, ms (0 ⇒ unbounded — only meaningful once base > 0). */
  maxDelayMs?: number;
}

const DEFAULT_PUSH_RETRIES = 3; // preserves the original commitPush loop (attempt >= 3 ⇒ throw)

/** Pure, deterministic base backoff for retry `attempt` (0-based): baseDelayMs * 2^attempt, capped
 *  at maxDelayMs when that is positive. Returns 0 when baseDelayMs is 0 (the default, no-wait path).
 *  Exported so the schedule is unit-tested without a live git; the caller adds full jitter on top. */
export function computeBackoffMs(attempt: number, opts: PushBackoff | undefined): number {
  const base = opts?.baseDelayMs ?? 0;
  if (base <= 0) return 0;
  const raw = base * 2 ** attempt;
  const max = opts?.maxDelayMs ?? 0;
  const capped = max > 0 ? Math.min(raw, max) : raw;
  return Number.isFinite(capped) ? capped : max > 0 ? max : base; // guard 2^attempt overflow → Infinity
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The turn queue keeps a settled-either-way tail per directory; it never inspects the outcome.
const NOOP = (): void => undefined;

export interface GitPlatformRepoDeps {
  platformRepoURL: string;
  /** The branch this installation's books stand on in THIS repository (port.ts, shared/branches.ts).
   *  Required, with no default: a default would be the trunk, and the trunk is the one branch the
   *  books may never touch. It is also the ONLY branch this adapter will ever create. */
  booksBranch: string;
  /** Is this adapter what brings `booksBranch` to the trunk — minting it at the trunk's head when
   *  origin does not carry it, and merging the trunk into it when it does (carryTrunkToBooksBranch)?
   *  The answer is a property of the REPOSITORY, not of the branch, and getting it wrong destroys a
   *  cluster — which is why it is required with no default and stated at both call sites
   *  (boot/wire-units.ts).
   *
   *  FALSE for hostyour-cloud: there the books branch IS the master cluster's install branch, which
   *  the deploy-branch program cuts, stamps and merges each release into — every ArgoCD revision
   *  retargeted onto it, the FQDN substituted for the placeholder, the other two stages pruned.
   *  Re-minting it from the trunk head, or merging the trunk into it here, would put the unstamped
   *  product back under a name the cluster's own ArgoCD tracks, and the whole cluster would
   *  re-render from it. Its absence is an operator-visible fault, so it is raised.
   *
   *  TRUE for catalog: nothing there cuts it and nothing there advances it. No installer, no
   *  stamper, and the tenant ApplicationSet generators read it, so without this the first tenant
   *  registration would fail on a ref that never comes into being — and every member Application
   *  reads its CHART off this branch too (hostyour-cloud clusters/argocd/files/tenants-appset.yaml),
   *  so a branch that never took the trunk in would freeze every tenant on the charts of the day it
   *  was born. */
  carriesTrunkToBooksBranch: boolean;
  /** Persistent base dir; one worktree per branch lives under it. */
  workRoot: string;
  /** Optional fetch/push credential, opened per use via openCredential (same askpass path as the reader). */
  credentialId?: string;
  openCredential?: (credentialId: string) => Promise<Buffer>;
  committerName?: string; // default MANAGER_COMMITTER_NAME
  committerEmail?: string; // default MANAGER_COMMITTER_EMAIL
  /** Opt-in push-reject backoff (tenant repo). Omitted ⇒ the original 3-retry, no-wait behavior. */
  pushBackoff?: PushBackoff;
  /** Tests only: permit a file:// platformRepoURL. */
  allowFileURLs?: boolean;
}

export class GitPlatformRepo implements PlatformRepo {
  constructor(private readonly deps: GitPlatformRepoDeps) {
    assertRefName(deps.booksBranch, "books branch");
    if (deps.booksBranch === PRODUCT_BRANCH) {
      throw errValidation(`the books branch may not be "${PRODUCT_BRANCH}" — the trunk carries the product, and this installation's registrations and cluster maps belong on the install branch of the cluster holding the master role`);
    }
  }

  get booksBranch(): string {
    return this.deps.booksBranch;
  }

  // Filesystem-safe per-branch dir: a readable slug plus a short hash so distinct branches
  // (e.g. "a/b" vs "a_b") can never collide on the sanitized name.
  private worktreeDir(branch: string): string {
    const slug = branch.replace(/[^A-Za-z0-9._-]/g, "_");
    const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
    return join(this.deps.workRoot, `${slug}-${hash}`);
  }

  private run(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
    return runGit(args, { cwd, ...(env ? { env } : {}) });
  }

  private withCred<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    return withAskpass(this.deps.credentialId, this.deps.openCredential, fn);
  }

  private async syncWorktree(dir: string, branch: string): Promise<void> {
    if (!existsSync(join(dir, ".git"))) {
      await mkdir(dir, { recursive: true });
      await this.run(dir, ["init", "-q"]);
      await this.run(dir, ["remote", "add", "origin", this.deps.platformRepoURL]);
    } else {
      await this.run(dir, ["remote", "set-url", "origin", this.deps.platformRepoURL]);
    }
    const track = `refs/remotes/origin/${branch}`;
    await this.withCred((env) => this.run(dir, ["fetch", "-q", "origin", `+refs/heads/${branch}:${track}`], env));
    await this.run(dir, ["checkout", "-q", "-f", "-B", branch, track]);
    await this.run(dir, ["reset", "-q", "--hard", track]);
    await this.run(dir, ["clean", "-qfd"]);
  }

  /** The product branch into TRUNK, so the two acts that reach it read a ref this checkout has. */
  private fetchTrunk(dir: string): Promise<string> {
    return this.withCred((env) => this.run(dir, ["fetch", "-q", "origin", `+refs/heads/${PRODUCT_BRANCH}:${TRUNK}`], env));
  }

  /** Does origin carry this branch? Asked only after a fetch already failed, so the extra round trip
   *  costs nothing on the normal path — and it is the ONE question that separates "the branch is not
   *  there yet" from a network, credential or repository failure, which must never be answered by
   *  creating a branch. */
  private async remoteHasBranch(dir: string, branch: string): Promise<boolean> {
    const out = await this.withCred((env) => this.run(dir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], env));
    return out.trim() !== "";
  }

  /**
   * CREATE the books branch on origin, at the trunk's head, by pushing a ref — no commit, no
   * worktree, nothing derived: the branch simply starts where the product stands and everything the
   * Manager writes onto it afterwards is a normal commit.
   *
   * This exists because in catalog NOTHING else creates it, which is exactly what
   * `deps.carriesTrunkToBooksBranch` states — see it for why the same call on hostyour-cloud must
   * raise instead. It is narrow twice over: only the repository that opted in, and within it only
   * `deps.booksBranch`, is ever created.
   *
   * A books branch that is WRONG rather than absent — MASTER_FQDN mistyped, or left standing after a
   * master replacement — is not distinguishable here from a first tenant registration, and it is not
   * meant to be: the same name is used against hostyour-cloud, where creation is off, so the first
   * consumer registration, cluster-map read or reset raises on it by name. What a typo can leave
   * behind in catalog is an unread branch, never a rewritten cluster.
   */
  private async createBooksBranch(dir: string, branch: string): Promise<void> {
    await this.fetchTrunk(dir);
    const head = (await this.run(dir, ["rev-parse", TRUNK])).trim();
    if (!SHA40.test(head)) throw errValidation(`git rev-parse ${TRUNK} returned a non-SHA: "${head}"`);
    try {
      await this.withCred((env) => this.run(dir, ["push", "-q", "origin", `${head}:refs/heads/${branch}`], env));
    } catch (e) {
      // Another process (or another run of this one) may have created it in between. That is the
      // outcome this call wanted, so adopt it; anything else — no push rights, a wedged remote — is
      // still an error, and one that must be loud rather than leave the books unwritable.
      if (!(await this.remoteHasBranch(dir, branch))) throw e;
    }
  }

  /**
   * BRING THE BOOKS BRANCH TO THE TRUNK — create it at the trunk's head where origin does not carry
   * it, and merge the trunk into it where it does. This is the whole of what
   * `deps.carriesTrunkToBooksBranch` claims, and it is the only path by which the product reaches
   * that branch.
   *
   * WHY A MERGE AND NOT A RESET. The branch holds what only this installation has: its tenant
   * registrations, and the per-chart image pins the release pipeline writes beside them. A reset to
   * the trunk would delete both. A merge keeps everything only the branch has, takes in everything
   * only the trunk has, and stops on exactly the overlaps with git naming the paths. That is the
   * shape the platform's own install branch is brought forward with, and it is why nothing here
   * resolves a conflict: only a person can say whether the branch's byte or the product's stands.
   *
   * WHY THIS IS AN ACT AND NOT PART OF EVERY TURN. Every read of the branch would otherwise be a
   * write, and the registry reaper walks it read-only to build the floor of tags it may not delete —
   * a floor standing on commits the reaper itself pushed measures nothing. So a caller runs this
   * (boot/wire.ts) and opening the branch never does.
   *
   * WHAT IT DOES NOT DO. It does not retry a rejected push. A writer that lands on the branch
   * between the merge and the push leaves the trunk uncarried until the next call, which is a branch
   * one product state behind and never a wrong one; the caller reports the failure and carries on.
   */
  async carryTrunkToBooksBranch(): Promise<void> {
    const branch = this.deps.booksBranch;
    if (!this.deps.carriesTrunkToBooksBranch) throw errValidation(`nothing may merge the trunk into "${branch}" on ${this.deps.platformRepoURL} — that books branch is the install branch of the cluster holding the master role, cut and stamped by the deploy-branch program, and the product reaches it by that program's own merge. A merge from here would publish the unstamped trunk under the name the cluster's own ArgoCD tracks.`);
    await this.withBranch(branch, async () => {
      // withBranch has already minted the branch where origin did not carry it and hard-reset this
      // directory to origin/<branch>. worktreeDir is a pure function of the branch name, so this is
      // that same directory, and the turn holds it for as long as this callback runs.
      const dir = this.worktreeDir(branch);
      await this.fetchTrunk(dir);
      // No "is it already carried?" question ahead of these two: git answers it itself. A merge with
      // nothing to bring in is "Already up to date" and exit 0, and the push that follows it is
      // "Everything up-to-date" and exit 0. Asking first would add a round trip and a second place
      // for the answer to be wrong.
      //
      // A CONFLICT IS NAMED BY ITS PATHS. git writes them on stdout and runGit reports a failure with
      // stderr, so the paths would otherwise reach the operator as "git -c failed" and nothing else —
      // a refusal nobody can act on. They are read back out of the index instead. The conflicted
      // worktree is left as it is: the next turn on this branch hard-resets it (resetToOrigin), and
      // nothing reads the directory outside a turn.
      try {
        await this.run(dir, [...identity(this.deps), "merge", "-q", "--no-edit", TRUNK]);
      } catch (e) {
        const clashing = (await this.run(dir, ["diff", "--name-only", "--diff-filter=U"])).trim().split("\n").filter(Boolean);
        if (clashing.length === 0) throw e;
        throw errValidation(`the trunk of ${this.deps.platformRepoURL} and this installation's books branch "${branch}" there both wrote ${clashing.join(", ")}, so the product cannot be carried into it. Only a person can say which of the two stands: settle those paths on the branch and the next carry goes through.`);
      }
      await this.withCred((env) => this.run(dir, ["push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`], env));
    });
  }

  /** The tail of the turn queue for one worktree directory, one entry per branch this process has
   *  touched. A turn chains onto the previous one and cannot start before it settles.
   *
   *  The stored tail SWALLOWS rejections while the returned promise does not: a turn that throws must
   *  reach its own caller as a throw, and must NOT reject the next turn, which has nothing to do with
   *  it. Chaining with the same callback on both settle paths (`prior.then(fn, fn)`) is what makes a
   *  failed turn release the directory rather than wedge it. */
  private readonly turns = new Map<string, Promise<unknown>>();

  async withBranch<T>(branch: string, fn: (scope: BranchScope) => Promise<T>): Promise<T> {
    assertRefName(branch, "branch");
    assertRepoURL(this.deps.platformRepoURL, this.deps.allowFileURLs);
    const dir = this.worktreeDir(branch);
    const prior = this.turns.get(dir) ?? Promise.resolve();
    const turn = prior.then(
      () => this.runTurn(branch, dir, fn),
      () => this.runTurn(branch, dir, fn),
    );
    this.turns.set(dir, turn.then(NOOP, NOOP));
    return turn;
  }

  private async runTurn<T>(branch: string, dir: string, fn: (scope: BranchScope) => Promise<T>): Promise<T> {
    const workdir = await this.resetToOrigin(branch, dir);
    // The scope is created here and nowhere else, so the directory it closes over is reachable only
    // for as long as this turn runs. A caller that keeps the object past the callback still cannot
    // interleave: the NEXT turn's reset is what it would race, and that turn has not started yet.
    const scope: BranchScope = {
      branch,
      readFile: (relPath) => readWorkdirFile(workdir, relPath),
      listDir: (relPath) => listWorkdirDir(workdir, relPath),
      commit: (input) => this.commitPushIn(workdir, branch, input),
      mintTag: (input) => this.mintTagIn(workdir, input),
    };
    return fn(scope);
  }

  private async resetToOrigin(branch: string, dir: string): Promise<string> {
    const existed = existsSync(join(dir, ".git"));
    try {
      await this.syncWorktree(dir, branch);
    } catch (e) {
      // A probe that cannot answer counts as "the branch is there": the original failure then
      // surfaces below, instead of being replaced by a second one from the probe itself.
      if (branch === this.deps.booksBranch && !(await this.remoteHasBranch(dir, branch).catch(() => true))) {
        if (!this.deps.carriesTrunkToBooksBranch) {
          // hostyour-cloud: an installer cuts this branch and a stamper specialises it, so its absence
          // is a fault to report and never a gap to fill — minting it here would publish the
          // unstamped trunk under the name the cluster's own ArgoCD tracks.
          throw errValidation(`this installation's books branch "${branch}" does not exist on ${this.deps.platformRepoURL} — it is the install branch of the cluster holding the master role, cut and stamped by the deploy-branch program, and nothing may re-create it from the trunk. Restore the branch (or correct MASTER_FQDN if it names the wrong cluster) and retry.`);
        }
        await this.createBooksBranch(dir, branch);
        await this.syncWorktree(dir, branch);
        return dir;
      }
      if (!existed) throw e;
      // Self-heal a wedged persistent worktree (crashed rebase, corrupt state): rebuild once.
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      await this.syncWorktree(dir, branch);
    }
    return dir;
  }

  private async commitPushIn(dir: string, branch: string, input: CommitInput): Promise<{ commit: string }> {
    const writes = input.write ?? [];
    // De-overlap write/remove: a path staged for BOTH (e.g. an offboard re-run where
    // fromPath === toPath) would git-add the identical bytes and then git-rm the same path, committing
    // a spurious DELETE that self-destructs the pointer. A written path always wins over a remove.
    const writePaths = new Set(writes.map((w) => w.path));
    const removes = (input.remove ?? []).filter((p) => !writePaths.has(p));
    for (const w of writes) {
      const abs = safePath(dir, w.path);
      if (abs === resolve(dir)) throw errValidation(`invalid write path: "${w.path}"`);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, w.content, "utf8");
    }
    if (writes.length > 0) await this.run(dir, ["add", "--", ...writes.map((w) => w.path)]);
    if (removes.length > 0) {
      for (const p of removes) safePath(dir, p);
      await this.run(dir, ["rm", "-q", "-r", "--ignore-unmatch", "--", ...removes]);
    }
    // No-op idempotency: fetchResetBranch hard-resets to origin, so re-running a step that already
    // landed (crash-resume, a same-value suspend flip, a redundant rewrite) stages bytes identical
    // to HEAD. A plain `git commit` would exit non-zero ("nothing to commit") and throw; instead detect
    // the empty staged diff and return the current HEAD — the prior attempt's SHA — keeping the { commit }
    // contract and making every registrations rewrite genuinely resume-safe.
    const staged = (await this.run(dir, ["diff", "--cached", "--name-only"])).trim();
    if (staged === "") {
      const head = (await this.run(dir, ["rev-parse", "HEAD"])).trim();
      if (!SHA40.test(head)) throw errValidation(`git rev-parse returned a non-SHA: "${head}"`);
      return { commit: head };
    }
    await this.run(dir, [...identity(this.deps), "commit", "-q", "-m", input.message]);
    const pushRefspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const maxRetries = this.deps.pushBackoff?.retries ?? DEFAULT_PUSH_RETRIES;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.withCred((env) => this.run(dir, ["push", "-q", "origin", pushRefspec], env));
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const nonFastForward = /non-fast-forward|fetch first|\[rejected\]|failed to push/i.test(msg);
        if (attempt >= maxRetries || !nonFastForward) throw e;
        // Bounded exponential backoff BEFORE the re-fetch/rebase: on a busy branch (catalog@
        // master) it spreads contending writers apart so they don't re-collide in lock-step. Full
        // jitter (a random point in [0, backoff]) further de-synchronizes them. Default schedule is
        // 0ms (the consumer repo), so this is a no-op there and the original semantics are preserved.
        const backoff = computeBackoffMs(attempt, this.deps.pushBackoff);
        if (backoff > 0) await sleep(Math.floor(Math.random() * backoff));
        try {
          await this.withCred((env) => this.run(dir, [...identity(this.deps), "pull", "-q", "--rebase", "origin", branch], env));
        } catch (rebaseErr) {
          await this.run(dir, ["rebase", "--abort"]).catch(() => undefined); // best-effort unwedge
          throw rebaseErr;
        }
      }
    }
    const commit = (await this.run(dir, ["rev-parse", "HEAD"])).trim();
    if (!SHA40.test(commit)) throw errValidation(`git rev-parse returned a non-SHA: "${commit}"`);
    return { commit };
  }

  private async mintTagIn(dir: string, input: { tag: string; message: string }): Promise<{ tag: string; commit: string; minted: boolean }> {
    assertRefName(input.tag, "tag");
    const ref = `refs/tags/${input.tag}`;
    // Mint-once is decided against the REMOTE, which is the only place a tag is published. The query
    // is a GLOB (`<ref>*`), because an exact ref pattern makes ls-remote print only the tag OBJECT
    // while the glob also prints its `^{}` dereference — and for an annotated tag it is the
    // dereference that names the commit. The two candidate refs are then matched exactly, so a
    // neighbouring tag the glob also caught cannot answer for this one.
    const rows = (await this.withCred((env) => this.run(dir, ["ls-remote", "origin", `${ref}*`], env)))
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f[1] === ref || f[1] === `${ref}^{}`);
    if (rows.length > 0) {
      const peeled = rows.find((f) => f[1] === `${ref}^{}`)?.[0];
      const commit = peeled ?? rows[0]?.[0];
      if (commit === undefined || !SHA40.test(commit)) throw errValidation(`git ls-remote returned no SHA for the existing tag ${input.tag}`);
      return { tag: input.tag, commit, minted: false };
    }
    const commit = (await this.run(dir, ["rev-parse", "HEAD"])).trim();
    if (!SHA40.test(commit)) throw errValidation(`git rev-parse returned a non-SHA: "${commit}"`);
    // A local tag left behind by an attempt that died between `tag` and `push` would make the create
    // fail; the remote has just been shown not to carry it, so the local one names nothing published.
    await this.run(dir, ["tag", "-d", input.tag]).catch(() => undefined);
    await this.run(dir, [...identity(this.deps), "tag", "-a", input.tag, "-m", input.message, commit]);
    await this.withCred((env) => this.run(dir, ["push", "origin", ref], env));
    return { tag: input.tag, commit, minted: true };
  }
}

// Parses the default-branch name out of `git ls-remote --symref <url> HEAD`, whose first line is
// `ref: refs/heads/<branch>\tHEAD`. Not anchored to line boundaries so a stray CR / extra line never
// defeats the match; the remote emits exactly one such symref line for HEAD.
const HEAD_SYMREF_RE = /ref:\s+refs\/heads\/(\S+)\s+HEAD/;

export interface GitConsumerRepoDeps {
  /** Opens the consumer repo's push credential's token bytes by id (the CredentialStore seam) — the
   *  SAME sealed one-PAT-per-consumer the reader clones with. Required: every consumer repo is private. */
  openCredential: (credentialId: string) => Promise<Buffer>;
  committerName?: string; // default MANAGER_COMMITTER_NAME
  committerEmail?: string; // default MANAGER_COMMITTER_EMAIL
  /** Tests only: permit file:// origins. Production stays https://-only. */
  allowFileURLs?: boolean;
}

/** Writes into a CONSUMER's OWN repo (the release-kit lifecycle). It borrows
 *  GitRepoReader's disposable-clone model (a fresh mkdtemp per open, init + fetch + checkout, disposed
 *  by the caller) and GitPlatformRepo's commit body (the write/remove de-overlap, the empty-staged-diff
 *  no-op, the non-fast-forward push retry) — but adds the ONE primitive neither has: resolving the
 *  consumer repo's own default branch from the remote HEAD symref (main/master/… is not known up
 *  front, unlike the platform repo whose branch the domain passes in). The credential travels ONLY
 *  through the askpass helper: never the URL (assertRepoURL forbids userinfo), argv, or config. */
export class GitConsumerRepo implements ConsumerRepo {
  constructor(private readonly deps: GitConsumerRepoDeps) {}

  async open(input: { repoURL: string; credentialId: string; signal?: AbortSignal }): Promise<ConsumerRepoSession> {
    const { repoURL, credentialId } = input;
    assertRepoURL(repoURL, this.deps.allowFileURLs);
    const workdir = await mkdtemp(join(tmpdir(), "hostyour-consumer-"));
    const run = (args: string[], env: Record<string, string>) =>
      runGit(args, { cwd: workdir, env, ...(input.signal ? { signal: input.signal } : {}) });
    try {
      const branch = await withAskpass(credentialId, this.deps.openCredential, async (env) => {
        // Resolve the remote's default branch (its HEAD symref) — never assume main vs master.
        const out = await run(["ls-remote", "--symref", repoURL, "HEAD"], env);
        const m = HEAD_SYMREF_RE.exec(out);
        if (!m?.[1]) throw errValidation(`could not resolve the default branch of ${repoURL} (git ls-remote --symref HEAD returned no "ref: refs/heads/<branch>")`);
        const resolved = m[1];
        assertRefName(resolved, "branch");
        await run(["init", "-q"], env);
        await run(["remote", "add", "origin", repoURL], env);
        await run(["fetch", "-q", "origin", resolved], env);
        // A named local branch (not detached HEAD): commit advances refs/heads/<branch>, which
        // commitPush pushes to the same-named remote ref, and rev-parse HEAD reads it for the no-op.
        await run(["checkout", "-q", "-B", resolved, "FETCH_HEAD"], env);
        return resolved;
      });
      return { workdir, branch };
    } catch (e) {
      await rm(workdir, { recursive: true, force: true, maxRetries: 3 });
      throw e;
    }
  }

  async readFile(workdir: string, relPath: string): Promise<string | null> {
    return readWorkdirFile(workdir, relPath);
  }

  async listDir(workdir: string, relPath: string): Promise<string[]> {
    return listWorkdirDir(workdir, relPath);
  }

  async commitPush(input: {
    workdir: string;
    branch: string;
    credentialId: string;
    message: string;
    write?: { path: string; content: string }[];
    remove?: string[];
    signal?: AbortSignal;
  }): Promise<{ commit: string; changed: boolean }> {
    assertRefName(input.branch, "branch");
    const dir = input.workdir;
    const run = (args: string[], env?: Record<string, string>) =>
      runGit(args, { cwd: dir, ...(env ? { env } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    const withCred = <T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> =>
      withAskpass(input.credentialId, this.deps.openCredential, fn);
    const writes = input.write ?? [];
    // A path staged for BOTH write + remove: the write wins (same de-overlap law as GitPlatformRepo).
    const writePaths = new Set(writes.map((w) => w.path));
    const removes = (input.remove ?? []).filter((p) => !writePaths.has(p));
    for (const w of writes) {
      const abs = safePath(dir, w.path);
      if (abs === resolve(dir)) throw errValidation(`invalid write path: "${w.path}"`);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, w.content, "utf8");
    }
    if (writes.length > 0) await run(["add", "--", ...writes.map((w) => w.path)]);
    if (removes.length > 0) {
      for (const p of removes) safePath(dir, p);
      await run(["rm", "-q", "-r", "--ignore-unmatch", "--", ...removes]);
    }
    // No-op idempotency (a crash-resume / a create-only re-run that finds everything present): a
    // byte-identical worktree stages nothing → return HEAD, no commit, no push, changed:false.
    const staged = (await run(["diff", "--cached", "--name-only"])).trim();
    if (staged === "") {
      const head = (await run(["rev-parse", "HEAD"])).trim();
      if (!SHA40.test(head)) throw errValidation(`git rev-parse returned a non-SHA: "${head}"`);
      return { commit: head, changed: false };
    }
    await run([...identity(this.deps), "commit", "-q", "-m", input.message]);
    const pushRefspec = `refs/heads/${input.branch}:refs/heads/${input.branch}`;
    // The consumer repo has no busy-branch contention, so it keeps the original 3-retry, no-wait push
    // loop. A push the credential is not authorized for (a PAT without contents:write) is NOT a
    // non-fast-forward, so it is re-thrown on the first attempt — fail-loud (git-exec fail() → UPSTREAM).
    for (let attempt = 0; ; attempt++) {
      try {
        await withCred((env) => run(["push", "-q", "origin", pushRefspec], env));
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const nonFastForward = /non-fast-forward|fetch first|\[rejected\]|failed to push/i.test(msg);
        if (attempt >= DEFAULT_PUSH_RETRIES || !nonFastForward) throw e;
        try {
          await withCred((env) => run([...identity(this.deps), "pull", "-q", "--rebase", "origin", input.branch], env));
        } catch (rebaseErr) {
          await run(["rebase", "--abort"]).catch(() => undefined); // best-effort unwedge
          throw rebaseErr;
        }
      }
    }
    const commit = (await run(["rev-parse", "HEAD"])).trim();
    if (!SHA40.test(commit)) throw errValidation(`git rev-parse returned a non-SHA: "${commit}"`);
    return { commit, changed: true };
  }

  async dispose(workdir: string): Promise<void> {
    const abs = resolve(workdir);
    const tmp = resolve(tmpdir());
    if (!abs.startsWith(tmp + sep)) throw errValidation(`refusing to remove a directory outside the OS temp dir`);
    await rm(abs, { recursive: true, force: true, maxRetries: 3 });
  }
}
