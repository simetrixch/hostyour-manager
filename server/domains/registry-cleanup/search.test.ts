import { describe, it, expect } from "vitest";
import { searchCarriers, type CarrierRepo, type SearchDeps } from "./search.ts";
import { pinKey } from "../../../shared/pin.ts";
import { FakeCarrierRepo, FakeUnitRepo, stageRegistration, buildRegistration, pinFile } from "./carriers.fixture.ts";

// The search is the ONE thing that decides what "pinned" means — for the release bump when it writes
// and for the reaper's floor when it protects. These cases pin down the three carrier classes, the
// branch coverage, and every case where an unreadable carrier must abort instead of shrinking the
// answer.

const AUTH_REPO = "https://github.com/example/example-auth.git";

/** hostyour-cloud with ONE deployable registration (example-auth at prod) plus a build-only unit. */
function cloudWithRegistrations(): FakeCarrierRepo {
  const cloud = new FakeCarrierRepo();
  cloud.seed(cloud.booksBranch, "registrations/example-auth/prod.yaml", stageRegistration({ name: "example-auth", repoURL: AUTH_REPO, repoCredentialId: "cred_auth", chartPath: "deploy/chart", cluster: "m1" }));
  cloud.seed(cloud.booksBranch, "registrations/hostyour-manager/build.yaml", buildRegistration({ name: "hostyour-manager", repoURL: "https://github.com/example/hostyour-manager.git", builds: ["controller"] }));
  return cloud;
}

function deps(over: Partial<SearchDeps> = {}): SearchDeps {
  return { cloud: new FakeCarrierRepo(), deploy: new FakeCarrierRepo(), unit: new FakeUnitRepo(), ...over };
}

describe("searchCarriers — the three carrier classes", () => {
  it("(a) reads a deployable unit's pins off its OWN deploy/<stage> branch, under its OWN credential", async () => {
    const cloud = cloudWithRegistrations();
    const unit = new FakeUnitRepo();
    unit.seed(AUTH_REPO, "deploy/prod", "deploy/chart/values-prod.yaml", pinFile([["example-auth-backend", "0.4.0"]]));

    const hits = await searchCarriers(deps({ cloud, unit }));

    expect(hits.map((h) => pinKey(h.pin))).toEqual(["example-auth-backend:0.4.0"]);
    expect(unit.clones).toEqual([{ repoURL: AUTH_REPO, ref: "deploy/prod", credentialId: "cred_auth" }]);
    expect(hits[0]!.carrier).toBe(`${AUTH_REPO}@deploy/prod:deploy/chart/values-prod.yaml`);
    expect(unit.open.size).toBe(0); // every clone disposed
  });

  // A catalog chart pins in TWO files and both are live: values.yaml on the trunk is the product
  // default a fresh installation renders, pins-<stage>.yaml on an installation's books branch is
  // what that installation actually runs. Reading only one of them leaves real deployments
  // unprotected — the trunk default on an installation that has never built, the per-stage pin on
  // every installation that has.
  it("(b) reads BOTH catalog pin files — the trunk default and the per-installation pins — on EVERY branch", async () => {
    const deploy = new FakeCarrierRepo();
    deploy.seed("master", "charts/example-engine/values.yaml", pinFile([["example-engine", "0.3.0"]]));
    deploy.seed("c1.example.com", "charts/example-engine/pins-prod.yaml", pinFile([["example-engine", "0.2.0"]]));
    deploy.seed("c2.example.com", "charts/example-engine/pins-dev.yaml", pinFile([["example-engine", "0.5.0"]]));
    // A stage values file of the catalog carries no pin any more — a tag there would stand on the
    // trunk every installation reads, so nothing must be read out of it either.
    deploy.seed("master", "charts/example-engine/values-prod.yaml", pinFile([["example-engine", "9.9.9"]]));

    const hits = await searchCarriers(deps({ deploy }));

    expect(new Set(hits.map((h) => pinKey(h.pin)))).toEqual(
      new Set(["example-engine:0.3.0", "example-engine:0.2.0", "example-engine:0.5.0"]),
    );
    expect(deploy.fetched.sort()).toEqual(["c1.example.com", "c2.example.com", "master"]);
  });

  it("(c) reads hostyour-cloud apps/*/values-<stage>.yaml on master AND the install branches", async () => {
    const cloud = new FakeCarrierRepo();
    cloud.seed("master", "apps/controller/values-prod.yaml", pinFile([["controller", "0.2.0"]]));
    cloud.seed("m1.example.com", "apps/controller/values-prod.yaml", pinFile([["controller", "0.1.0"]]));

    const hits = await searchCarriers(deps({ cloud }));

    // The install branch stands on an OLDER release than master; reading master alone would leave the
    // tag the running cluster actually pulls out of the answer.
    expect(new Set(hits.map((h) => pinKey(h.pin)))).toEqual(new Set(["controller:0.2.0", "controller:0.1.0"]));
  });

  it("reads a SUSPENDED unit like any other — a suspended deploy is resumable and its image stays live", async () => {
    const cloud = new FakeCarrierRepo();
    cloud.seed(cloud.booksBranch, "registrations/example-auth/prod.yaml", stageRegistration({ name: "example-auth", repoURL: AUTH_REPO, chartPath: "deploy/chart", cluster: "m1", suspended: true, quiesced: true }));
    const unit = new FakeUnitRepo();
    unit.seed(AUTH_REPO, "deploy/prod", "deploy/chart/values-prod.yaml", pinFile([["example-auth-backend", "0.4.0"]]));

    const hits = await searchCarriers(deps({ cloud, unit }));

    expect(hits.map((h) => pinKey(h.pin))).toEqual(["example-auth-backend:0.4.0"]);
  });

  it("a build-only registration contributes nothing of its own — it has no chart to pin from", async () => {
    const cloud = new FakeCarrierRepo();
    cloud.seed(cloud.booksBranch, "registrations/hostyour-manager/build.yaml", buildRegistration({ name: "hostyour-manager", repoURL: "https://github.com/example/hostyour-manager.git", builds: ["controller"] }));
    const unit = new FakeUnitRepo();

    expect(await searchCarriers(deps({ cloud, unit }))).toEqual([]);
    expect(unit.clones).toEqual([]); // no clone attempted, so no branch to be missing
  });

  it("a pin file that pins nothing is not an error — a catalog chart may ship no image of its own", async () => {
    const deploy = new FakeCarrierRepo();
    deploy.seed("master", "charts/example-auth/values-dev.yaml", "global:\n  env: dev\n");
    expect(await searchCarriers(deps({ deploy }))).toEqual([]);
  });
});

describe("searchCarriers — FAIL-CLOSED (a carrier it cannot read is never read as empty)", () => {
  it("a stage registration whose delivery branch is missing ABORTS, naming the unit, the stage and the branch", async () => {
    const cloud = cloudWithRegistrations();
    const unit = new FakeUnitRepo(); // no deploy/prod ref seeded

    await expect(searchCarriers(deps({ cloud, unit }))).rejects.toThrow(/example-auth.*registered at prod.*deploy\/prod/s);
  });

  it("a delivery branch WITHOUT the pin file ABORTS — the file is where its pins stand", async () => {
    const cloud = cloudWithRegistrations();
    const unit = new FakeUnitRepo();
    unit.seedRef(AUTH_REPO, "deploy/prod"); // branch exists, values-prod.yaml does not

    await expect(searchCarriers(deps({ cloud, unit }))).rejects.toThrow(/deploy\/chart\/values-prod\.yaml does not exist/);
  });

  it("a registration that fails its schema ABORTS rather than being skipped", async () => {
    const cloud = new FakeCarrierRepo();
    cloud.seed(cloud.booksBranch, "registrations/broken/prod.yaml", 'name: "broken"\nrepoURL: "not-a-git-url"\n');

    await expect(searchCarriers(deps({ cloud }))).rejects.toBeTruthy();
  });

  it("a pin that breaks the grammar ABORTS — a mis-keyed pin is a tag nothing would protect", async () => {
    const deploy = new FakeCarrierRepo();
    deploy.seed("master", "charts/example-engine/values.yaml", 'builds:\n  - name: example-engine\n    image: zot.example.com/example-engine\n    tag: "0.3.0"\n');

    await expect(searchCarriers(deps({ deploy }))).rejects.toThrow(/pin grammar/);
  });

  it("a branch listing that throws ABORTS — a missed branch is a missed pin", async () => {
    const broken: CarrierRepo = {
      booksBranch: "m1.example.com",
      listBranches: () => Promise.reject(new Error("branch listing truncated")),
      withBranch: () => Promise.reject(new Error("no turn should be taken after a failed branch listing")),
    };

    await expect(searchCarriers(deps({ deploy: broken }))).rejects.toThrow(/branch listing truncated/);
  });
});
