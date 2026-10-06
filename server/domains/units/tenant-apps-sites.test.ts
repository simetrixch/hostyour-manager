import { describe, it, expect } from "vitest";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { parseDocument } from "yaml";
import { mergeAppsManifest, readTemplateTree } from "./tenant-apps-tree.ts";

// A tenant's apps repository carries the apps it chose and the sites it serves, and no other: the tree
// copies `apps/<app>/` of the chosen apps and `webs/<site>/` of the served sites, and the apps.yaml
// entry lists them.

const TEMPLATE_APPS = "# The catalog.\napps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [digitaplatform, simetrix, show]\n";
const TEMPLATE = {
  "apps.yaml": TEMPLATE_APPS,
  "apps/web/package.json": "{}\n",
  "apps/web/content/entities/webPage.entity.json": "{}\n",
  "apps/erp/package.json": "{}\n",
  "webs/digitaplatform/website.json": "{}\n",
  "webs/simetrix/website.json": "{}\n",
  "webs/show/website.json": "{}\n",
  "webs/show/webpages.json": "[]\n",
  // A site no entry lists: no tenant carries it.
  "webs/unlisted/website.json": "{}\n",
};

async function tree(chosen: readonly string[], sites: Readonly<Record<string, readonly string[]>>, over: { files?: Record<string, string>; catalogOnly?: readonly string[] } = {}): Promise<string[]> {
  const repo = new FakeRepoReader({ files: over.files ?? TEMPLATE });
  const { workdir } = await repo.cloneAtRef({ repoURL: "https://github.com/acme/template.git", ref: "HEAD" });
  return (await readTemplateTree(repo, workdir, { templateApps: parseAppsManifest(TEMPLATE_APPS).apps, catalogOnly: over.catalogOnly ?? [], chosen, sites })).map((f) => f.path).sort();
}

describe("readTemplateTree — the apps a tenant chose and the sites a run serves", () => {
  it("copies the chosen app's folder under apps/ whole, and under webs/ the served site only", async () => {
    expect(await tree(["web"], { web: ["show"] })).toEqual([
      "apps/web/content/entities/webPage.entity.json", "apps/web/package.json", "webs/show/webpages.json", "webs/show/website.json",
    ]);
  });

  it("copies no folder of an app the tenant did not choose, and no site of a website folder it did not choose", async () => {
    expect(await tree(["erp"], {})).toEqual(["apps/erp/package.json"]);
  });

  it("PLANTED INNOCENT: a website folder the run names no sites for carries every site its entry lists, and no other", async () => {
    const paths = await tree(["web"], {});
    expect(paths.filter((p) => p.startsWith("webs/"))).toEqual(["webs/digitaplatform/website.json", "webs/show/webpages.json", "webs/show/website.json", "webs/simetrix/website.json"]);
    expect(await tree(["erp", "web"], { web: ["show"] })).toContain("apps/erp/package.json");
  });
});

describe("readTemplateTree — a catalog in another layout", () => {
  it("refuses the copy of a catalog in the old layout before it reads anything, naming the folder it looked for", async () => {
    const oldLayout = { "apps.yaml": TEMPLATE_APPS, "erp/package.json": "{}\n", "web/content/sites/show/website.json": "{}\n" };
    await expect(tree(["erp"], {}, { files: oldLayout })).rejects.toThrow("the catalog carries no apps/erp/, so it is not in the layout this Manager copies");
  });

  it("refuses the copy where a served site has no folder under webs/", async () => {
    const { "webs/show/website.json": _show, "webs/show/webpages.json": _pages, ...withoutShow } = TEMPLATE;
    await expect(tree(["web"], { web: ["show"] }, { files: withoutShow })).rejects.toThrow("the catalog carries no webs/show/");
  });
});

describe("readTemplateTree — the paths the catalog keeps for itself", () => {
  const WITH_HANDBOOK = { ...TEMPLATE, "package.json": "{}\n", "handbook/README.md": "# Handbook\n", "handbook/tools/check-app.mjs": "export {};\n" };

  it("leaves every path under catalogOnly out of the tenant's repository, and copies the rest", async () => {
    const paths = await tree(["erp"], {}, { files: WITH_HANDBOOK, catalogOnly: ["handbook"] });
    expect(paths.filter((p) => p.startsWith("handbook/"))).toEqual([]);
    expect(paths).toEqual(["apps/erp/package.json", "package.json"]);
    // A path below the root leaves only that subtree out.
    expect(await tree(["erp"], {}, { files: WITH_HANDBOOK, catalogOnly: ["handbook/tools"] })).toContain("handbook/README.md");
  });

  it("PLANTED INNOCENT: copies the handbook of a catalog that keeps nothing for itself, as before", async () => {
    expect(await tree(["erp"], {}, { files: WITH_HANDBOOK })).toEqual(["apps/erp/package.json", "handbook/README.md", "handbook/tools/check-app.mjs", "package.json"]);
  });
});

describe("mergeAppsManifest — the sites an entry lists", () => {
  const sitesOf = (content: string, name: string) => parseAppsManifest(content).apps.find((a) => a.name === name)?.sites;

  it("writes a new entry with the served sites only, in the template's order", () => {
    const { content, added, sitesAdded } = mergeAppsManifest(TEMPLATE_APPS, null, ["web"], { web: ["show", "digitaplatform"] });
    expect(added).toEqual(["web"]);
    expect(sitesAdded).toEqual([]);
    expect(sitesOf(content, "web")).toEqual(["digitaplatform", "show"]);
    expect(content).toContain("# The catalog.");
  });

  it("appends a site served now to an entry that stands, and removes none", () => {
    const current = mergeAppsManifest(TEMPLATE_APPS, null, ["web"], { web: ["show"] }).content;
    const second = mergeAppsManifest(TEMPLATE_APPS, current, ["web"], { web: ["simetrix"] });
    expect(second.added).toEqual([]);
    expect(second.sitesAdded).toEqual(["web/simetrix"]);
    expect(sitesOf(second.content, "web")).toEqual(["show", "simetrix"]);
    // Served again: nothing to add, the file is left as it stands.
    expect(mergeAppsManifest(TEMPLATE_APPS, second.content, ["web"], { web: ["show"] }).sitesAdded).toEqual([]);
  });

  it("PLANTED INNOCENT: an entry the run names no sites for keeps the template's list, as before", () => {
    expect(sitesOf(mergeAppsManifest(TEMPLATE_APPS, null, ["web"]).content, "web")).toEqual(["digitaplatform", "simetrix", "show"]);
  });
});

// An app's entry names its industry, whose labels stand once in the file's `industries`; the tenant's
// catalog build refuses an app whose industry the file does not label.
describe("mergeAppsManifest — the industries an added app names", () => {
  const TEMPLATE_LISTED = [
    "industries:",
    "  bike-workshops: { de: Velowerkstätten, en: Bike workshops }",
    "  bakeries: { de: Bäckereien, en: Bakeries }",
    "apps:",
    "  - name: workshop",
    "    industry: bike-workshops",
    "  - name: bakery",
    "    industry: bakeries",
    "  - name: web",
    "",
  ].join("\n");
  const industriesOf = (content: string) => (parseDocument(content).toJSON() as { industries?: Record<string, Record<string, string>> }).industries;

  it("PLANTED DEFECT: brings the labels of an added app's industry the copy lacks, and no other", () => {
    const current = "industries:\n  bike-workshops: { de: Velowerkstätten, en: Bike workshops }\napps:\n  - name: workshop\n    industry: bike-workshops\n";
    const { content, added } = mergeAppsManifest(TEMPLATE_LISTED, current, ["workshop", "bakery"]);
    expect(added).toEqual(["bakery"]);
    expect(industriesOf(content)).toEqual({ "bike-workshops": { de: "Velowerkstätten", en: "Bike workshops" }, bakeries: { de: "Bäckereien", en: "Bakeries" } });
  });

  it("keeps the labels the copy gives an industry it already lists", () => {
    const current = "industries:\n  bakeries: { de: Backstuben, en: Bakeries }\napps:\n  - name: workshop\n    industry: bike-workshops\n";
    expect(industriesOf(mergeAppsManifest(TEMPLATE_LISTED, current, ["bakery"]).content)?.bakeries).toEqual({ de: "Backstuben", en: "Bakeries" });
  });

  it("gives a copy without industries the map with the added app's industry", () => {
    const current = "apps:\n  - name: web\n";
    expect(industriesOf(mergeAppsManifest(TEMPLATE_LISTED, current, ["bakery"]).content)).toEqual({ bakeries: { de: "Bäckereien", en: "Bakeries" } });
  });

  it("PLANTED INNOCENT: an added app without an industry, or one the template does not label, brings none", () => {
    const current = "apps:\n  - name: workshop\n";
    expect(industriesOf(mergeAppsManifest(TEMPLATE_LISTED, current, ["web"]).content)).toBeUndefined();
    const unlabelled = TEMPLATE_LISTED.replace("    industry: bakeries", "    industry: cafes");
    expect(industriesOf(mergeAppsManifest(unlabelled, current, ["bakery"]).content)).toBeUndefined();
  });
});
