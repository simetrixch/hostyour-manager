// Real integration tests for the concrete git adapter (git.ts): local file:// fixture repos
// only — no network, no clusters, no credentials (the askpass path needs a token store and is
// covered by the VALIDATION guard test here plus the domain fakes elsewhere).
//
// The books branch — the one branch this adapter creates and carries the trunk into — is its own
// subject, in git-books-branch.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeBackoffMs, GitConsumerRepo, GitPlatformRepo, GitRepoReader, type PushBackoff } from "./git.ts";
import { pathToFileURL } from "node:url";
import { commitAll, dropRoots, git, makeOrigin, newRoot } from "./testing/origin-fixture.ts";

const SLOW = 60_000;

afterEach(dropRoots);

describe("GitRepoReader", () => {
  const reader = new GitRepoReader({ allowFileURLs: true });

  it(
    "clones a branch, resolves the SHA, and reads files",
    async () => {
      const { originURL, sha } = makeOrigin();
      const { workdir, resolvedSha } = await reader.cloneAtRef({ repoURL: originURL, ref: "main" });
      try {
        expect(resolvedSha).toBe(sha);
        expect(await reader.readFile(workdir, "deploy/platform.yaml")).toBe("kind: ConsumerManifest\n");
        expect(await reader.readFile(workdir, "no/such/file.txt")).toBeNull();
        await expect(reader.readFile(workdir, "../outside.txt")).rejects.toMatchObject({ code: "VALIDATION" });
        await expect(reader.readFile(workdir, "/outside.txt")).rejects.toMatchObject({ code: "VALIDATION" });
      } finally {
        await reader.dispose(workdir);
      }
      expect(existsSync(workdir)).toBe(false);
    },
    SLOW,
  );

  it(
    "clones a tag and a 40-char SHA to the same commit",
    async () => {
      const { originURL, seed, sha } = makeOrigin();
      git(seed, "tag", "v1");
      git(seed, "push", "-q", "origin", "v1");
      const byTag = await reader.cloneAtRef({ repoURL: originURL, ref: "v1" });
      expect(byTag.resolvedSha).toBe(sha);
      await reader.dispose(byTag.workdir);
      const bySha = await reader.cloneAtRef({ repoURL: originURL, ref: sha });
      expect(bySha.resolvedSha).toBe(sha);
      await reader.dispose(bySha.workdir);
    },
    SLOW,
  );

  it("refuses bad URLs, a credentialId without an opener, and disposing outside the temp dir", async () => {
    const { originURL } = makeOrigin();
    await expect(reader.cloneAtRef({ repoURL: "http://example.com/x.git", ref: "main" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reader.cloneAtRef({ repoURL: "https://user:tok@example.com/x.git", ref: "main" })).rejects.toMatchObject({ code: "VALIDATION" });
    const strict = new GitRepoReader(); // no file:// opt-in → production default
    await expect(strict.cloneAtRef({ repoURL: originURL, ref: "main" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reader.cloneAtRef({ repoURL: originURL, ref: "main", credentialId: "cred_1" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reader.dispose(join("D:\\", "no-such-dir-far-outside-tmp"))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("GitPlatformRepo", () => {
  // The books branch of the installation under test: the FQDN of the cluster holding the master role.
  // The adapter refuses to be built on the trunk, so this is never "master".
  const BOOKS = "m1.example.com";

  // The branch this adapter may create and carry the trunk into is its own subject, in
  // git-books-branch.test.ts; here it is on, because that is the shape the tenant catalog is built in.
  function makeRepo(originURL: string): GitPlatformRepo {
    return new GitPlatformRepo({ platformRepoURL: originURL, booksBranch: BOOKS, carriesTrunkToBooksBranch: true, workRoot: join(newRoot(), "work"), allowFileURLs: true });
  }

  it(
    "a turn round-trips read + commit; a fresh worktree root sees the pushed commit",
    async () => {
      const { originDir, originURL, sha } = makeOrigin();
      const repo = makeRepo(originURL);
      const commit = await repo.withBranch("main", async (main) => {
        expect(await main.readFile("hello.txt")).toBe("hello platform\n");
        return (
          await main.commit({
            message: "onboard(acme): pin aaaaaaa [run_1]",
            write: [{ path: "consumers/prod/active/acme.yaml", content: "name: acme\n" }],
          })
        ).commit;
      });
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(commit).not.toBe(sha);
      expect(git(originDir, "rev-parse", "main").trim()).toBe(commit); // the push really landed
      const fresh = makeRepo(originURL);
      expect(await fresh.withBranch("main", (main) => main.readFile("consumers/prod/active/acme.yaml"))).toBe("name: acme\n");
    },
    SLOW,
  );

  it(
    "mints an annotated tag ONCE: a tag the remote already carries is reused, never re-pointed",
    async () => {
      // Mint-once is the half of the release grammar nothing else can enforce: once a tag names a
      // state, moving it makes every pin that quotes it name a different state than it did.
      const { originDir, originURL } = makeOrigin();
      const repo = makeRepo(originURL);
      const first = await repo.withBranch("main", (main) =>
        main.mintTag({ tag: "1.0.0-stable-20260728120000", message: "platform release 1.0.0-stable-20260728120000" }),
      );
      expect(first.minted).toBe(true);
      expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
      // ANNOTATED, not lightweight: the tag resolves to a tag OBJECT carrying the message.
      expect(git(originDir, "cat-file", "-t", "1.0.0-stable-20260728120000").trim()).toBe("tag");
      expect(git(originDir, "cat-file", "-p", "1.0.0-stable-20260728120000")).toContain("platform release 1.0.0-stable");

      // Master moves on, and a second mint of the SAME tag adopts the standing one — the tag keeps
      // naming the commit it was minted at, not the new head.
      const again = await repo.withBranch("main", async (main) => {
        await main.commit({ message: "later work", write: [{ path: "later.txt", content: "x\n" }] });
        return main.mintTag({ tag: "1.0.0-stable-20260728120000", message: "platform release (retry)" });
      });
      expect(again.minted).toBe(false);
      expect(again.commit).toBe(first.commit);
      expect(git(originDir, "rev-list", "-n", "1", "1.0.0-stable-20260728120000").trim()).toBe(first.commit);

      // A ref name that could smuggle a refspec is refused before any git call.
      await expect(repo.withBranch("main", (main) => main.mintTag({ tag: "../evil", message: "m" }))).rejects.toThrow(/invalid tag name/);
    },
    SLOW,
  );

  it(
    "is no-op idempotent: re-committing byte-identical content returns HEAD without a 'nothing to commit' throw",
    async () => {
      // Guards the resume-cascade-delete bug: fetchResetBranch hard-resets to origin, so a replayed
      // write-pointer step stages bytes identical to HEAD; a plain `git commit` would exit non-zero and
      // throw, which (via abort-with-cleanup) could git-rm a freshly deployed live stack.
      const { originDir, originURL } = makeOrigin();
      const repo = makeRepo(originURL);
      const write = [{ path: "tenants/dev/zsjs023ctne0/tenant.yaml", content: 'guid: "zsjs023ctne0"\n' }];
      const first = await repo.withBranch("main", (main) => main.commit({ message: "create-tenant [run_1]", write }));
      // Re-run the SAME write on a fresh checkout (a crash-resume): no staged change => return HEAD, no throw.
      const rerun = makeRepo(originURL);
      const second = await rerun.withBranch("main", (main) => main.commit({ message: "create-tenant [run_1]", write }));
      expect(second.commit).toBe(first.commit); // same SHA, the prior attempt's commit
      expect(git(originDir, "rev-parse", "main").trim()).toBe(first.commit); // origin did not advance
    },
    SLOW,
  );

  it(
    "rebase-retries a non-fast-forward push so both writers land",
    async () => {
      const { originDir, originURL, seed } = makeOrigin();
      const repo = makeRepo(originURL);
      const commit = await repo.withBranch("main", async (main) => {
        // A concurrent writer lands first, making our push non-fast-forward.
        writeFileSync(join(seed, "other.txt"), "other\n");
        commitAll(seed, "concurrent");
        git(seed, "push", "-q", "origin", "main");
        return (await main.commit({ message: "mine [run_2]", write: [{ path: "mine.txt", content: "mine\n" }] })).commit;
      });
      expect(git(originDir, "rev-parse", "main").trim()).toBe(commit);
      await repo.withBranch("main", async (main) => {
        expect(await main.readFile("other.txt")).toBe("other\n");
        expect(await main.readFile("mine.txt")).toBe("mine\n");
      });
    },
    SLOW,
  );

  it(
    "serializes turns on ONE worktree: a read cannot land inside a write and swallow it",
    async () => {
      // THE defect this port shape exists to remove. Both callers of a branch share one persistent
      // worktree directory (worktreeDir keys on the branch name), and a turn ends with fetch +
      // `reset --hard` + `clean -qfd`. Without exclusive turns, a read starting between a
      // writer's `git add` and its `diff --cached` wipes the staged index; commitPush then reads the
      // empty diff as "a previous attempt already landed this" and returns the PRE-WRITE HEAD as a
      // valid-looking commit SHA. The write is gone and the run reports success.
      //
      // Driven against a real origin, ten times, because the failure is a race and a single
      // pass could miss it. Removing the queue from withBranch turns this test red every run: the
      // two turns tear the same directory apart, and what surfaces first depends on timing — a
      // staged index lost behind a successful-looking SHA, or git itself failing on a worktree the
      // other turn is rebuilding. The assertions below hold the property, not one symptom of losing
      // it: the commit is not the pre-write HEAD, origin carries it, and the file is really there.
      const { originDir, originURL } = makeOrigin();
      const repo = makeRepo(originURL);
      const head = (): string => git(originDir, "rev-parse", "main").trim();

      // Warm the worktree first. On a COLD directory the two turns collide in `git init` and the
      // run dies there — a real symptom, but not the one this test is about. The reported failure
      // needs an existing worktree, where the reader's reset lands on the writer's staged index.
      await repo.withBranch("main", (main) => main.readFile("hello.txt"));

      for (let i = 0; i < 10; i++) {
        const path = `registrations/acme/prod-${i}.yaml`;
        const before = head();
        const [written] = await Promise.all([
          repo.withBranch("main", (main) =>
            main.commit({ message: `write ${i} [run_${i}]`, write: [{ path, content: `n: ${i}
` }] }),
          ),
          // The unlocked reader: GET /api/consumers/detected reaches the same
          // worktree with no run lock (domains/units/api.ts -> registrations.listConsumerRegistrations).
          repo.withBranch("main", (main) => main.listDir("registrations")),
        ]);

        expect(written.commit).not.toBe(before); // not the pre-write HEAD
        expect(head()).toBe(written.commit); // and origin really carries it
        expect(await repo.withBranch("main", (main) => main.readFile(path))).toBe(`n: ${i}
`);
      }
    },
    SLOW,
  );

  it(
    "removes paths (absent ones ignored) and refuses traversal/.git writes and bad branches",
    async () => {
      const { originURL } = makeOrigin();
      const repo = makeRepo(originURL);
      await repo.withBranch("main", (main) =>
        main.commit({ message: "offboard(acme) [run_3]", remove: ["hello.txt", "never-existed.txt"] }),
      );
      expect(await repo.withBranch("main", (main) => main.readFile("hello.txt"))).toBeNull();
      const bad = (over: { write?: { path: string; content: string }[]; remove?: string[]; branch?: string }) =>
        repo.withBranch(over.branch ?? "main", (main) => main.commit({ message: "x [run_4]", ...over }));
      await expect(bad({ write: [{ path: "../evil.txt", content: "x" }] })).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(bad({ write: [{ path: ".git/config", content: "x" }] })).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(bad({ remove: ["../evil.txt"] })).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(bad({ branch: "-evil" })).rejects.toMatchObject({ code: "VALIDATION" });
    },
    SLOW,
  );
});

describe("GitConsumerRepo", () => {
  // file:// origins need no auth, but the port opens a credential unconditionally — hand back a
  // fixed single-line token the askpass helper materializes (git never invokes it for file://).
  const openCredential = () => Promise.resolve(Buffer.from("unused-file-origin-token", "utf8"));
  const makeConsumer = () => new GitConsumerRepo({ openCredential, allowFileURLs: true });

  /** A bare file:// origin with a CHOSEN default branch (to prove branch resolution is not hardcoded
   *  to main), seeded with one file so open() has a tree to check out. */
  function makeConsumerOrigin(branch: string): { originDir: string; originURL: string } {
    const root = newRoot();
    git(root, "init", "-q", "--bare", "-b", branch, "origin.git");
    const originDir = join(root, "origin.git");
    git(root, "init", "-q", "-b", branch, "seed");
    const seed = join(root, "seed");
    writeFileSync(join(seed, "hello.txt"), "hi\n");
    commitAll(seed, "c1");
    git(seed, "remote", "add", "origin", originDir);
    git(seed, "push", "-q", "origin", branch);
    return { originDir, originURL: pathToFileURL(originDir).href };
  }

  it(
    "resolves the default branch (not hardcoded main), create-only writes, is empty-diff no-op, and removes",
    async () => {
      const { originDir, originURL } = makeConsumerOrigin("master"); // default branch is master, not main
      const path = "release/release.sh";
      const body = "#!/usr/bin/env bash\necho release\n";

      // open() resolves the remote HEAD symref → master, and a create-only write lands + pushes.
      const repo = makeConsumer();
      const s = await repo.open({ repoURL: originURL, credentialId: "cred_x" });
      let firstCommit: string;
      try {
        expect(s.branch).toBe("master");
        expect(await repo.readFile(s.workdir, path)).toBeNull(); // absent → the file to inject
        const first = await repo.commitPush({ workdir: s.workdir, branch: s.branch, credentialId: "cred_x", message: "add release-kit [run_1]", write: [{ path, content: body }] });
        expect(first.changed).toBe(true);
        expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(git(originDir, "rev-parse", "master").trim()).toBe(first.commit); // the push really landed
        firstCommit = first.commit;
      } finally {
        await repo.dispose(s.workdir);
      }

      // Empty-diff no-op: a fresh clone re-committing byte-identical content stages nothing →
      // changed:false, returns HEAD, and origin does NOT advance (the re-onboard create-only path).
      const repo2 = makeConsumer();
      const s2 = await repo2.open({ repoURL: originURL, credentialId: "cred_x" });
      try {
        const noop = await repo2.commitPush({ workdir: s2.workdir, branch: s2.branch, credentialId: "cred_x", message: "again [run_2]", write: [{ path, content: body }] });
        expect(noop.changed).toBe(false);
        expect(noop.commit).toBe(firstCommit);
        expect(git(originDir, "rev-parse", "master").trim()).toBe(firstCommit); // origin unchanged
      } finally {
        await repo2.dispose(s2.workdir);
      }

      // remove: git-rm the file → it is gone on origin (the offboard/purge teardown).
      const repo3 = makeConsumer();
      const s3 = await repo3.open({ repoURL: originURL, credentialId: "cred_x" });
      try {
        const rem = await repo3.commitPush({ workdir: s3.workdir, branch: s3.branch, credentialId: "cred_x", message: "rm release-kit [run_3]", remove: [path] });
        expect(rem.changed).toBe(true);
      } finally {
        await repo3.dispose(s3.workdir);
      }
      const verify = makeConsumer();
      const s4 = await verify.open({ repoURL: originURL, credentialId: "cred_x" });
      try {
        expect(await verify.readFile(s4.workdir, path)).toBeNull(); // reaped
      } finally {
        await verify.dispose(s4.workdir);
      }
    },
    SLOW,
  );

  it("refuses a non-file:// origin in the production (no file:// opt-in) default", async () => {
    const strict = new GitConsumerRepo({ openCredential }); // no allowFileURLs → https-only
    const { originURL } = makeConsumerOrigin("main");
    await expect(strict.open({ repoURL: originURL, credentialId: "cred_x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

// The push-reject backoff schedule is pure logic in the git adapter — the
// commitPush retry loop that consumes it shells out to a live git, so the deterministic base delay is
// unit-tested here and the loop is exercised by the higher-level onboarding integration tests.
describe("computeBackoffMs (GitPlatformRepo push-reject backoff)", () => {
  it("is 0 when no backoff is configured (the consumer repo keeps the original no-wait behavior)", () => {
    expect(computeBackoffMs(0, undefined)).toBe(0);
    expect(computeBackoffMs(3, undefined)).toBe(0);
    expect(computeBackoffMs(0, {})).toBe(0);
    expect(computeBackoffMs(2, { retries: 6 })).toBe(0); // retries set, base still 0 ⇒ no wait
  });

  it("is 0 when baseDelayMs is not positive", () => {
    expect(computeBackoffMs(2, { baseDelayMs: 0 })).toBe(0);
    expect(computeBackoffMs(2, { baseDelayMs: -100 })).toBe(0);
  });

  it("grows as baseDelayMs * 2^attempt", () => {
    const opts: PushBackoff = { baseDelayMs: 250 };
    expect(computeBackoffMs(0, opts)).toBe(250);
    expect(computeBackoffMs(1, opts)).toBe(500);
    expect(computeBackoffMs(2, opts)).toBe(1000);
    expect(computeBackoffMs(3, opts)).toBe(2000);
  });

  it("caps the wait at maxDelayMs once the exponential exceeds it", () => {
    const opts: PushBackoff = { baseDelayMs: 250, maxDelayMs: 8_000 };
    expect(computeBackoffMs(5, opts)).toBe(8_000); // 250*32 = 8000, exactly the cap
    expect(computeBackoffMs(6, opts)).toBe(8_000); // 250*64 = 16000, clamped
    expect(computeBackoffMs(20, opts)).toBe(8_000);
  });

  it("is unbounded when maxDelayMs is absent or 0", () => {
    expect(computeBackoffMs(4, { baseDelayMs: 100 })).toBe(1_600);
    expect(computeBackoffMs(4, { baseDelayMs: 100, maxDelayMs: 0 })).toBe(1_600);
  });

  it("degrades gracefully on a huge attempt (2^attempt overflow to Infinity)", () => {
    expect(computeBackoffMs(2000, { baseDelayMs: 250, maxDelayMs: 8_000 })).toBe(8_000);
    // With no cap, an overflowing exponential falls back to the base delay rather than Infinity.
    expect(computeBackoffMs(2000, { baseDelayMs: 250 })).toBe(250);
  });
});
