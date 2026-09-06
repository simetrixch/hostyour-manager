// The ONE branch GitPlatformRepo may create, and the one it may carry the trunk into: this
// installation's books branch, and only in the repository that opted in
// (git.ts carriesTrunkToBooksBranch). Real file:// fixture repos, no network and no credentials.
//
// It is its own file because these six tests are one subject and git.test.ts is the rest of the
// adapter; the fixtures both files use stand in testing/origin-fixture.ts.
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { GitPlatformRepo } from "./git.ts";
import { advanceTrunk, dropRoots, git, makeTrunkOnlyOrigin, newRoot } from "./testing/origin-fixture.ts";

const SLOW = 60_000;

afterEach(dropRoots);

describe("GitPlatformRepo, the books branch", () => {
  // The books branch of the installation under test: the FQDN of the cluster holding the master role.
  // The adapter refuses to be built on the trunk, so this is never "master".
  const BOOKS = "m1.example.com";

  // carriesTrunkToBooksBranch defaults to the tenant catalog's shape (nothing else cuts that branch
  // and nothing else advances it); the tests that need the hostyour-cloud shape say so.
  function makeRepo(originURL: string, carriesTrunkToBooksBranch = true): GitPlatformRepo {
    return new GitPlatformRepo({ platformRepoURL: originURL, booksBranch: BOOKS, carriesTrunkToBooksBranch, workRoot: join(newRoot(), "work"), allowFileURLs: true });
  }

  it(
    "CREATES the books branch from the trunk when the remote does not carry it yet, and only that one",
    async () => {
      // The tenant catalog has no installer and no stamper: nothing but this adapter ever creates the
      // branch its tenant registrations stand on. Without this, the first tenant registration of
      // every installation dies on a ref that is not there — and so does the ApplicationSet
      // generator that reads it.
      const { originDir, originURL, trunkSha } = makeTrunkOnlyOrigin();
      expect(git(originDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean)).toEqual(["master"]);

      const repo = makeRepo(originURL);
      const commit = await repo.withBranch(BOOKS, async (books) => {
        // Created at the trunk's head — no commit invented, and the product is simply there.
        expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(trunkSha);
        expect(await books.readFile("charts/Chart.yaml")).toBe("name: example-engine\n");

        // It is a normal branch afterwards: a registration commits and pushes onto it, and the trunk
        // does not move.
        return (
          await books.commit({
            message: "create-tenant(zsjs023ctne0): prod on s1 [run_1]",
            write: [{ path: "registrations/zsjs023ctne0/prod.yaml", content: 'cluster: "s1"\n' }],
          })
        ).commit;
      });
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(commit);
      expect(git(originDir, "rev-parse", "master").trim()).toBe(trunkSha);

      // A branch that is NOT the declared books branch is never minted, whatever asks for it: a
      // typo would otherwise fork the books into a branch no generator reads.
      await expect(repo.withBranch("s1.example.com", async () => undefined)).rejects.toThrow();
      expect(git(originDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort()).toEqual([BOOKS, "master"]);
    },
    SLOW,
  );

  it(
    "a turn that writes NOTHING still brings the books branch into being, and a second one moves nothing",
    async () => {
      // The branch has to exist before the first tenant, because the tenant ApplicationSet's git
      // generator reads it from the moment the installation is deployed and an unresolvable revision
      // puts the ApplicationSet — and the root Application above it — in error. Nothing is committed:
      // the branch simply starts where the product stands, and the generator then resolves to an
      // empty file list instead of failing.
      const { originDir, originURL, trunkSha } = makeTrunkOnlyOrigin();
      const repo = makeRepo(originURL);

      await repo.withBranch(repo.booksBranch, async () => undefined);
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(trunkSha);
      // One ref, not a commit: the branch must carry the trunk's own head, with nothing added.
      expect(git(originDir, "rev-list", "--count", BOOKS).trim()).toBe(git(originDir, "rev-list", "--count", "master").trim());

      // Every later turn: the branch is there, the sync succeeds, and nothing is created or moved.
      await repo.withBranch(repo.booksBranch, async () => undefined);
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(trunkSha);
      expect(git(originDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort()).toEqual([BOOKS, "master"]);
    },
    SLOW,
  );

  it(
    "REFUSES to create the books branch of a repository an installer cuts it in — the trunk is never published under its name",
    async () => {
      // hostyour-cloud's books branch IS the master cluster's install branch: the deploy-branch
      // program retargets every ArgoCD revision onto it, stamps the FQDN over the placeholder and
      // prunes the other two stages. Minting it from the trunk head would publish the unstamped
      // product under the name that cluster's own ArgoCD tracks, and the cluster would re-render from
      // it. So the absence is reported and the remote is left exactly as it was, whether the caller
      // asked for the branch by name or took the empty turn boot takes.
      const { originDir, originURL } = makeTrunkOnlyOrigin();
      const repo = makeRepo(originURL, false);
      await expect(repo.withBranch(BOOKS, async () => undefined)).rejects.toThrow(/does not exist.*deploy-branch program/s);
      expect(git(originDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean)).toEqual(["master"]);
    },
    SLOW,
  );

  it(
    "CARRIES the trunk into a books branch that already stands, keeping what only that branch has",
    async () => {
      // THE ACT BOOT RUNS (boot/wire.ts). The member charts a tenant Application renders stand on this
      // branch, at the same revision as the pins beside them, so a branch that never took the trunk in
      // would freeze every tenant on the charts of the day it was born. What it may never do is take
      // the branch's OWN bytes with it: the tenant registrations and the release pipeline's image pins
      // stand there and nothing else holds a copy.
      const { originDir, originURL, seed, trunkSha } = makeTrunkOnlyOrigin();
      const repo = makeRepo(originURL);

      await repo.carryTrunkToBooksBranch();
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(trunkSha);

      await repo.withBranch(BOOKS, (books) =>
        books.commit({
          message: "create-tenant(zsjs023ctne0): prod on s1 [run_1]",
          write: [{ path: "registrations/zsjs023ctne0/prod.yaml", content: 'cluster: "s1"\n' }],
        }));
      const grown = advanceTrunk(seed, "example-report");

      await repo.carryTrunkToBooksBranch();
      await repo.withBranch(BOOKS, async (books) => {
        expect(await books.readFile("charts/example-report.yaml")).toBe("name: example-report\n"); // the trunk came in
        expect(await books.readFile("registrations/zsjs023ctne0/prod.yaml")).toBe('cluster: "s1"\n'); // the books stayed
      });
      // The trunk itself is untouched, and the branch now contains it.
      expect(git(originDir, "rev-parse", "master").trim()).toBe(grown);
      expect(() => git(originDir, "merge-base", "--is-ancestor", grown, BOOKS)).not.toThrow();

      // Idempotent: a second carry with nothing new on the trunk moves the branch nowhere.
      const carried = git(originDir, "rev-parse", BOOKS).trim();
      await repo.carryTrunkToBooksBranch();
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(carried);
    },
    SLOW,
  );

  it(
    "STOPS on a conflict between the trunk and the books branch, and leaves the remote where it was",
    async () => {
      // A merge resolves nothing on its own: a file the trunk and this installation both wrote is a
      // question only a person can answer, and picking a side here would silently drop one of the two.
      // git names the path and the push never happens.
      const { originDir, originURL, seed } = makeTrunkOnlyOrigin();
      const repo = makeRepo(originURL);
      await repo.carryTrunkToBooksBranch();
      await repo.withBranch(BOOKS, (books) =>
        books.commit({ message: "the installation writes it [run_1]", write: [{ path: "charts/clash.yaml", content: "name: ours\n" }] }));
      const standing = git(originDir, "rev-parse", BOOKS).trim();
      advanceTrunk(seed, "clash"); // the trunk writes the same path with other bytes

      await expect(repo.carryTrunkToBooksBranch()).rejects.toThrow(/clash\.yaml/);
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(standing);
    },
    SLOW,
  );

  it(
    "REFUSES to carry the trunk into the books branch of a repository the deploy-branch program brings forward",
    async () => {
      // The same reason creation is refused there: that branch is the master cluster's stamped install
      // branch, the release reaches it by that program's own merge, and a merge from here would
      // publish the unstamped trunk under the name the cluster's own ArgoCD tracks.
      const { originDir, originURL, seed } = makeTrunkOnlyOrigin();
      git(seed, "push", "-q", "origin", `master:refs/heads/${BOOKS}`); // the branch stands, so nothing is missing
      const repo = makeRepo(originURL, false);
      await expect(repo.carryTrunkToBooksBranch()).rejects.toThrow(/deploy-branch program/);
      expect(git(originDir, "rev-parse", BOOKS).trim()).toBe(git(originDir, "rev-parse", "master").trim());
    },
    SLOW,
  );

  it("refuses to be built with the trunk as its books branch — the books never stand on the product branch", () => {
    expect(() => new GitPlatformRepo({ platformRepoURL: "https://github.com/x/y.git", booksBranch: "master", carriesTrunkToBooksBranch: true, workRoot: newRoot() }))
      .toThrow(/may not be "master"/);
  });
});
