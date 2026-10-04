import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitPlatformRepo } from "./git.ts";
import { readWorkdirFileCommit } from "./git-file-commit.ts";
import { FakePlatformRepo } from "./testing/fake.ts";
import { dropRoots, git, makeOrigin, newRoot } from "./testing/origin-fixture.ts";

afterEach(dropRoots);

describe("the last writer of a current Git file", () => {
  it("reads the exact file's owner after unrelated writes and removes ownership on deletion", async () => {
    const { originURL } = makeOrigin();
    const repo = new GitPlatformRepo({ platformRepoURL: originURL, booksBranch: "m1.example.com", carriesTrunkToBooksBranch: true, workRoot: join(newRoot(), "work"), allowFileURLs: true });
    const path = "registrations/literal[1]/build.yaml";
    const first = await repo.withBranch("main", scope => scope.commit({ message: "register: original [run_a]", write: [{ path, content: "original\n" }] }));
    await repo.withBranch("main", scope => scope.commit({ message: "unrelated [run_b]", write: [{ path: "registrations/literal1/build.yaml", content: "another\n" }] }));
    expect(await repo.withReadBranch("main", scope => scope.readFileCommit(path))).toEqual({ commit: first.commit, message: "register: original [run_a]" });
    const changed = await repo.withBranch("main", scope => scope.commit({ message: "register: replacement [run_b]", write: [{ path, content: "replacement\n" }] }));
    expect(await repo.withReadBranch("main", scope => scope.readFileCommit(path))).toEqual({ commit: changed.commit, message: "register: replacement [run_b]" });
    await repo.withBranch("main", scope => scope.commit({ message: "remove [run_b]", remove: [path] }));
    expect(await repo.withReadBranch("main", scope => scope.readFileCommit(path))).toBeNull();
  }, 60_000);

  it("has no owner for an untracked file and refuses paths outside the worktree", async () => {
    const { seed } = makeOrigin();
    writeFileSync(join(seed, "untracked.yaml"), "untracked\n");
    expect(await readWorkdirFileCommit(seed, "untracked.yaml")).toBeNull();
    expect(await readWorkdirFileCommit(seed, "missing.yaml")).toBeNull();
    await expect(readWorkdirFileCommit(seed, "../outside.yaml")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(git(seed, "status", "--porcelain")).toContain("untracked.yaml");
  });

  it("keeps fake per-file ownership across unrelated and identical writes", async () => {
    const repo = new FakePlatformRepo();
    const branch = repo.booksBranch;
    const path = "registrations/acme/build.yaml";
    repo.seed(branch, path, "foreign\n");
    expect(await repo.withBranch(branch, scope => scope.readFileCommit(path))).toBeNull();
    const own = await repo.withBranch(branch, scope => scope.commit({ message: "register [run_a]", write: [{ path, content: "own\n" }] }));
    await repo.withBranch(branch, scope => scope.commit({ message: "unrelated [run_b]", write: [{ path: "other.yaml", content: "other\n" }, { path, content: "own\n" }] }));
    expect(await repo.withBranch(branch, scope => scope.readFileCommit(path))).toEqual({ commit: own.commit, message: "register [run_a]" });
    await repo.withBranch(branch, scope => scope.commit({ message: "remove [run_a]", remove: [path] }));
    expect(await repo.withBranch(branch, scope => scope.readFileCommit(path))).toBeNull();
  });
});
