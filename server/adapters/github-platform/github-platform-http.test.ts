import { describe, it, expect } from "vitest";
import { createGitHubPlatform, GitHubPlatformError } from "./github-platform-http.ts";

// A tiny fetch stub: routes by method+path, returns { status, json }.
function stubFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const key = `${init?.method ?? "GET"} ${u.replace("https://api.github.com", "")}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected fetch: ${key}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body ?? null,
    } as Response;
  }) as unknown as typeof fetch;
}

const cfg = { owner: "simetrixch", repo: "hostyour-cloud", token: "tkn" };

describe("github adapter", () => {
  it("lists + sorts branches, following pagination", () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `b${String(i).padStart(3, "0")}`, commit: { sha: `s${i}` } }));
    const client = createGitHubPlatform(cfg, stubFetch({
      "GET /repos/simetrixch/hostyour-cloud/branches?per_page=100&page=1": { status: 200, body: page1 },
      "GET /repos/simetrixch/hostyour-cloud/branches?per_page=100&page=2": { status: 200, body: [{ name: "aaa", commit: { sha: "sx" } }] },
    }));
    return client.listBranches().then((bs) => {
      expect(bs).toHaveLength(101);
      expect(bs[0]).toEqual({ name: "aaa", sha: "sx" }); // sorted: aaa < b000
      expect(bs[1]?.name).toBe("b000");
    });
  });

  it("compares base…head into ahead/behind + files, flags no truncation", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({
      "GET /repos/simetrixch/hostyour-cloud/compare/master...s1.example.com": {
        status: 200,
        body: {
          ahead_by: 3, behind_by: 0, total_commits: 3,
          files: [{ filename: "base/configs/config.prod", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1 @@" }],
        },
      },
    }));
    const cmp = await client.compare("master", "s1.example.com");
    expect(cmp.aheadBy).toBe(3);
    expect(cmp.truncated).toBe(false);
    expect(cmp.files[0]).toMatchObject({ filename: "base/configs/config.prod", status: "modified", additions: 5, patch: "@@ -1 +1 @@" });
  });

  it("deleteBranch tolerates an already-gone ref (404/422)", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({
      "DELETE /repos/simetrixch/hostyour-cloud/git/refs/heads/s9.example.com": { status: 422, body: { message: "Reference does not exist" } },
    }));
    await expect(client.deleteBranch("s9.example.com")).resolves.toBeUndefined();
  });

  it("surfaces GitHub's error message (not a generic mask) on a real failure", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({
      "DELETE /repos/simetrixch/hostyour-cloud/git/refs/heads/master": { status: 403, body: { message: "protected branch" } },
    }));
    await expect(client.deleteBranch("master")).rejects.toThrow(GitHubPlatformError);
    await expect(client.deleteBranch("master")).rejects.toThrow(/protected branch/);
  });

  it("listBranches throws a GitHubPlatformError (not 'not iterable') on a 404", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({
      "GET /repos/simetrixch/hostyour-cloud/branches?per_page=100&page=1": { status: 404, body: { message: "Not Found" } },
    }));
    await expect(client.listBranches()).rejects.toThrow(GitHubPlatformError);
    await expect(client.listBranches()).rejects.toThrow(/Not Found/);
  });

  it("listBranches THROWS on a truncated enumeration (20 full pages => >2000 branches) — a partial list must never feed a safety set", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}`, commit: { sha: `s${i}` } }));
    const routes: Record<string, { status: number; body?: unknown }> = {};
    for (let p = 1; p <= 20; p++) routes[`GET /repos/simetrixch/hostyour-cloud/branches?per_page=100&page=${p}`] = { status: 200, body: fullPage };
    const client = createGitHubPlatform(cfg, stubFetch(routes));
    await expect(client.listBranches()).rejects.toThrow(GitHubPlatformError);
    await expect(client.listBranches()).rejects.toThrow(/truncated enumeration/);
  });

  it("assertSaneRef refuses a dot-segment ref name before any request", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({})); // no routes — a request would throw "unexpected"
    await expect(client.deleteBranch("heads/../../x")).rejects.toThrow(/suspicious ref name/);
    await expect(client.listBlobs("a/..")).rejects.toThrow(/suspicious ref name/);
  });
});

// The git-data API path used by the Reset wizard: ref → commit → recursive tree → new tree
// (sha:null deletes) → commit → fast-forward ref.
const B = "m1.example.com";
const treeRoutes = (blobs: { path: string; type: string }[], truncated = false): Record<string, { status: number; body?: unknown }> => ({
  [`GET /repos/simetrixch/hostyour-cloud/git/ref/heads/${B}`]: { status: 200, body: { object: { sha: "HEAD1" } } },
  "GET /repos/simetrixch/hostyour-cloud/git/commits/HEAD1": { status: 200, body: { tree: { sha: "TREE1" } } },
  "GET /repos/simetrixch/hostyour-cloud/git/trees/TREE1?recursive=1": { status: 200, body: { truncated, tree: blobs } },
});

describe("github adapter — git-data (reset)", () => {
  it("deletePaths removes only existing paths in one commit + fast-forwards the ref", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({
      ...treeRoutes([
        { path: "clusters/active/s1.example.com.yaml", type: "blob" },
        { path: "README.md", type: "blob" },
      ]),
      "POST /repos/simetrixch/hostyour-cloud/git/trees": { status: 201, body: { sha: "TREE2" } },
      "POST /repos/simetrixch/hostyour-cloud/git/commits": { status: 201, body: { sha: "COMMIT2" } },
      [`PATCH /repos/simetrixch/hostyour-cloud/git/refs/heads/${B}`]: { status: 200, body: {} },
    }));
    const res = await client.deletePaths(B, ["clusters/active/s1.example.com.yaml", "clusters/active/ghost.example.com.yaml"], "msg");
    expect(res.removed).toEqual(["clusters/active/s1.example.com.yaml"]); // ghost absent ⇒ skipped
    expect(res.commitSha).toBe("COMMIT2");
  });

  it("deletePaths is a no-op (commitSha null, no writes) when no path exists on the branch", async () => {
    // No POST/PATCH routes: if the adapter tried to write, stubFetch throws "unexpected fetch".
    const client = createGitHubPlatform(cfg, stubFetch(treeRoutes([{ path: "README.md", type: "blob" }])));
    const res = await client.deletePaths(B, ["clusters/active/s1.example.com.yaml"], "msg");
    expect(res).toEqual({ removed: [], commitSha: null });
  });

  it("deletePaths refuses a blind delete when the tree listing is truncated", async () => {
    const client = createGitHubPlatform(cfg, stubFetch(treeRoutes([{ path: "x", type: "blob" }], true)));
    await expect(client.deletePaths(B, ["x"], "m")).rejects.toThrow(/truncated/);
  });

  it("deletePaths throws when the branch is gone (404 ref)", async () => {
    const client = createGitHubPlatform(cfg, stubFetch({
      [`GET /repos/simetrixch/hostyour-cloud/git/ref/heads/${B}`]: { status: 404, body: { message: "Not Found" } },
    }));
    await expect(client.deletePaths(B, ["x"], "m")).rejects.toThrow(/branch not found/);
  });

  it("listBlobs returns the recursive blob paths (and throws on truncation)", async () => {
    const ok = createGitHubPlatform(cfg, stubFetch(treeRoutes([
      { path: "clusters/active/s1.example.com.yaml", type: "blob" },
      { path: "dir", type: "tree" }, // non-blob filtered out
      { path: "README.md", type: "blob" },
    ])));
    expect(await ok.listBlobs(B)).toEqual(["clusters/active/s1.example.com.yaml", "README.md"]);
    const trunc = createGitHubPlatform(cfg, stubFetch(treeRoutes([{ path: "x", type: "blob" }], true)));
    await expect(trunc.listBlobs(B)).rejects.toThrow(/truncated/);
  });

  it("sends the PAT + content-type on the write requests (auth header wins the merge)", async () => {
    let seen: Record<string, string> | undefined;
    const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
      const u = typeof _url === "string" ? _url : _url.toString();
      const key = `${init?.method ?? "GET"} ${u.replace("https://api.github.com", "")}`;
      if (key === "POST /repos/simetrixch/hostyour-cloud/git/trees") seen = init?.headers as Record<string, string>;
      const routes: Record<string, unknown> = {
        ...treeRoutes([{ path: "clusters/active/s1.example.com.yaml", type: "blob" }]),
        "POST /repos/simetrixch/hostyour-cloud/git/trees": { status: 201, body: { sha: "T2" } },
        "POST /repos/simetrixch/hostyour-cloud/git/commits": { status: 201, body: { sha: "C2" } },
        [`PATCH /repos/simetrixch/hostyour-cloud/git/refs/heads/${B}`]: { status: 200, body: {} },
      };
      const r = routes[key] as { status: number; body?: unknown } | undefined;
      if (!r) throw new Error(`unexpected fetch: ${key}`);
      return { ok: r.status < 300, status: r.status, statusText: String(r.status), json: async () => r.body ?? null } as Response;
    }) as unknown as typeof fetch;
    const client = createGitHubPlatform(cfg, capture);
    await client.deletePaths(B, ["clusters/active/s1.example.com.yaml"], "m");
    expect(seen?.authorization).toBe("Bearer tkn");
    expect(seen?.["content-type"]).toBe("application/json");
  });
});
