import { describe, it, expect } from "vitest";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { readTemplateTree } from "./tenant-apps-tree.ts";

// The template's files reach a tenant's repository as git stores them, and a path the repository
// already carries is neither read nor copied.

const TEMPLATE_APPS = "apps:\n  - name: workshop\n    title: Workshop\n";
// The head and tail of a JPEG: 0xFF and 0xD8 are no UTF-8, so a copy through text would change them.
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const IMAGE = "apps/workshop/seeds-demo/files/bike.jpg";

async function tree(stands: (path: string) => Promise<boolean>): Promise<{ files: Map<string, Uint8Array>; read: string[] }> {
  const repo = new FakeRepoReader({ files: { "apps.yaml": TEMPLATE_APPS, "apps/workshop/package.json": "{}\n" }, bytes: { [IMAGE]: JPEG } });
  const read: string[] = [];
  const readFileBytes = repo.readFileBytes.bind(repo);
  repo.readFileBytes = async (workdir, path) => { read.push(path); return readFileBytes(workdir, path); };
  const { workdir } = await repo.cloneAtRef({ repoURL: "https://github.com/acme/template.git", ref: "HEAD" });
  const out = await readTemplateTree(repo, workdir, { templateApps: parseAppsManifest(TEMPLATE_APPS).apps, catalogOnly: [], chosen: ["workshop"], sites: {}, stands });
  return { files: new Map(out.map((f) => [f.path, f.content])), read };
}

describe("readTemplateTree — the bytes of the template", () => {
  it("PLANTED DEFECT: hands an image over byte for byte for a repository that lacks it", async () => {
    const { files } = await tree(async () => false);
    expect([...files.get(IMAGE)!]).toEqual([...JPEG]);
    expect(Buffer.from(files.get("apps/workshop/package.json")!).toString("utf8")).toBe("{}\n");
  });

  it("PLANTED DEFECT: neither reads nor hands over an image the repository already carries", async () => {
    const { files, read } = await tree(async (path) => path === IMAGE);
    expect(files.has(IMAGE)).toBe(false);
    expect(read).not.toContain(IMAGE);
    // PLANTED INNOCENT: a file the repository lacks beside it is still read and handed over.
    expect(read).toContain("apps/workshop/package.json");
    expect(files.has("apps/workshop/package.json")).toBe(true);
  });
});
