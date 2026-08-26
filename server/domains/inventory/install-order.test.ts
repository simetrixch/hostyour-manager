import { describe, it, expect } from "vitest";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { readInstallOrder, holdsInstallOrder, INSTALL_ORDER_PATH, INSTALL_ORDER_BRANCH } from "./install-order.ts";

// The order an installation's programs run in has ONE carrier and it is not in this repository: the
// platform repo's trunk. What these tests hold down is that this module READS that declaration and
// states nothing of its own, and that holding a run's programs against it can actually go red — a
// comparison that always agrees is the same thing as no comparison at all.

/** WHERE THE PLATFORM REPOSITORY REALLY CARRIES THE FILE, as a literal and never as the constant
 *  under test. Seeding the fake from INSTALL_ORDER_PATH makes the fixture agree with the reader
 *  whatever that repository holds — the exact shape that let the engine pin go on naming a file
 *  nobody had at `platform/versions.yaml` for a whole rename. */
const ORDER_FILE_ON_THE_PLATFORM_REPO = "clusters/platform/install-order.yaml";

/** The master sequence as the declaration states it, in the order it states it. */
const MASTER = ["deploy-host", "deploy-branch", "deploy-cluster", "deploy-platform-services", "onboard-manager"];

const DECLARATION = [
  "engine: /usr/local/bin/ansiwise",
  "elevated: true",
  "sequence:",
  "  master:",
  ...MASTER.flatMap((p) => [`    - program: ${p}`, "      needs: []"]),
  "",
].join("\n");

function repoWith(text: string | null): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  if (text !== null) repo.seed(INSTALL_ORDER_BRANCH, ORDER_FILE_ON_THE_PLATFORM_REPO, text);
  return repo;
}

describe("readInstallOrder", () => {
  it("looks where the platform repository actually carries the file", () => {
    expect(INSTALL_ORDER_PATH).toBe(ORDER_FILE_ON_THE_PLATFORM_REPO);
  });

  it("serves the stated order off the trunk, in the order the file states it", async () => {
    expect(await readInstallOrder(repoWith(DECLARATION))).toEqual(MASTER);
  });

  it("fails loud when the file is not there at all, naming the file and the branch", async () => {
    await expect(readInstallOrder(repoWith(null)))
      .rejects.toThrow(/clusters\/platform\/install-order\.yaml on the platform repo's master branch/);
  });

  it("fails loud on a file that states no readable sequence — an order nothing can read states nothing", async () => {
    await expect(readInstallOrder(repoWith("engine: /usr/local/bin/ansiwise\n"))).rejects.toThrow(/no readable sequence/);
    await expect(readInstallOrder(repoWith("sequence:\n  master: []\n"))).rejects.toThrow(/no readable sequence/);
    await expect(readInstallOrder(repoWith("sequence:\n  master:\n    - needs: []\n"))).rejects.toThrow(/no readable sequence/);
  });

  it("names the roles the file DOES state when the one asked for is absent", async () => {
    await expect(readInstallOrder(repoWith(DECLARATION), "slave")).rejects.toThrow(/states no sequence for the role "slave".*master/s);
  });
});

describe("holdsInstallOrder", () => {
  it("agrees when the run drives a SUBSET of the stated programs in the stated order", () => {
    // A slave runs three of the master's five. The question is the order of what they share, never
    // whether the two lists are equal.
    const v = holdsInstallOrder(["deploy-host", "deploy-cluster", "deploy-platform-services"], MASTER);
    expect(v.agrees).toBe(true);
    expect(v.held).toEqual(["deploy-host", "deploy-cluster", "deploy-platform-services"]);
    expect(v.unstated).toEqual([]);
    expect(v.detail).toBeNull();
  });

  it("NAMES a program the declaration does not state, and still agrees about the rest", () => {
    // The declaration states no slave sequence on purpose, so the master-side branch cut is expected
    // to be unstated. A verdict that hid it would let the whole set drift and still read green.
    const v = holdsInstallOrder(["deploy-slave-branch", "deploy-host", "deploy-cluster"], MASTER);
    expect(v.agrees).toBe(true);
    expect(v.unstated).toEqual(["deploy-slave-branch"]);
    expect(v.held).toEqual(["deploy-host", "deploy-cluster"]);
  });

  it("DISAGREES when the run drives two shared programs the other way round, and says which after which", () => {
    const v = holdsInstallOrder(["deploy-platform-services", "deploy-cluster"], MASTER);
    expect(v.agrees).toBe(false);
    expect(v.detail).toContain("deploy-cluster after deploy-platform-services");
    expect(v.detail).toContain(MASTER.join(" -> ")); // both orders named, so either side can be the wrong one
  });

  it("DISAGREES when the same program is driven twice — a repeat is out of the stated order too", () => {
    expect(holdsInstallOrder(["deploy-host", "deploy-host"], MASTER).agrees).toBe(false);
  });

  it("agrees vacuously ONLY when nothing is shared, and says so by naming everything as unstated", () => {
    // The one shape a caller must not read as a pass: the run and the declaration have nothing in
    // common. It is not a disagreement, and the caller is what decides whether it is worth anything —
    // which is why `held` is a count it can look at rather than a hidden zero.
    const v = holdsInstallOrder(["something-else"], MASTER);
    expect(v.agrees).toBe(true);
    expect(v.held).toEqual([]);
    expect(v.unstated).toEqual(["something-else"]);
  });
});
