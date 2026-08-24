// In-memory git fakes for the onboarding domain tests — no real git, no network. FakeRepoReader
// serves a scripted consumer repo (SHA, files); FakePlatformRepo records every commit and
// keeps a branch<->files map so a test can assert the exact pointer/report writes; FakeConsumerRepo
// (the release-kit writer) keeps a per-repoURL file map + a commit recorder.
import { errNotFound } from "../../../kernel/errors.ts";
import type { RepoReader, ClonedRepo, PlatformRepo, BranchScope, CommitInput, ConsumerRepo, ConsumerRepoSession } from "../port.ts";

/** The scripted content a FakeRepoReader serves for a single clone (the resolved SHA + the files). */
export interface FakeRepoReaderScript {
  resolvedSha?: string;
  files?: Record<string, string>;
}

export class FakeRepoReader implements RepoReader {
  readonly clones: { repoURL: string; ref: string; credentialId?: string }[] = [];

  constructor(private scripted: FakeRepoReaderScript = {}) {}

  setScript(scripted: FakeRepoReaderScript): void {
    this.scripted = scripted;
  }

  async cloneAtRef(input: { repoURL: string; ref: string; credentialId?: string }): Promise<ClonedRepo> {
    this.clones.push({
      repoURL: input.repoURL,
      ref: input.ref,
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    });
    return { workdir: `/fake/${input.ref}`, resolvedSha: this.scripted.resolvedSha ?? "f".repeat(40) };
  }

  async readFile(_workdir: string, relPath: string): Promise<string | null> {
    return this.scripted.files?.[relPath] ?? null;
  }

  // Immediate children of relPath, DERIVED from the scripted files map (no extra script surface): every
  // file whose path sits under "<relPath>/" contributes its next path segment. Mirrors the real reader's
  // non-recursive listing (dir names appear once) and its absent-is-empty contract.
  async listDir(_workdir: string, relPath: string): Promise<string[]> {
    const prefix = `${relPath.replace(/\/+$/, "")}/`;
    const names = new Set<string>();
    for (const p of Object.keys(this.scripted.files ?? {})) {
      if (!p.startsWith(prefix)) continue;
      const seg = p.slice(prefix.length).split("/")[0];
      if (seg) names.add(seg);
    }
    return [...names];
  }

  async dispose(_workdir: string): Promise<void> {}
}

/** The books branch every fake carries unless a test names another one. A real installation's value —
 *  the FQDN of the cluster holding the master role — and deliberately NOT "master": a fake that put
 *  the books on the trunk would let exactly the defect this branch model exists to remove pass every
 *  test in the suite. Tests seed and assert against `repo.booksBranch`, never a literal. */
export const FAKE_BOOKS_BRANCH = "m1.example.com";

// The turn queue keeps a settled-either-way tail per branch; it never inspects the outcome.
const NOOP = (): void => undefined;

export class FakePlatformRepo implements PlatformRepo {
  /** Every commit taken through a turn, with the branch the turn held — the branch left CommitInput
   *  when it moved onto the scope, and a test that asserts WHICH branch a write landed on still needs it. */
  readonly commits: (CommitInput & { branch: string })[] = [];
  /** tag -> the commit it names. Mint-once lives here, exactly as it lives on the real remote. */
  readonly tags = new Map<string, string>();
  readonly booksBranch: string;
  // "branch\0path" -> content
  private readonly store = new Map<string, string>();
  private seq = 0;

  constructor(opts: { booksBranch?: string } = {}) {
    this.booksBranch = opts.booksBranch ?? FAKE_BOOKS_BRANCH;
  }

  /** Seed a file that already exists on a branch (e.g. a prior committed report). */
  seed(branch: string, path: string, content: string): void {
    this.store.set(`${branch}\0${path}`, content);
  }

  /** seed's mirror, for a test that asserts what a run LEFT on a branch. Deliberately not a port
   *  method: peeking at the store is a test's business, and going through withBranch to do it would
   *  make an assertion queue behind the very turns it is asserting about. */
  read(branch: string, path: string): string | null {
    return this.store.get(`${branch}\0${path}`) ?? null;
  }

  // Every install branch carries the cluster values chain, so the fake materializes it the first
  // time a branch is touched — a test that needs different values seeds over it. Without this the
  // chain read that precedes every gate run would find nothing and fail on a branch the test never
  // meant to be incomplete.
  // Turns are serialized per branch here too, so a domain test sees the same ordering guarantee the
  // real adapter gives. Without it a fake would let two turns interleave that production cannot, and
  // a test could pass on behavior the running system never produces.
  private readonly turns = new Map<string, Promise<unknown>>();

  async withBranch<T>(branch: string, fn: (scope: BranchScope) => Promise<T>): Promise<T> {
    const prior = this.turns.get(branch) ?? Promise.resolve();
    const turn = prior.then(() => this.runTurn(branch, fn), () => this.runTurn(branch, fn));
    this.turns.set(branch, turn.then(NOOP, NOOP));
    return turn;
  }

  // Every install branch carries the cluster values chain, so the fake materializes it the first
  // time a branch is touched — a test that needs different values seeds over it. Without this the
  // chain read that precedes every gate run would find nothing and fail on a branch the test never
  // meant to be incomplete.
  private async runTurn<T>(branch: string, fn: (scope: BranchScope) => Promise<T>): Promise<T> {
    if (!this.store.has(`${branch}\0platform/values-common.yaml`)) {
      this.seed(branch, "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
      for (const stage of ["dev", "test", "prod"]) {
        this.seed(branch, `platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
      }
      // unitApex rides along because it is not optional to a caller: the admission policy pins the
      // unit's ONE host to <name>.<unitApex>, so a chain without it fails the plan on a branch the
      // test never meant to be incomplete. Each branch gets its OWN apex, which is what a unit
      // standing at two stages requires — provision-dns refuses a second stage whose host another
      // cluster's address already answers (domains/onboarding/unit-dns.ts). A real install may well
      // give two clusters one apex, so a test that wants THAT world seeds installation/profile.yaml itself.
      this.seed(branch, "installation/profile.yaml", `global:\n  unitApex: ${branch}\n  endpoints:\n    vault:\n      url: https://vault.${branch}:8200\n`);
    }
    return fn({
      branch,
      readFile: async (relPath) => this.store.get(`${branch}\0${relPath}`) ?? null,
      // Immediate children of relPath on this branch, DERIVED from the seeded/committed store keys
      // (no extra script surface): every path under "<relPath>/" contributes its next segment.
      // Mirrors the real reader's non-recursive listing + absent-is-empty contract.
      listDir: async (relPath) => {
        const prefix = `${relPath.replace(/\/+$/, "")}/`;
        const names = new Set<string>();
        for (const key of this.store.keys()) {
          if (!key.startsWith(`${branch}\0`)) continue;
          const path = key.slice(branch.length + 1);
          if (!path.startsWith(prefix)) continue;
          const seg = path.slice(prefix.length).split("/")[0];
          if (seg) names.add(seg);
        }
        return [...names];
      },
      commit: async (input) => {
        for (const w of input.write ?? []) this.store.set(`${branch}\0${w.path}`, w.content);
        for (const p of input.remove ?? []) this.store.delete(`${branch}\0${p}`);
        this.commits.push({ ...input, branch });
        return { commit: `commit_${++this.seq}` };
      },
      mintTag: async (input) => {
        const standing = this.tags.get(input.tag);
        if (standing !== undefined) return { tag: input.tag, commit: standing, minted: false };
        const commit = `commit_${++this.seq}`;
        this.tags.set(input.tag, commit);
        return { tag: input.tag, commit, minted: true };
      },
    });
  }
}

/** A recorded consumer-repo commitPush (the release-kit writer). */
export interface FakeConsumerRepoCommit {
  repoURL: string;
  branch: string;
  message: string;
  write?: { path: string; content: string }[];
  remove?: string[];
}

/** In-memory ConsumerRepo fake (the release-kit writer) — spiegelt FakePlatformRepo:
 *  a per-repoURL file map (so a test can pre-seed a divergent, consumer-edited file with seed()), a
 *  commit recorder (so a test can assert onboard committed exactly the absent paths / offboard removed
 *  the three), and a throw mode (failOpen/failCommit) to simulate a PAT without contents:write — a
 *  fail-CLOSED onboard abort, a fail-SOFT teardown warning. It does NOT open credentials (the real
 *  adapter does, via askpass); it just records the credentialId it was handed. */
export class FakeConsumerRepo implements ConsumerRepo {
  readonly opened: { repoURL: string; credentialId: string }[] = [];
  readonly commits: FakeConsumerRepoCommit[] = [];
  // "repoURL\0path" -> content
  private readonly store = new Map<string, string>();
  private readonly branch: string;
  private openError: Error | null = null;
  private commitError: Error | null = null;
  private seq = 0;

  constructor(opts: { branch?: string } = {}) {
    this.branch = opts.branch ?? "main";
  }

  /** Pre-seed a file already present on a repo (e.g. a divergent, consumer-edited release.yml). */
  seed(repoURL: string, path: string, content: string): void {
    this.store.set(`${repoURL}\0${path}`, content);
  }

  /** Simulate a repo the writer cannot clone (a revoked PAT): open throws. */
  failOpen(err: Error): void {
    this.openError = err;
  }

  /** Simulate a PAT without contents:write: commitPush throws (fail-closed onboard / fail-soft teardown). */
  failCommit(err: Error): void {
    this.commitError = err;
  }

  /** The files currently present on a repo (test assertion helper). */
  filesFor(repoURL: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.store) {
      if (!k.startsWith(`${repoURL}\0`)) continue;
      out[k.slice(repoURL.length + 1)] = v;
    }
    return out;
  }

  private repoOf(workdir: string): string {
    return decodeURIComponent(workdir.slice("/fake-consumer/".length));
  }

  async open(input: { repoURL: string; credentialId: string; signal?: AbortSignal }): Promise<ConsumerRepoSession> {
    if (this.openError) throw this.openError;
    this.opened.push({ repoURL: input.repoURL, credentialId: input.credentialId });
    return { workdir: `/fake-consumer/${encodeURIComponent(input.repoURL)}`, branch: this.branch };
  }

  async readFile(workdir: string, relPath: string): Promise<string | null> {
    return this.store.get(`${this.repoOf(workdir)}\0${relPath}`) ?? null;
  }

  async listDir(workdir: string, relPath: string): Promise<string[]> {
    // The same non-recursive, absent-is-empty contract as the real adapter: the immediate entry
    // names under relPath, files and subdirs alike, each name once.
    const repo = this.repoOf(workdir);
    const prefix = `${repo}\0${relPath.replace(/\/$/, "")}/`;
    const names = new Set<string>();
    for (const k of this.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const first = rest.split("/")[0];
      if (first) names.add(first);
    }
    return [...names];
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
    if (this.commitError) throw this.commitError;
    if (!input.workdir.startsWith("/fake-consumer/")) throw errNotFound(`unknown worktree ${input.workdir}`);
    const repoURL = this.repoOf(input.workdir);
    // A written path always wins over a remove of the same path (the real adapter's de-overlap law).
    const writePaths = new Set((input.write ?? []).map((w) => w.path));
    let changed = false;
    for (const w of input.write ?? []) {
      const key = `${repoURL}\0${w.path}`;
      if (this.store.get(key) !== w.content) {
        this.store.set(key, w.content);
        changed = true;
      }
    }
    for (const p of input.remove ?? []) {
      if (writePaths.has(p)) continue;
      const key = `${repoURL}\0${p}`;
      if (this.store.has(key)) {
        this.store.delete(key);
        changed = true;
      }
      // The real adapter removes with `git rm -r`, so a directory path takes its files with it.
      for (const k of [...this.store.keys()]) {
        if (k.startsWith(`${key}/`) && !writePaths.has(k.slice(repoURL.length + 1))) {
          this.store.delete(k);
          changed = true;
        }
      }
    }
    this.commits.push({
      repoURL,
      branch: input.branch,
      message: input.message,
      ...(input.write ? { write: input.write } : {}),
      ...(input.remove ? { remove: input.remove } : {}),
    });
    // Byte-identical worktree ⇒ no-op: the current HEAD, changed:false (the empty-staged-diff contract).
    return changed ? { commit: `commit_${++this.seq}`, changed: true } : { commit: `head_${this.seq}`, changed: false };
  }

  async dispose(_workdir: string): Promise<void> {}
}
