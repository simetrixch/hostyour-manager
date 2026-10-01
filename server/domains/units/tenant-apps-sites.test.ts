import { describe, it, expect } from "vitest";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { mergeAppsManifest, readTemplateTree } from "./tenant-apps-tree.ts";

// A tenant's apps repository carries the content of the sites it serves and no other: the tree copies
// `<folder>/content/sites/<id>/` only for the sites a run serves, and the apps.yaml entry lists them.

const TEMPLATE_APPS = "# The catalog.\napps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [digitaplatform, simetrix, show]\n";
const TEMPLATE = {
  "apps.yaml": TEMPLATE_APPS,
  "web/package.json": "{}\n",
  "web/content/entities/webPage.entity.json": "{}\n",
  "web/content/sites/digitaplatform/website.json": "{}\n",
  "web/content/sites/simetrix/website.json": "{}\n",
  "web/content/sites/show/website.json": "{}\n",
  "web/content/sites/show/webpages.json": "[]\n",
  "erp/package.json": "{}\n",
};

async function tree(chosen: readonly string[], sites: Readonly<Record<string, readonly string[]>>, over: { files?: Record<string, string>; catalogOnly?: readonly string[] } = {}): Promise<string[]> {
  const repo = new FakeRepoReader({ files: over.files ?? TEMPLATE });
  const { workdir } = await repo.cloneAtRef({ repoURL: "https://github.com/acme/template.git", ref: "HEAD" });
  return (await readTemplateTree(repo, workdir, { templateApps: ["erp", "web"], catalogOnly: over.catalogOnly ?? [], chosen, sites })).map((f) => f.path).sort();
}

describe("readTemplateTree — the sites a run serves", () => {
  it("copies the content of the served site and none of the others, and the rest of the folder whole", async () => {
    expect(await tree(["web"], { web: ["show"] })).toEqual([
      "web/content/entities/webPage.entity.json", "web/content/sites/show/webpages.json", "web/content/sites/show/website.json", "web/package.json",
    ]);
  });

  it("PLANTED INNOCENT: copies a folder whole where the run names no sites for it, as before", async () => {
    expect(await tree(["web"], {})).toContain("web/content/sites/simetrix/website.json");
    expect(await tree(["erp", "web"], { web: ["show"] })).toContain("erp/package.json");
  });
});

describe("readTemplateTree — the paths the catalog keeps for itself", () => {
  const WITH_HANDBOOK = { ...TEMPLATE, "package.json": "{}\n", "handbook/README.md": "# Handbook\n", "handbook/tools/check-app.mjs": "export {};\n" };

  it("leaves every path under catalogOnly out of the tenant's repository, and copies the rest", async () => {
    const paths = await tree(["erp"], {}, { files: WITH_HANDBOOK, catalogOnly: ["handbook"] });
    expect(paths.filter((p) => p.startsWith("handbook/"))).toEqual([]);
    expect(paths).toEqual(["erp/package.json", "package.json"]);
    // A path below the root leaves only that subtree out.
    expect(await tree(["erp"], {}, { files: WITH_HANDBOOK, catalogOnly: ["handbook/tools"] })).toContain("handbook/README.md");
  });

  it("PLANTED INNOCENT: copies the handbook of a catalog that keeps nothing for itself, as before", async () => {
    expect(await tree(["erp"], {}, { files: WITH_HANDBOOK })).toEqual(["erp/package.json", "handbook/README.md", "handbook/tools/check-app.mjs", "package.json"]);
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
