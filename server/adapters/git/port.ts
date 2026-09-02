// The Manager's git ports. Two roles, one boundary:
//
//  - RepoReader  — clones a (possibly private) CONSUMER repo Manager-side to resolve + pin the
//    requested ref to a 40-char SHA (the gate PipelineRun clones the repo itself at that pin).
//    credentialId opens a read credential from the store per use (it never rides a URL).
//  - PlatformRepo — the Manager's ONLY writer of the platform repo's consumers/** (the
//    Registrations backend): fetch/reset a branch worktree, then commit + push. The path
//    guard + serializer law live in the domain (registrations.ts), not here.
//
// The concrete impl shells out to git (an adapter may import IO libs); the fakes are in-memory.

export interface ClonedRepo {
  workdir: string; // a disposable checkout directory
  resolvedSha: string; // the 40-char SHA `ref` resolved to
}

export interface RepoReader {
  cloneAtRef(input: { repoURL: string; ref: string; credentialId?: string; signal?: AbortSignal }): Promise<ClonedRepo>;
  readFile(workdir: string, relPath: string): Promise<string | null>;
  /** List the immediate entry names (files + subdirs) directly under `relPath`, or [] when the
   *  directory is absent. The generic directory primitive the tenant app-type catalog reads
   *  (charts/example-engine/values-<app>.yaml — app-catalog.ts): the name filtering/exclusion logic
   *  lives in the domain, never here — this stays a dumb, non-recursive git/fs read (boundary). */
  listDir(workdir: string, relPath: string): Promise<string[]>;
  dispose(workdir: string): Promise<void>;
}

export interface CommitInput {
  message: string; // ends with the [<runId>] trailer, authored by the domain
  write?: { path: string; content: string }[]; // files to write + stage
  remove?: string[]; // paths to git rm
}

/** ONE TURN of exclusive use of a branch's worktree, handed to the callback of
 *  PlatformRepo.withBranch and valid only for its duration.
 *
 *  Every operation is BOUND to the directory the turn holds, and the directory's path is not among
 *  them. That is the whole point. A port handing back a bare `workdir` string from
 *  `fetchResetBranch`, which the caller then passes to readFile/listDir/commitPush/mintTag, is a
 *  shared, mutable directory owned by nobody. Two callers can hold it at once, and the reader's
 *  `reset --hard` + `clean -qfd` wipes the writer's staged index between its `git add` and its
 *  `diff --cached`; commitPush then reads the empty diff as "a previous attempt already did this" and
 *  returns the PRE-WRITE HEAD as a valid-looking commit SHA. Reproduced at 10 iterations: five lost
 *  the registration outright, five returned a SHA that was not their commit, and the run reported
 *  success either way.
 *
 *  With the path gone, "use the worktree outside my turn" stops being something a caller can write
 *  down. The exclusion is not a rule a comment asks for and a review has to notice; it is the shape
 *  of the interface. */
export interface BranchScope {
  /** The branch this turn holds — for messages and assertions, never to re-enter with. */
  readonly branch: string;
  readFile(relPath: string): Promise<string | null>;
  /** List the immediate entry names (files + subdirs) directly under `relPath`, or [] when the
   *  directory is absent. Same non-recursive, absent-is-empty contract as RepoReader.listDir — the
   *  tenant subdomain scan (create-tenant idempotent-by-subdomain) enumerates the registrations/*
   *  guid dirs from it. */
  listDir(relPath: string): Promise<string[]>;
  /** Serialize the writes, commit, and push with rebase-retry; returns the new commit SHA. */
  commit(input: CommitInput): Promise<{ commit: string }>;
  /** Mint an ANNOTATED tag at the worktree's current HEAD and push it. MINT-ONCE: a tag the remote
   *  already carries is never re-pointed — the call reports `minted:false` and the commit the standing
   *  tag names, so a resumed run adopts its own earlier tag instead of moving a released one onto new
   *  code. The grammar of a tag NAME is the domain's business, not this port's; only ref-name safety
   *  is enforced here. */
  mintTag(input: { tag: string; message: string }): Promise<{ tag: string; commit: string; minted: boolean }>;
}

export interface PlatformRepo {
  /** The branch THIS installation keeps its books on IN THIS REPOSITORY (shared/branches.ts): the
   *  cluster maps and consumer registrations in hostyour-cloud, the tenant registrations in
   *  catalog. Resolved ONCE where the ports are built (boot/wire-units.ts) from the FQDN of
   *  the cluster holding the master role, and bound to the instance rather than passed per call, so
   *  the branch a domain writes to and the branch this adapter may CREATE are the same one statement.
   *  Never `master`: the trunk carries the product, and a registration on it belongs to no
   *  installation and to every one at once. */
  readonly booksBranch: string;
  /** Take one exclusive turn on `branch`: fetch origin, hard-reset the worktree to origin/<branch>,
   *  and run `fn` against it. Turns on ONE branch run one at a time, in call order — a read can no
   *  longer land inside a write's staging, and a reader that walks many files sees one consistent
   *  state for the whole walk. Turns on DIFFERENT branches do not wait for each other.
   *
   *  The turn ends when `fn` settles, however it settles; a throw releases it like a return, and the
   *  next turn runs whatever the previous one did. The scope is dead afterwards.
   *
   *  A branch the remote does not carry is an error — EXCEPT `booksBranch`, which is created from the
   *  trunk on first use (the books are data this process owns; see GitPlatformRepo). */
  withBranch<T>(branch: string, fn: (scope: BranchScope) => Promise<T>): Promise<T>;
}

/** A disposable checkout of a CONSUMER repo's default branch (ConsumerRepo.open). Unlike PlatformRepo
 *  — which owns ONE platform repo whose branch is passed in — the consumer repo is a DIFFERENT repo
 *  per consumer, and its default branch (main vs master vs …) is not known up front, so open resolves
 *  and returns it for commitPush to push back to. */
export interface ConsumerRepoSession {
  workdir: string; // a disposable checkout directory (dispose after use)
  branch: string; // the resolved default branch (main/master/…) — the ref commitPush pushes to
}

/** The Manager's writer of a CONSUMER's OWN repo: the release-kit lifecycle
 *  (onboard commits release/ + the workflow into the consumer repo, offboard/purge git-rm's them).
 *  Distinct from PlatformRepo — that owns the ONE platform repo (a persistent per-branch worktree);
 *  this clones an arbitrary consumer repo fresh per call (RepoReader's disposable-clone model) and
 *  resolves its default branch. The credential is opened by the adapter (askpass) from the
 *  credentialId per call — the domain never handles the raw token, exactly like RepoReader.cloneAtRef. */
export interface ConsumerRepo {
  /** Clone the consumer repo's default branch into a fresh disposable workdir; resolve + return the
   *  default branch. The credentialId opens the (private-repo) push credential per use. */
  open(input: { repoURL: string; credentialId: string; signal?: AbortSignal }): Promise<ConsumerRepoSession>;
  readFile(workdir: string, relPath: string): Promise<string | null>;
  /** List the immediate entry names directly under `relPath`, or [] when the directory is absent —
   *  the same non-recursive contract as RepoReader.listDir. The release-kit replace derives its
   *  stale-file delete list from it (everything under release/ the current asset set no longer
   *  carries). */
  listDir(workdir: string, relPath: string): Promise<string[]>;
  /** Stage the writes/removes on `branch`, commit, and push to refs/heads/<branch>. A byte-identical
   *  worktree (nothing staged) is a no-op: no commit, no push, `changed:false` + the current HEAD. A
   *  push the credential is not authorized for (a PAT without contents:write) fails LOUD (UPSTREAM). */
  commitPush(input: {
    workdir: string;
    branch: string;
    credentialId: string;
    message: string;
    write?: { path: string; content: string }[];
    remove?: string[];
    signal?: AbortSignal;
  }): Promise<{ commit: string; changed: boolean }>;
  dispose(workdir: string): Promise<void>;
}
