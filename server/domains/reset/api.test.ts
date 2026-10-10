import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { EmergencyStore, createAdminSocketApp } from "../access/emergency.ts";
import { registerResetRoutes } from "./api.ts";
import { GitHubPlatformError, type GitHubPlatform, type BranchRef } from "../../adapters/github-platform/port.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ResetResult } from "../../../shared/api-types.ts";

// DATA_DIR is set per test to the temp dir that holds that test's database. This module-level parse
// is only for the logger.
const baseEnv = {
  ...REQUIRED_ENV,
  PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test",
  DATA_DIR: tmpdir(), LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_STAGE: "prod",
  GITHUB_REPO: "example/platform", GITHUB_WRITE_PAT: "pat",
};
const logger = createLogger(parseConfig(baseEnv as NodeJS.ProcessEnv));

interface FakeOpts {
  branches?: BranchRef[];
  blobs?: string[];
  failDelete?: string[];
  failList?: boolean;
  failPaths?: boolean;
  /** Runs on every GitHub call with that call's log label: reads the LOCAL state at that moment
   *  (which is how "the audit entry lands last" becomes a fact in the log), or changes it between
   *  two calls. */
  onCall?: (label: string) => void;
}
function fakeGitHub(opts: FakeOpts = {}) {
  const log: string[] = [];
  const call = (label: string): void => {
    log.push(label);
    opts.onCall?.(label);
  };
  const branches = opts.branches ?? [{ name: "master", sha: "m1" }, { name: "m1.example.com", sha: "c1" }, { name: "s1.example.com", sha: "f1" }];
  const client: GitHubPlatform = {
    listBranches: async () => {
      call("list");
      if (opts.failList) throw new GitHubPlatformError("list boom", 500);
      return branches;
    },
    compare: async () => ({ aheadBy: 0, behindBy: 0, files: [], truncated: false }),
    deleteBranch: async (name: string) => {
      call(`del:${name}`);
      if (opts.failDelete?.includes(name)) throw new GitHubPlatformError("delete boom", 500);
    },
    deletePaths: async (_branch: string, paths: string[]) => {
      call(`paths:${paths.join(",")}`);
      if (opts.failPaths) throw new GitHubPlatformError("paths boom", 500);
      return { removed: paths, commitSha: "PC1" };
    },
    listBlobs: async () => {
      call("blobs");
      return opts.blobs ?? [];
    },
  };
  return { client, log };
}

describe("reset API (POST /api/reset)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(github: GitHubPlatform | undefined) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-reset-api-"));
    dirs.push(dir);
    const config = parseConfig({ ...baseEnv, DATA_DIR: dir } as NodeJS.ProcessEnv);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    // a master row (so masterFqdn derives m1.example.com) + a slave row (whose rows a reset keeps)
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status, owner, modified_by) VALUES ('srv_m','m1','m1.example.com','m1','master','ready', 'op_system', 'op_system')").run();
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status, owner, modified_by) VALUES ('srv_s','s1','5.6.7.8','root','slave','ready', 'op_system', 'op_system')").run();
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerResetRoutes(a, { config, db: db.db, sqlite: db.sqlite, logger, github }),
    });
    return { app, db, session };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function cookie(session: SessionCodec, via: "oidc" | "emergency" = "oidc"): Promise<string> {
    return session.mint({ sub: "op_test", groups: ["admins"], via });
  }
  const post = async (app: Hono<AppEnv>, ck: string, body: unknown): Promise<Response> =>
    app.request("/api/reset", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${ck}`, "content-type": "application/json", origin: "https://m1.example" }, body: JSON.stringify(body) });
  const auditRefusals = (db: DbHandle): number =>
    (db.sqlite.prepare("SELECT count(*) AS c FROM audit WHERE action='manager.reset.refused'").get() as { c: number }).c;
  const rowCount = (db: DbHandle, table: string): number =>
    (db.sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  const resetAuditDetail = (db: DbHandle): string =>
    JSON.stringify((db.sqlite.prepare("SELECT detail_json AS d FROM audit WHERE action='manager.reset'").get() as { d: unknown } | undefined)?.d ?? null);

  const req = { confirm: "RESET", deleteBranches: [] as string[], includeMaster: false };

  // The Manager's database is infrastructure and is never reset: no request may empty a table of it.
  const rowsPerTable = (db: DbHandle): Record<string, number> => {
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, rowCount(db, name)]));
  };

  it("PLANTED DEFECT: refuses a request that still asks for the database wipe, with nothing removed", async () => {
    const { client, log } = fakeGitHub({ blobs: ["clusters/active/s1.example.com.yaml"] });
    const { app, db, session } = make(client);
    const before = rowsPerTable(db);

    const res = await post(app, await cookie(session), { ...req, wipeDb: true, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/wipeDb/);
    expect(log).toEqual([]);
    expect(rowsPerTable(db)).toEqual({ ...before, audit: before.audit! + 1 });
    expect(auditRefusals(db)).toBe(1);
  });

  it("leaves every row of the database where it was after deleting an install branch", async () => {
    const { client, log } = fakeGitHub({ blobs: ["clusters/active/s1.example.com.yaml"] });
    const { app, db, session } = make(client);
    const before = rowsPerTable(db);

    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ResetResult).ok).toBe(true);
    expect(log).toContain("del:s1.example.com");
    // The one row a reset adds is its own audit entry.
    expect(rowsPerTable(db)).toEqual({ ...before, audit: before.audit! + 1 });
  });

  it("refuses a reset that selects no branch, because the database is never part of one", async () => {
    const { client, log } = fakeGitHub();
    const { app, db, session } = make(client);
    const res = await post(app, await cookie(session), req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/no branches are selected/);
    expect(log).toEqual([]);
    expect(auditRefusals(db)).toBe(1);
  });

  it("refuses (and audits) a wrong confirm token", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    const res = await post(app, await cookie(session), { ...req, confirm: "reset", deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(400);
    expect(auditRefusals(db)).toBe(1);
  });

  it("refuses master, non-install shapes, and m1 without the opt-in — each audited", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    const ck = await cookie(session);
    expect((await post(app, ck, { ...req, deleteBranches: ["master"] })).status).toBe(400);
    expect((await post(app, ck, { ...req, deleteBranches: ["feature-x"] })).status).toBe(400);
    expect((await post(app, ck, { ...req, deleteBranches: ["m1.example.com"] })).status).toBe(400); // opt-in off
    expect(auditRefusals(db)).toBe(3);
  });

  it("501 when branch deletion is requested but GitHub is not configured", async () => {
    const { app, session } = make(undefined);
    expect((await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] })).status).toBe(501);
  });

  it("409 when a run is in flight", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    db.sqlite.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, owner, modified_by) VALUES ('r','noop','self','c','{}','{}','running','op_system','op_system')").run();
    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(409);
    expect(auditRefusals(db)).toBe(1);
  });

  it("refuses a break-glass (emergency) session", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    const res = await post(app, await cookie(session, "emergency"), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(403);
    expect(auditRefusals(db)).toBe(1);
  });

  // The same refusal reached the way a PROGRAM reaches it: minted by the real admin.sock route,
  // carried as a bearer, past the CSRF exemption bearers get. The test above hand-mints `via:
  // "emergency"` and so only proves the line reads that word; this one proves the word is what the
  // programmatic door actually hands out, which is the claim `via` being a two-value union rests
  // on. Without it the chain runs through two assertions in two files and a reader has to join them.
  it("refuses a session taken off the admin.sock — the programmatic door inherits the same refusal", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    const sockApp = createAdminSocketApp({
      config: parseConfig({ ...baseEnv, DATA_DIR: tmpdir() } as NodeJS.ProcessEnv),
      session, store: new EmergencyStore(), db: db.db, logger,
    });
    const { session: bearer } = (await (await sockApp.request("/auth/session", { method: "POST" })).json()) as { session: string };

    const res = await app.request("/api/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ ...req, deleteBranches: ["s1.example.com"] }),
    });
    expect(res.status).toBe(403);
    expect(auditRefusals(db)).toBe(1);
    // The refusal names the authority, which is the only thing the route read.
    const refusal = db.sqlite.prepare("SELECT owner, detail_json AS d FROM audit WHERE action='manager.reset.refused'").get() as { owner: string; d: unknown };
    expect(refusal.owner).toBe("op_emergency");
    expect(JSON.parse(String(refusal.d)) as Record<string, unknown>).toMatchObject({ via: "emergency" });
  });

  it("removes cluster maps BEFORE deleting branches, captures the sha, reconciles orphans", async () => {
    const { client, log } = fakeGitHub({
      branches: [{ name: "master", sha: "m1" }, { name: "m1.example.com", sha: "c1" }, { name: "s1.example.com", sha: "f1" }],
      blobs: ["clusters/active/s1.example.com.yaml", "clusters/active/ghost.example.com.yaml", "README.md"],
    });
    const { app, session } = make(client);
    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    // ordering: pointer commit first, branch delete second
    const acted = log.filter((l) => l.startsWith("paths:") || l.startsWith("del:"));
    expect(acted[0]?.startsWith("paths:")).toBe(true);
    expect(acted[1]).toBe("del:s1.example.com");
    // orphan (ghost, whose branch is absent from the repo) reconciled alongside the selected one
    // The maps live on the books branch — the master cluster's own install branch — never on the trunk.
    expect(body.pointers.branch).toBe("m1.example.com");
    expect(body.pointers.removed).toContain("clusters/active/ghost.example.com.yaml");
    expect(body.pointers.removed).toContain("clusters/active/s1.example.com.yaml");
    // the master's own map stands: its branch exists and it was not selected for deletion.
    expect(body.pointers.removed).not.toContain("clusters/active/m1.example.com.yaml");
    // sha captured as the undo anchor
    expect(body.branches[0]).toMatchObject({ branch: "s1.example.com", ok: true, sha: "f1" });
    expect(body.ok).toBe(true);
  });

  it("a GitHub delete failure answers ok:false with the failure per branch, and the audit entry still lands", async () => {
    const { client } = fakeGitHub({ failDelete: ["s1.example.com"] });
    const { app, db, session } = make(client);
    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(false); // the branch delete failed
    expect(body.branches[0]?.error).toMatch(/delete boom/);
    expect(resetAuditDetail(db)).toMatch(/delete boom/);
    expect(rowCount(db, "servers")).toBe(2);
  });

  // The order IS the safety property: the branch deletes are the one act that cannot be taken back,
  // so every step that can still refuse has to be in front of them, and the audit entry, which
  // records their outcome, behind them.
  it("pins the order: list, maps, branches, and the audit entry LAST", async () => {
    let resetAudits = (): number => -1;
    const seen: string[] = [];
    const { client } = fakeGitHub({
      blobs: ["clusters/active/s1.example.com.yaml"],
      onCall: (label) => seen.push(`${label} audit=${resetAudits()}`),
    });
    const { app, db, session } = make(client);
    resetAudits = () => (db.sqlite.prepare("SELECT count(*) AS c FROM audit WHERE action='manager.reset'").get() as { c: number }).c;

    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(200);
    // No GitHub call saw the audit entry, and the map removal is ahead of the branch it describes.
    expect(seen).toEqual([
      "list audit=0",
      "blobs audit=0",
      "paths:clusters/active/s1.example.com.yaml audit=0",
      "del:s1.example.com audit=0",
    ]);
    expect(((await res.json()) as ResetResult).ok).toBe(true);
    expect(resetAudits()).toBe(1);
  });

  it("a failed cluster-map cleanup refuses before any branch is deleted", async () => {
    const { client, log } = fakeGitHub({ blobs: ["clusters/active/s1.example.com.yaml"], failPaths: true });
    const { app, db, session } = make(client);

    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toMatch(/cluster-map cleanup on m1\.example\.com failed \(paths boom\)/);
    expect(log).toEqual(["list", "blobs", "paths:clusters/active/s1.example.com.yaml"]); // no del:
    expect(rowCount(db, "servers")).toBe(2);
    expect(auditRefusals(db)).toBe(1);
  });

  it("refuses a branch delete when the listing failed — no sha, no way back", async () => {
    const { client, log } = fakeGitHub({ failList: true });
    const { app, db, session } = make(client);

    const refused = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { message: string }).message).toMatch(/sha was not captured first/);
    expect(log).toEqual(["list"]);
    expect(auditRefusals(db)).toBe(1);
  });

  it("an audit entry that cannot be written is logged, not thrown — the branch outcomes must still reach the operator", async () => {
    // The audit INSERT runs behind the branch deletes, so a throw there would answer 500 and drop the
    // shas with it.
    let blockAudit = (): void => undefined;
    const { client } = fakeGitHub({
      onCall: (label) => {
        if (label.startsWith("del:")) blockAudit();
      },
    });
    const { app, db, session } = make(client);
    // Armed at the branch delete, behind every refusal, which would write an audit entry of its own.
    blockAudit = () => db.sqlite.exec("CREATE TRIGGER audit_no_insert BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit is unwritable'); END");
    const auditsBefore = rowCount(db, "audit");

    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    expect(body.branches[0]).toMatchObject({ branch: "s1.example.com", ok: true, sha: "f1" });
    expect(rowCount(db, "audit")).toBe(auditsBefore); // the entry really did not land
  });
});
