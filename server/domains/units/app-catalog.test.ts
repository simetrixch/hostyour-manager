import { describe, it, expect } from "vitest";
import type { ClonedRepo, RepoReader } from "../../adapters/git/port.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import {
  parseAppCatalog,
  listTenantAppCatalog,
  makeAppCatalogProvider,
} from "./app-catalog.ts";

/** The engine chart the fixture product declares — the catalog reads it out of the manifest now, so
 *  the test states it rather than importing a constant the module no longer owns. */
const ENGINE_CHART = "charts/example-engine";

// One catalog fixture: values.yaml (the chart base) + the per-stage overlays + three real
// app-type overlays. filesFor lays them under charts/example-engine/ so the fake's listDir derives the
// directory listing from the map keys — the same shape the real GitRepoReader.listDir returns.
/** The product's manifest, which the catalog now reads to learn WHICH chart's overlays are the app
 *  types. Every fixture carries it, because a repo without one is a repo the catalog cannot read. */
const MANIFEST = `apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-engine
    containerfile: Dockerfile
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: ${ENGINE_CHART} }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const filesFor = (names: string[]): Record<string, string> => ({
  "deploy/platform.yaml": MANIFEST,
  ...Object.fromEntries(names.map((n) => [`${ENGINE_CHART}/${n}`, "x"])),
});

const REPO_URL = "https://github.com/simetrixch/catalog.git";

describe("parseAppCatalog (pure filtering)", () => {
  it("keeps values-<app>.yaml overlays, de-duped + sorted", () => {
    expect(parseAppCatalog(["values-web.yaml", "values-erp.yaml", "values-buildproject.yaml", "values-web.yaml"])).toEqual([
      "buildproject",
      "erp",
      "web",
    ]);
  });

  it("excludes the bare values.yaml and the stage/common overlays", () => {
    expect(
      parseAppCatalog(["values.yaml", "values-dev.yaml", "values-test.yaml", "values-prod.yaml", "values-common.yaml", "values-web.yaml"]),
    ).toEqual(["web"]);
  });

  it("does NOT exclude names that a tenant's standing members happen to use", () => {
    // The catalog is the PRODUCT's list of app types; the standing members are a fact about ONE
    // tenant. A collision is caught where both are known — TenantRegistrationSchema's superRefine —
    // not by filtering three names out of every product's catalog.
    expect(parseAppCatalog(["values-auth.yaml", "values-jobs.yaml", "values-report.yaml", "values-erp.yaml"])).toEqual([
      "auth", "erp", "jobs", "report",
    ]);
    // "base" names no member any more, so an overlay called that is an app-type like any other.
    expect(parseAppCatalog(["values-base.yaml", "values-erp.yaml"])).toEqual(["base", "erp"]);
  });

  it("ignores non-values files and overlays whose name is not a valid app name", () => {
    // README/Chart/templates aren't values-*.yaml; values-.yaml has an empty name; values-x.yaml is a
    // single char (< appName's 2-char minimum); Bad_Name has uppercase + underscore.
    expect(parseAppCatalog(["README.md", "Chart.yaml", "templates", "values-.yaml", "values-x.yaml", "values-Bad_Name.yaml", "values-web.yaml"])).toEqual([
      "web",
    ]);
  });

  it("is empty for a directory with no overlays", () => {
    expect(parseAppCatalog(["values.yaml", "Chart.yaml", "templates"])).toEqual([]);
  });
});

describe("listTenantAppCatalog (port orchestration)", () => {
  it("clones catalog, lists charts/example-engine, and returns the parsed catalog", async () => {
    const repo = new FakeRepoReader({ files: filesFor(["values.yaml", "values-prod.yaml", "values-web.yaml", "values-erp.yaml"]) });
    const apps = await listTenantAppCatalog({ repo, repoURL: REPO_URL, ref: "master", credentialId: "catalog-read-pat" });
    expect(apps).toEqual(["erp", "web"]);
    // Cloned at the SAME repo/ref/read-credential validateTenant uses.
    expect(repo.clones).toEqual([{ repoURL: REPO_URL, ref: "master", credentialId: "catalog-read-pat" }]);
  });

  it("returns [] when the engine directory is absent (no overlays to list)", async () => {
    const repo = new FakeRepoReader({ files: { "README.md": "x", "deploy/platform.yaml": MANIFEST } });
    expect(await listTenantAppCatalog({ repo, repoURL: REPO_URL, ref: "master" })).toEqual([]);
  });

  it("THROWS when the product declares no manifest — there is no engine chart to list from", async () => {
    const repo = new FakeRepoReader({ files: { "README.md": "x" } });
    await expect(listTenantAppCatalog({ repo, repoURL: REPO_URL, ref: "master" })).rejects.toThrow(/deploy\/platform\.yaml is absent/);
  });
});

// A RepoReader whose clone can be toggled to fail — for the provider's cache + fail-soft paths. Tracks
// the clone count so a test can assert the TTL cache actually spares the clone.
class ToggleRepoReader implements RepoReader {
  fail = false;
  clones = 0;
  constructor(private readonly files: Record<string, string>) {}
  async cloneAtRef(): Promise<ClonedRepo> {
    this.clones++;
    if (this.fail) throw new Error("catalog unreachable");
    return { workdir: "/w", resolvedSha: "f".repeat(40) };
  }
  // The catalog reads the product's manifest to learn which chart's overlays are the app types, so a
  // reader that answers null to every file is a repo with no manifest — not the case under test here.
  async readFile(_workdir: string, relPath: string): Promise<string | null> {
    return this.files[relPath] ?? null;
  }
  async listDir(_workdir: string, relPath: string): Promise<string[]> {
    const prefix = `${relPath.replace(/\/+$/, "")}/`;
    const names = new Set<string>();
    for (const p of Object.keys(this.files)) {
      if (!p.startsWith(prefix)) continue;
      const seg = p.slice(prefix.length).split("/")[0];
      if (seg) names.add(seg);
    }
    return [...names];
  }
  async dispose(): Promise<void> {}
}

describe("makeAppCatalogProvider (TTL cache + fail-soft)", () => {
  it("caches within the TTL (one clone for repeated loads) and re-clones after it expires", async () => {
    const repo = new ToggleRepoReader(filesFor(["values-web.yaml"]));
    let clock = 1000;
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: () => {}, ttlMs: 5000, now: () => clock });
    expect(await p.list()).toEqual(["web"]);
    expect(await p.list()).toEqual(["web"]);
    expect(repo.clones).toBe(1); // the second load hit the cache
    clock += 6000; // past the TTL
    expect(await p.list()).toEqual(["web"]);
    expect(repo.clones).toBe(2); // stale → re-cloned
  });

  it("fail-soft: returns [] on a clone error when there is no prior cache, and logs", async () => {
    const repo = new ToggleRepoReader(filesFor(["values-web.yaml"]));
    repo.fail = true;
    const warnings: string[] = [];
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: (_f, msg) => warnings.push(msg), ttlMs: 1000, now: () => 0 });
    expect(await p.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("serves the last good catalog (stale) when a later fetch fails", async () => {
    const repo = new ToggleRepoReader(filesFor(["values-web.yaml"]));
    let clock = 0;
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: () => {}, ttlMs: 100, now: () => clock });
    expect(await p.list()).toEqual(["web"]); // good fetch caches ["web"]
    clock += 200; // expire the cache
    repo.fail = true;
    expect(await p.list()).toEqual(["web"]); // stale-but-good, never blank
  });
});
