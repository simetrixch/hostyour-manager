import { describe, it, expect } from "vitest";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { clusterMapPath, clusterValueChainPaths, splitAtChartValues } from "../../../shared/cluster-values.ts";
import { readClusterValueChain } from "./cluster-value-chain.ts";

const DOMAIN = "s1.example";

describe("the chain's paths", () => {
  // SPELLED OUT, on purpose. These three are the `$values` entries of the ApplicationSets that
  // deploy a gated unit, and `$values` resolves to the install branch. Nothing in this repository
  // can read the other side, so the only thing that can hold the spelling is a literal here: a
  // rename then has to be made twice, deliberately, instead of once and silently. The last time
  // these drifted, every reader in the process asked for files the repository had stopped carrying
  // and every test still passed, because the fixture spelled the paths the same wrong way.
  it("is the three files an ApplicationSet layers off the install branch, in ArgoCD's order", () => {
    expect(clusterValueChainPaths(DOMAIN, "prod")).toEqual([
      "clusters/platform/values-common.yaml",
      "clusters/platform/values-prod.yaml",
      "clusters/active/s1.example.yaml",
    ]);
  });

  it("names the stage file after the stage asked for, and the map after the cluster asked for", () => {
    expect(clusterValueChainPaths("other.example", "dev")[1]).toBe("clusters/platform/values-dev.yaml");
    expect(clusterValueChainPaths("other.example", "dev")[2]).toBe("clusters/active/other.example.yaml");
  });

  it("puts the cluster's own map last — it is the layer that wins at deploy", () => {
    const chain = clusterValueChainPaths(DOMAIN, "test");
    expect(chain.at(-1)).toBe(clusterMapPath(DOMAIN));
    expect(splitAtChartValues(chain.map((path) => ({ path }))).afterChart).toEqual([{ path: clusterMapPath(DOMAIN) }]);
  });
});

describe("readClusterValueChain", () => {
  it("reads every file of the chain off the books branch, in layering order", async () => {
    const repo = new FakePlatformRepo();
    const files = await readClusterValueChain(repo, DOMAIN, "prod");
    expect(files.map((f) => f.path)).toEqual([...clusterValueChainPaths(DOMAIN, "prod")]);
    expect(files[1]?.content).toContain("env: prod");
  });

  it("THROWS UPSTREAM on a missing file, naming the branch and the file", async () => {
    // A chain assembled without one of its files silently drops the Vault URL, the registry host
    // and the unit apex, and the gate would approve a render nobody could deploy. The consumers
    // ApplicationSet sets no ignoreMissingValueFiles either, so a missing file stops the deploy too.
    //
    // Seeding one file of the books branch states that this tree is the test's own, so the fake
    // invents nothing else on it — which is how an INCOMPLETE tree can be observed at all.
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "clusters/platform/values-common.yaml", "global: {}\n");
    await expect(readClusterValueChain(repo, "bare.example", "prod")).rejects.toMatchObject({ code: "UPSTREAM" });
    await expect(readClusterValueChain(repo, "bare.example", "prod"))
      .rejects.toThrow(new RegExp(`${repo.booksBranch} carries no clusters/platform/values-prod\\.yaml`));
  });

  it("a branch the fixture materialized reads a COMPLETE chain — the fixture cannot drift off the reader", async () => {
    // The guard on the way this breaks: a fake that spells the chain as string
    // literals serves whatever the reader asks for, and the two agree with each other about
    // a layout that exists nowhere. This asserts the fixture against the reader rather than against
    // a second copy of the list.
    const repo = new FakePlatformRepo();
    const files = await readClusterValueChain(repo, "fresh.example", "dev");
    expect(files).toHaveLength(clusterValueChainPaths("fresh.example", "dev").length);
    for (const file of files) expect(file.content.length, file.path).toBeGreaterThan(0);
  });
});
