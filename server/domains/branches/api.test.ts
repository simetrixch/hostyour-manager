import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig, type Config } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerBranchRoutes, classifyBranch } from "./api.ts";
import { GitHubPlatformError, type GitHubPlatform, type BranchRef, type BranchComparison } from "../../adapters/github-platform/github-platform-http.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { BranchesView, BranchDiffView } from "../../../shared/api-types.ts";

const baseEnv = {
  PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test",
  DATA_DIR: "/d", LOG_LEVEL: "silent",
};
const withGitHub = parseConfig({
  ...baseEnv, MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_STAGE: "prod",
  GITHUB_REPO: "simetrixch/hostyour-cloud", GITHUB_WRITE_PAT: "pat",
} as NodeJS.ProcessEnv);
const noMaster = parseConfig({ ...baseEnv, GITHUB_REPO: "simetrixch/hostyour-cloud", GITHUB_WRITE_PAT: "pat" } as NodeJS.ProcessEnv);
const logger = createLogger(withGitHub);

function fakeGitHub(branches: BranchRef[], compareFn: (head: string) => BranchComparison) {
  const calls: string[] = [];
  const client: GitHubPlatform = {
    listBranches: async () => branches,
    compare: async (_base: string, head: string) => { calls.push(head); return compareFn(head); },
    deleteBranch: async () => undefined,
    deletePaths: async () => ({ removed: [], commitSha: null }),
    listBlobs: async () => [],
  };
  return { client, calls };
}

const cmp = (aheadBy: number, files: BranchComparison["files"] = [], truncated = false): BranchComparison =>
  ({ aheadBy, behindBy: 0, files, truncated });

describe("classifyBranch (derive-dont-type)", () => {
  const M = "m1.example.com";
  it("classifies against the master FQDN", () => {
    expect(classifyBranch("master", M)).toBe("master");
    expect(classifyBranch("m1.example.com", M)).toBe("manager");
    expect(classifyBranch("s1.example.com", M)).toBe("slave");
    expect(classifyBranch("feature-x", M)).toBe("other");
    expect(classifyBranch("deep.sub.example.com", M)).toBe("other"); // two extra labels ⇒ not a slave
  });
});

describe("branches API", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  async function make(config: Config, github?: GitHubPlatform): Promise<{ app: Hono<AppEnv>; cookie: string }> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-branch-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerBranchRoutes(a, { db: db.db, config, ...(github ? { github } : {}) }),
    });
    const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
    return { app, cookie };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

  it("lists branches with repo, compares ONLY installer branches, caches by sha", async () => {
    const branches: BranchRef[] = [
      { name: "master", sha: "m1" },
      { name: "m1.example.com", sha: "c1" },
      { name: "s1.example.com", sha: "f1" },
      { name: "feature-x", sha: "x1" },
    ];
    const { client, calls } = fakeGitHub(branches, () => cmp(2, [{ filename: "a", status: "modified", additions: 1, deletions: 0 }]));
    const { app, cookie } = await make(withGitHub, client);

    const body = (await (await app.request("/api/branches", authed(cookie))).json()) as BranchesView;
    expect(body.repo).toBe("simetrixch/hostyour-cloud");
    const byName = Object.fromEntries(body.branches.map((b) => [b.name, b]));
    expect(byName["master"]?.compare).toBeUndefined();
    expect(byName["feature-x"]?.kind).toBe("other");
    expect(byName["feature-x"]?.compare).toBeUndefined();
    expect(byName["m1.example.com"]?.compare).toMatchObject({ aheadBy: 2, changedFiles: 1 });
    expect(byName["s1.example.com"]?.kind).toBe("slave");
    expect(calls.sort()).toEqual(["m1.example.com", "s1.example.com"]); // master + other NOT compared

    // warm cache: same shas ⇒ no new compares
    await app.request("/api/branches", authed(cookie));
    expect(calls).toHaveLength(2);
    // bump a sha ⇒ exactly one extra compare
    branches[2] = { name: "s1.example.com", sha: "f2" };
    await app.request("/api/branches", authed(cookie));
    expect(calls).toHaveLength(3);
  });

  it("diff passes files through and caps oversized patches (keeps counts)", async () => {
    const big = "x".repeat(100_001);
    const { client } = fakeGitHub(
      [{ name: "master", sha: "m1" }, { name: "s1.example.com", sha: "f1" }],
      () => cmp(1, [
        { filename: "small.txt", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@" },
        { filename: "huge.lock", status: "modified", additions: 9, deletions: 9, patch: big },
      ]),
    );
    const { app, cookie } = await make(withGitHub, client);
    const body = (await (await app.request("/api/branches/s1.example.com/diff", authed(cookie))).json()) as BranchDiffView;
    const files = Object.fromEntries(body.files.map((f) => [f.filename, f]));
    expect(files["small.txt"]?.patch).toBe("@@ -1 +1 @@");
    expect(files["huge.lock"]?.patch).toBeUndefined(); // stripped
    expect(files["huge.lock"]?.additions).toBe(9); // counts kept
  });

  it("501 NOT_CONFIGURED when GitHub is absent; 501 when no master FQDN", async () => {
    const unconf = await make(noMaster); // no github client
    expect((await unconf.app.request("/api/branches", authed(unconf.cookie))).status).toBe(501);

    const { client } = fakeGitHub([{ name: "master", sha: "m1" }], () => cmp(0));
    const noMasterApp = await make(noMaster, client); // github present, but no master row + no MASTER_FQDN
    const res = await noMasterApp.app.request("/api/branches", authed(noMasterApp.cookie));
    expect(res.status).toBe(501);
  });

  it("surfaces GitHub failures: 404 → NOT_FOUND, other → UPSTREAM 502 with the message", async () => {
    const branches: BranchRef[] = [{ name: "master", sha: "m1" }, { name: "s1.example.com", sha: "f1" }];
    const notFound = fakeGitHub(branches, () => { throw new GitHubPlatformError("no", 404); });
    const nf = await make(withGitHub, notFound.client);
    expect((await nf.app.request("/api/branches/s1.example.com/diff", authed(nf.cookie))).status).toBe(404);

    const rate = fakeGitHub(branches, () => { throw new GitHubPlatformError("API rate limit exceeded", 403); });
    const rl = await make(withGitHub, rate.client);
    const res = await rl.app.request("/api/branches/s1.example.com/diff", authed(rl.cookie));
    expect(res.status).toBe(502);
    expect((await res.json() as { message: string }).message).toMatch(/rate limit/);
  });
});
