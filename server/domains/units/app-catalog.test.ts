import { describe, it, expect } from "vitest";
import type { ClonedRepo, RepoReader } from "../../adapters/git/port.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { TenantSpecSchema } from "../../../shared/consumer.ts";
import { APPS_MANIFEST_PATH } from "../../../shared/apps-manifest.ts";
import {
  fallbackCatalog,
  listTenantAppCatalog,
  makeAppCatalogProvider,
  readAppCatalog,
  readAppsManifest,
} from "./app-catalog.ts";

/** The engine chart the fixture product declares — the stand-in reads it out of the manifest, so
 *  the test states it rather than importing a constant the module does not own. */
const ENGINE_CHART = "charts/example-engine";
const APPS_REPO = "https://github.com/acme/acme-apps.git";
const REPO_URL = "https://github.com/acme/acme-catalog.git";

/** The product's manifest WITH an apps template: `appsRepo` is the repository the catalog is read
 *  from, and no buildRepos entry builds it. */
const MANIFEST = (appsBundle: string | null): string => `apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-engine
    containerfile: Dockerfile
tenant:
${appsBundle === null ? "" : `  appsBundle: ${appsBundle}\n  appsRepo: ${APPS_REPO}\n`}  buildRepos:
    - repo: https://github.com/acme/acme-engine.git
      builds: [acme-engine]
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: ${ENGINE_CHART} }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const APPS_YAML = `apps:
  - name: erp
    title: ERP
    description: Orders, stock and accounting.
    selections:
      seedReference: { title: Reference data, default: true }
      seedDemo: { title: Demo data, default: false }
    databases: [core, logs, master]
  - name: web
    title: Website
    selections: {}
`;

const overlays = (names: string[]): Record<string, string> => Object.fromEntries(names.map((n) => [`${ENGINE_CHART}/${n}`, "x"]));

/** A fake serves ONE file map for every clone it makes — the catalog's and the apps repository's
 *  alike — so a fixture lays both trees into it and the clone log says which repository was asked. */
const files = (over: { bundle?: string | null; appsYaml?: string; overlays?: string[] } = {}): Record<string, string> => ({
  "deploy/platform.yaml": MANIFEST(over.bundle === undefined ? "acme-apps" : over.bundle),
  ...(over.appsYaml !== undefined ? { [APPS_MANIFEST_PATH]: over.appsYaml } : {}),
  ...overlays(over.overlays ?? []),
});

const spec = (bundle: string | null): ReturnType<typeof TenantSpecSchema.parse> =>
  TenantSpecSchema.parse({
    ...(bundle === null ? {} : { appsBundle: bundle, appsRepo: APPS_REPO }),
    members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }],
    perApp: { engine: { chart: ENGINE_CHART }, front: { chart: "charts/example-ui" } },
  });

describe("fallbackCatalog (the overlay stand-in, pure)", () => {
  it("keeps values-<app>.yaml overlays as apps titled by name, with the two seed selections, de-duped + sorted", () => {
    const c = fallbackCatalog(["values-web.yaml", "values-erp.yaml", "values-web.yaml"]);
    expect(c.apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(c.apps[0]).toMatchObject({ name: "erp", title: "erp", description: "" });
    expect(Object.keys(c.apps[0]!.selections).sort()).toEqual(["seedDemo", "seedReference"]);
    expect(c.apps[0]!.selections.seedReference?.default).toBe(false);
    expect(c.apps[0]!.databases).toBeUndefined(); // the overlay carries the list; nothing here invents one
  });

  it("excludes the bare values.yaml, the stage/common overlays, and names outside the app grammar", () => {
    expect(fallbackCatalog(["values.yaml", "values-dev.yaml", "values-test.yaml", "values-prod.yaml", "values-common.yaml", "values-.yaml", "values-x.yaml", "values-Bad_Name.yaml", "README.md", "values-web.yaml"]).apps.map((a) => a.name)).toEqual(["web"]);
    expect(fallbackCatalog(["values.yaml", "Chart.yaml", "templates"]).apps).toEqual([]);
  });
});

describe("readAppsManifest (the primitive: one apps repository, one credential)", () => {
  it("clones the repository at its default branch head with the credential given and parses apps.yaml", async () => {
    const repo = new FakeRepoReader({ files: { [APPS_MANIFEST_PATH]: APPS_YAML } });
    const m = await readAppsManifest({ repo, repoURL: APPS_REPO, credentialId: "cred_tenant" });
    expect(m?.apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(repo.clones).toEqual([{ repoURL: APPS_REPO, ref: "HEAD", credentialId: "cred_tenant" }]);
  });

  it("answers null where the repository carries no apps.yaml, and clones without a credential where none is given", async () => {
    const repo = new FakeRepoReader({ files: {} });
    expect(await readAppsManifest({ repo, repoURL: APPS_REPO })).toBeNull();
    expect(repo.clones).toEqual([{ repoURL: APPS_REPO, ref: "HEAD" }]);
  });
});

describe("readAppCatalog (the manifest of the apps template, else the stand-in)", () => {
  const warns: string[] = [];
  const catalogOf = (repo: RepoReader, s = spec("acme-apps")) =>
    readAppCatalog({ spec: s, catalog: { repo, workdir: "/w", credentialId: "catalog-read-pat" }, warn: (m) => warns.push(m) });

  it("reads apps.yaml off the template repository (tenant.appsRepo) at its default branch head, with the catalog's credential, and warns of nothing", async () => {
    warns.length = 0;
    const repo = new FakeRepoReader({ files: files({ appsYaml: APPS_YAML }) });
    const c = await catalogOf(repo);
    expect(c.apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(c.apps[0]).toMatchObject({ title: "ERP", description: "Orders, stock and accounting.", databases: ["core", "logs", "master"] });
    expect(c.apps[0]!.selections.seedReference).toEqual({ title: "Reference data", default: true });
    expect(c.apps[1]!.selections).toEqual({});
    expect(repo.clones).toEqual([{ repoURL: APPS_REPO, ref: "HEAD", credentialId: "catalog-read-pat" }]);
    expect(warns).toEqual([]);
  });

  it("serves the overlay stand-in, with a warning, where the template carries no apps.yaml", async () => {
    warns.length = 0;
    const repo = new FakeRepoReader({ files: files({ overlays: ["values.yaml", "values-prod.yaml", "values-web.yaml", "values-erp.yaml"] }) });
    const c = await catalogOf(repo);
    expect(c.apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(c.apps[0]!.title).toBe("erp");
    expect(repo.clones.map((x) => x.repoURL)).toEqual([APPS_REPO]); // it was asked, and had none
    expect(warns.some((w) => w.includes(`carries no ${APPS_MANIFEST_PATH}`) && w.includes(`${ENGINE_CHART}/values-<app>.yaml`))).toBe(true);
  });

  it("serves the stand-in, with a warning, where the catalog declares no appsBundle — and clones nothing", async () => {
    warns.length = 0;
    const repo = new FakeRepoReader({ files: files({ bundle: null, overlays: ["values-web.yaml"] }) });
    const c = await catalogOf(repo, spec(null));
    expect(c.apps.map((a) => a.name)).toEqual(["web"]);
    expect(repo.clones).toEqual([]);
    expect(warns[0]).toMatch(/declares no tenant\.appsBundle/);
  });

  it("THROWS on an apps.yaml that does not match the shape, naming the file and the field", async () => {
    const repo = new FakeRepoReader({ files: files({ appsYaml: "apps:\n  - name: Erp\n    title: ERP\n" }) });
    await expect(catalogOf(repo)).rejects.toThrow(/apps\.yaml does not match the apps manifest shape .*apps\.0\.name/);
  });

  it("THROWS when the clone of the apps repository fails — the plan records a preflight rejection, the route falls soft", async () => {
    const repo: RepoReader = {
      cloneAtRef: async () => { throw new Error("clone failed: authentication required"); },
      readFile: async () => null, listDir: async () => [], dispose: async () => {},
    };
    await expect(catalogOf(repo)).rejects.toThrow(/clone failed/);
  });
});

describe("listTenantAppCatalog (the provider's clone of the catalog)", () => {
  it("clones the catalog at ref with the read credential, then the template with the same credential, and returns the manifest", async () => {
    const repo = new FakeRepoReader({ files: files({ appsYaml: APPS_YAML }) });
    const c = await listTenantAppCatalog({ repo, repoURL: REPO_URL, ref: "master", credentialId: "catalog-read-pat", warn: () => {} });
    expect(c.apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(repo.clones).toEqual([
      { repoURL: REPO_URL, ref: "master", credentialId: "catalog-read-pat" },
      { repoURL: APPS_REPO, ref: "HEAD", credentialId: "catalog-read-pat" },
    ]);
  });

  it("THROWS when the product declares no manifest — there is no apps repository to read from", async () => {
    const repo = new FakeRepoReader({ files: { "README.md": "x" } });
    await expect(listTenantAppCatalog({ repo, repoURL: REPO_URL, ref: "master", warn: () => {} })).rejects.toThrow(/deploy\/platform\.yaml is absent/);
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
  const names = (c: { apps: { name: string }[] }): string[] => c.apps.map((a) => a.name);

  it("caches within the TTL (the catalog and the apps repository cloned once for repeated loads) and re-clones after it expires", async () => {
    const repo = new ToggleRepoReader(files({ appsYaml: APPS_YAML }));
    let clock = 1000;
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: () => {}, ttlMs: 5000, now: () => clock });
    expect(names(await p.list())).toEqual(["erp", "web"]);
    expect(names(await p.list())).toEqual(["erp", "web"]);
    expect(repo.clones).toBe(2); // the catalog + the apps repository; the second load hit the cache
    clock += 6000; // past the TTL
    expect(names(await p.list())).toEqual(["erp", "web"]);
    expect(repo.clones).toBe(4); // stale → both cloned again
  });

  it("fail-soft: answers no apps on a clone error when there is no prior cache, and logs", async () => {
    const repo = new ToggleRepoReader(files({ appsYaml: APPS_YAML }));
    repo.fail = true;
    const warnings: string[] = [];
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: (_f, msg) => warnings.push(msg), ttlMs: 1000, now: () => 0 });
    expect(await p.list()).toEqual({ apps: [], packageScopes: [] });
    expect(warnings).toHaveLength(1);
  });

  it("serves the last good catalog (stale) when a later fetch fails", async () => {
    const repo = new ToggleRepoReader(files({ appsYaml: APPS_YAML }));
    let clock = 0;
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: () => {}, ttlMs: 100, now: () => clock });
    expect(names(await p.list())).toEqual(["erp", "web"]); // good fetch caches the manifest
    clock += 200; // expire the cache
    repo.fail = true;
    expect(names(await p.list())).toEqual(["erp", "web"]); // stale-but-good, never blank
  });

  it("logs the stand-in through the pino-shaped sink, with the catalog's coordinates", async () => {
    const repo = new ToggleRepoReader(files({ overlays: ["values-web.yaml"] }));
    const logged: { fields: Record<string, unknown>; msg: string }[] = [];
    const p = makeAppCatalogProvider({ repo, repoURL: REPO_URL, ref: "master", warn: (fields, msg) => logged.push({ fields, msg }), now: () => 0 });
    expect(names(await p.list())).toEqual(["web"]);
    expect(logged.map((l) => l.fields)).toContainEqual({ repoURL: REPO_URL, ref: "master" });
    expect(logged.some((l) => l.msg.includes(`carries no ${APPS_MANIFEST_PATH}`))).toBe(true);
  });
});
