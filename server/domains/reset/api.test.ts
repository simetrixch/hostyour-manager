import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { EmergencyStore, createAdminSocketApp } from "../access/emergency.ts";
import { registerResetRoutes } from "./api.ts";
import { GitHubPlatformError, type GitHubPlatform, type BranchRef } from "../../adapters/github-platform/github-platform-http.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ResetResult } from "../../../shared/api-types.ts";

// DATA_DIR is set PER-TEST to the temp dir below — wipeDb calls backupManagerDb (VACUUM INTO
// $DATA_DIR/backups), so it must be a real writable path on every OS (a fake "/d" happens to work
// on Windows but not on Linux CI). This module-level parse is only for the logger.
const baseEnv = {
  PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test",
  DATA_DIR: tmpdir(), LOG_LEVEL: "silent",
  MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_STAGE: "prod",
  GITHUB_REPO: "simetrixch/hostyour-cloud", GITHUB_WRITE_PAT: "pat",
};
const logger = createLogger(parseConfig(baseEnv as NodeJS.ProcessEnv));

interface FakeOpts {
  branches?: BranchRef[];
  blobs?: string[];
  failDelete?: string[];
  failList?: boolean;
  failPaths?: boolean;
  /** Runs on every GitHub call with that call's log label. Two uses: read the LOCAL state at that
   *  moment (which is how "the wipe runs last" becomes a fact in the log), or change it — the only
   *  way to make the wipe fail after its rehearsal has already passed. */
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

// A table WIPE_ORDER does not name, holding a row that RESTRICTs a server — the shape that made the
// wipe throw after the install branches were already deleted.
function addUnwipedChildRow(db: DbHandle): void {
  db.sqlite.exec("CREATE TABLE stragglers (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id))");
  db.sqlite.prepare("INSERT INTO stragglers (id, server_id) VALUES ('str_1','srv_s')").run();
}

describe("reset API (POST /api/reset)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(github: GitHubPlatform | undefined, over: { reseed?: () => Promise<void> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-reset-api-"));
    dirs.push(dir);
    const config = parseConfig({ ...baseEnv, DATA_DIR: dir } as NodeJS.ProcessEnv);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    // a master row (so masterFqdn derives m1.example.com) + a slave row (to prove the wipe)
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES ('srv_m','m1','m1.example.com','m1','master','ready')").run();
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES ('srv_s','s1','5.6.7.8','root','slave','ready')").run();
    const store = new CredentialStore({ db: db.db, logger });
    const session = new SessionCodec(db.db, config);
    let reseedCalledWithAuditCount = -1;
    const reseedMaster = over.reseed ?? (async () => {
      reseedCalledWithAuditCount = (db.sqlite.prepare("SELECT count(*) AS c FROM audit WHERE action='manager.reset'").get() as { c: number }).c;
    });
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerResetRoutes(a, { config, db: db.db, sqlite: db.sqlite, store, logger, github, reseedMaster }),
    });
    return { app, db, session, reseededAt: () => reseedCalledWithAuditCount };
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
  /** The wipe's failure, which lives on the `wiped: false` arm only. */
  const dbError = (r: ResetResult): string | undefined => (r.db.wiped ? undefined : r.db.error);
  /** The pre-wipe snapshot's path, which lives on the `wiped: true` arm only. */
  const backupFile = (r: ResetResult): string => (r.db.wiped ? r.db.backupFile : "");

  const req = { confirm: "RESET", wipeDb: false, deleteBranches: [] as string[], includeMaster: false };

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

  it("409 when a run is in flight (even without wipeDb)", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    db.sqlite.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES ('r','noop','self','c','{}','{}','running','op_system')").run();
    const res = await post(app, await cookie(session), { ...req, deleteBranches: ["s1.example.com"] });
    expect(res.status).toBe(409);
    expect(auditRefusals(db)).toBe(1);
  });

  it("refuses a break-glass (emergency) session", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client);
    const res = await post(app, await cookie(session, "emergency"), { ...req, wipeDb: true });
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
      body: JSON.stringify({ ...req, wipeDb: true }),
    });
    expect(res.status).toBe(403);
    expect(auditRefusals(db)).toBe(1);
    // The refusal names the authority, which is the only thing the route read.
    const refusal = db.sqlite.prepare("SELECT actor, detail_json AS d FROM audit WHERE action='manager.reset.refused'").get() as { actor: string; d: unknown };
    expect(refusal.actor).toBe("op_emergency");
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
    expect(body.pointers?.branch).toBe("m1.example.com");
    expect(body.pointers?.removed).toContain("clusters/active/ghost.example.com.yaml");
    expect(body.pointers?.removed).toContain("clusters/active/s1.example.com.yaml");
    // the master's own map stands: its branch exists and it was not selected for deletion.
    expect(body.pointers?.removed).not.toContain("clusters/active/m1.example.com.yaml");
    // sha captured as the undo anchor
    expect(body.branches[0]).toMatchObject({ branch: "s1.example.com", ok: true, sha: "f1" });
    expect(body.ok).toBe(true);
  });

  it("a GitHub delete failure ⇒ ok:false, but the DB wipe still runs; audit precedes the reseed", async () => {
    const { client } = fakeGitHub({ failDelete: ["s1.example.com"] });
    const { app, db, session, reseededAt } = make(client);
    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(false); // the branch delete failed
    expect(body.branches[0]?.error).toMatch(/delete boom/);
    // wipe still ran: servers gone, master re-seed invoked, and it saw the audit row already written
    expect(body.db.wiped).toBe(true);
    expect((db.sqlite.prepare("SELECT count(*) AS c FROM servers").get() as { c: number }).c).toBe(0);
    expect(body.reseeded).toBe(true);
    expect(reseededAt()).toBe(1); // audit 'manager.reset' existed BEFORE reseedMaster ran
  });

  // The order IS the safety property: the branch deletes are the one act that cannot be taken back,
  // so every step that can still refuse has to be in front of them. The tests below pin both sides:
  // where each refusal lands, and what survives the one failure that can still arrive too late.
  it("pins the order: list, maps, branches, and the wipe LAST — every GitHub call sees the DB whole", async () => {
    let liveServers = (): number => -1;
    const seen: string[] = [];
    const { client } = fakeGitHub({
      blobs: ["clusters/active/s1.example.com.yaml"],
      onCall: (label) => seen.push(`${label} servers=${liveServers()}`),
    });
    const { app, db, session } = make(client);
    liveServers = () => rowCount(db, "servers");

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    expect(res.status).toBe(200);
    // Both server rows were still standing at every GitHub call, so the wipe is behind all of them —
    // and the map removal is ahead of the branch it describes.
    expect(seen).toEqual([
      "list servers=2",
      "blobs servers=2",
      "paths:clusters/active/s1.example.com.yaml servers=2",
      "del:s1.example.com servers=2",
    ]);
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(true);
    expect(body.db.wiped).toBe(true);
    expect(rowCount(db, "servers")).toBe(0);
  });

  it("a wipe that cannot run refuses after the listing and before anything is removed", async () => {
    const { client, log } = fakeGitHub({ blobs: ["clusters/active/s1.example.com.yaml"] });
    const { app, db, session } = make(client);
    addUnwipedChildRow(db);

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toMatch(/the database wipe would fail.*FOREIGN KEY/is);
    // The rehearsal sits between the sha capture and the map removal: the listing happened, nothing
    // after it did.
    expect(log).toEqual(["list"]);
    expect(rowCount(db, "servers")).toBe(2);
    expect(auditRefusals(db)).toBe(1);
  });

  it("a failed cluster-map cleanup refuses before any branch is deleted", async () => {
    const { client, log } = fakeGitHub({ blobs: ["clusters/active/s1.example.com.yaml"], failPaths: true });
    const { app, db, session } = make(client);

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toMatch(/cluster-map cleanup on m1\.example\.com failed \(paths boom\)/);
    expect(log).toEqual(["list", "blobs", "paths:clusters/active/s1.example.com.yaml"]); // no del:
    expect(rowCount(db, "servers")).toBe(2);
    expect(auditRefusals(db)).toBe(1);
  });

  it("refuses a branch delete when the listing failed — no sha, no way back — but still wipes on its own", async () => {
    const { client, log } = fakeGitHub({ failList: true });
    const { app, db, session } = make(client);
    const ck = await cookie(session);

    const refused = await post(app, ck, { ...req, wipeDb: true, deleteBranches: ["s1.example.com"] });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { message: string }).message).toMatch(/sha was not captured first/);
    expect(log).toEqual(["list"]);
    expect(rowCount(db, "servers")).toBe(2);

    // The same failure does not block a database-only reset. It costs only orphan reconciliation, so
    // the map step has nothing it may act on and reports nothing.
    const res = await post(app, ck, { confirm: "RESET", wipeDb: true, deleteBranches: [], includeMaster: false });
    const body = (await res.json()) as ResetResult;
    expect(body.db.wiped).toBe(true);
    expect(body.pointers).toBe(null);
    expect(rowCount(db, "servers")).toBe(0);
  });

  it("a wipe that fails AFTER its rehearsal answers 200, keeps the whole DB, and names what went", async () => {
    // The one failure a rehearsal cannot predict: the offending row lands while the run is between
    // the two, so the wipe throws where nothing above it can be taken back any more.
    let breakTheWipe = (): void => undefined;
    const { client, log } = fakeGitHub({
      blobs: ["clusters/active/s1.example.com.yaml"],
      onCall: (label) => {
        if (label.startsWith("del:")) breakTheWipe();
      },
    });
    const { app, db, session, reseededAt } = make(client);
    breakTheWipe = () => addUnwipedChildRow(db);

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    // NOT a 500: the branch is already gone, and a bare error carries neither that fact nor the sha.
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(false);
    expect(dbError(body)).toMatch(/FOREIGN KEY/i);

    // What survived: the database entire, because the wipe is one transaction that rolled back whole.
    expect(rowCount(db, "servers")).toBe(2);
    expect(rowCount(db, "operators")).toBe(2);
    expect(db.sqlite.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='trigger' AND name='audit_no_delete'").get()).toEqual({ c: 1 });
    // What did not, with the anchor to push it back and the audit entry saying so.
    expect(log).toContain("del:s1.example.com");
    expect(body.branches[0]).toMatchObject({ branch: "s1.example.com", ok: true, sha: "f1" });
    expect(body.pointers?.removed).toEqual(["clusters/active/s1.example.com.yaml"]);
    expect(resetAuditDetail(db)).toMatch(/FOREIGN KEY/i);
    // The reseed re-materializes what the wipe removed and stops the master-reconcile timer on its
    // way in — a database that lost nothing keeps both.
    expect(reseededAt()).toBe(-1);
    expect(body.reseeded).toBe(false);
  });

  it("the backup holds what the wipe destroys — a row that lands during the GitHub calls is in it", async () => {
    // A snapshot is a way back only if it was taken after the last chance to write. Every GitHub call
    // awaits, and nothing across those awaits stops another writer: the master-reconcile timer
    // (boot/seed-master.ts) seals keys into the credential store while the master has not converged,
    // which on a fresh install is exactly when a reset gets run. Taken early, the snapshot would miss
    // such a row while the wipe still destroys it — and for a credential, collectVaultRefs is a fresh
    // read, so its Vault value would go with a row the snapshot cannot restore.
    let landRow = (): void => undefined;
    const { client } = fakeGitHub({
      blobs: ["clusters/active/s1.example.com.yaml"],
      onCall: (label) => {
        if (label.startsWith("del:")) landRow();
      },
    });
    const { app, db, session } = make(client);
    landRow = () => {
      db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES ('srv_late','late','9.9.9.9','root','slave','ready')").run();
    };

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    const body = (await res.json()) as ResetResult;
    expect(body.db.wiped).toBe(true);
    expect(rowCount(db, "servers")).toBe(0); // the wipe took the late row along with the other two

    const backup = new Database(backupFile(body), { readonly: true });
    try {
      expect((backup.prepare("SELECT count(*) AS c FROM servers").get() as { c: number }).c).toBe(3);
    } finally {
      backup.close();
    }
  });

  it("an audit entry that cannot be written is logged, not thrown — the branch outcomes must still reach the operator", async () => {
    // The audit INSERT goes into the table the wipe just emptied, so it can fail on storage the wipe
    // did not need. Behind the branch deletes, a throw would answer 500 and drop the shas with it.
    let blockAudit = (): void => undefined;
    const { client } = fakeGitHub({
      onCall: (label) => {
        if (label.startsWith("del:")) blockAudit();
      },
    });
    const { app, db, session } = make(client);
    // Armed only after the rehearsal has passed: an INSERT guard the wipe neither drops nor recreates.
    blockAudit = () => db.sqlite.exec("CREATE TRIGGER audit_no_insert BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit is unwritable'); END");

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    expect(body.db.wiped).toBe(true);
    expect(body.branches[0]).toMatchObject({ branch: "s1.example.com", ok: true, sha: "f1" });
    expect(rowCount(db, "audit")).toBe(0); // the entry really did not land
    expect(body.reseeded).toBe(true); // and the step behind it still ran
  });

  it("a re-seed that fails is reported, not thrown — the branch outcomes must reach the operator", async () => {
    const { client } = fakeGitHub();
    const { app, db, session } = make(client, {
      reseed: async () => {
        throw new Error("reseed boom");
      },
    });

    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: ["s1.example.com"], includeMaster: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    expect(body.db.wiped).toBe(true);
    expect(body.branches[0]).toMatchObject({ branch: "s1.example.com", ok: true, sha: "f1" });
    expect(body.reseeded).toBe(false);
    expect(rowCount(db, "servers")).toBe(0);
  });

  it("wipeDb-only (no branches) wipes the cluster state without touching GitHub", async () => {
    const { client, log } = fakeGitHub();
    const { app, db, session } = make(client);
    const res = await post(app, await cookie(session), { confirm: "RESET", wipeDb: true, deleteBranches: [], includeMaster: false });
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(true);
    expect(body.db.wiped).toBe(true);
    expect((db.sqlite.prepare("SELECT count(*) AS c FROM servers").get() as { c: number }).c).toBe(0);
    expect(log.filter((l) => l.startsWith("del:"))).toEqual([]); // no branch deletes
  });
});
