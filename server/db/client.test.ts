import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, type DbHandle } from "./client.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

describe("openDb — migration phase + append-only invariants", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("migrates a fresh DB with foreign keys on and integrity ok", () => {
    const { sqlite } = fresh();
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("re-opens idempotently (migrate is a no-op the second time)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const file = join(dir, "manager.db");
    const h1 = openDb(file);
    handles.push(h1);
    h1.sqlite.close();
    expect(() => {
      handles.push(openDb(file));
    }).not.toThrow();
  });

  // A database built by the BASELINE ALONE — what every installation before hostyour-manager#222
  // stands on — is carried forward by the migrations that follow it, and the baseline is never run
  // again against it (#222: a re-stamped baseline died on `table audit already exists`).
  // Its own timeout, because it applies every migration to a database file: about 1 s alone, and
  // 5.4 s once in a full parallel run, which the default 5 s turned into a failure.
  it("carries a database built by the baseline alone forward: every later migration applies, the baseline stays applied once", { timeout: 20_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    // The baseline alone, as a migrations folder of its own: the same 0000 file, a journal naming only it.
    const baselineOnly = join(dir, "baseline-only");
    mkdirSync(join(baselineOnly, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_baseline", "0001_organisation-identities", "0002_apps-updated-at", "0003_credential-subject-purpose", "0004_credential-subject-required", "0005_credential-subject-owner", "0006_apps-no-repo-credential", "0007_apps-dkim-public-key", "0008_clusters-name", "0009_tenants-routing", "0010_tenants-own-domain", "0011_tenants-own-domain-redirects", "0012_tenants-approved-tags", "0013_unit-sizes-to-unit", "0014_tenants-sender-domain", "0015_deploy-repository-names", "0016_secret-writes", "0017_unit-backups", "0018_tenant-follow-releases", "0019_tenant-nests-under", "0020_tenant-app-site", "0021_tenant-size", "0022_tenant-own-domain-aliases", "0023_tenant-display-name", "0024_revoked-sessions", "0025_drop-per-app-google-translation-book", "0026_drop-tenants-routing", "0027_stamp-runs-and-audit", "0028_stamp-inventory", "0029_stamp-operators-and-credentials", "0030_stamp-dns-secret-and-backup-books", "0031_tenant-identity-provider-path"]);
    writeFileSync(join(baselineOnly, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    copyFileSync(join(MIGRATIONS_DIR, "0000_baseline.sql"), join(baselineOnly, "0000_baseline.sql"));
    const file = join(dir, "manager.db");
    const standing = new Database(file);
    migrate(drizzle(standing), { migrationsFolder: baselineOnly });
    expect(standing.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organisation_identities'").all()).toEqual([]);
    // The rows a standing installation carries: a table a migration REBUILDS or ALTERS must hold one,
    // or the test proves nothing about the installation (#229: an ADD COLUMN with a non-constant
    // default passes on an empty `apps` and dies on the first one with rows). Every shape 0003
    // derives an owner and a purpose from is among the credentials.
    standing.prepare("INSERT INTO servers (id, name, host, ssh_user) VALUES ('srv_1', 's1', '10.0.0.1', 'digi1')").run();
    standing.prepare("INSERT INTO clusters (id, server_id, stage, domain) VALUES ('cl_1', 'srv_1', 'prod', 's1.example.com')").run();
    standing.prepare("INSERT INTO apps (id, cluster_id, name, stage, host, created_at) VALUES ('app_1', 'cl_1', 'post', 'prod', 'post.example.com', 1700000000000)").run();
    standing.prepare("INSERT INTO tenants (id, cluster_id, guid, subdomain, stage, identity_provider, members) VALUES ('tnt_1', 'cl_1', 'abcdefghjkmn', 'acme', 'prod', 'idp', '[\"idp\"]')").run();
    const cred = standing.prepare("INSERT INTO credentials (id, kind, label, server_id, encrypted_blob, fingerprint) VALUES (?,?,?,?,'plain:v0:eA==',?)");
    cred.run("cred_key", "ssh_key", "SSH key for s1", "srv_1", "SHA256:key");
    cred.run("cred_pw", "other", "password for s1", "srv_1", "bootstrap-password");
    cred.run("cred_jwt", "other", "s1 reviewer JWT", "srv_1", "sha256:jwt");
    cred.run("cred_bearer", "kubeconfig", "s1 cluster bearer (argocd-manager)", "srv_1", "sha256:bearer");
    cred.run("cred_pat_unit", "pat", "repository PAT (acme)", null, "sha256:unit");
    cred.run("cred_app_unit", "github-app", "github-app (post)", null, "sha256:app");
    standing.prepare("INSERT INTO unit_sizes (component, name, requests_cpu, requests_memory, limits_cpu, limits_memory, pods, persistent_volume_claims) VALUES ('base', 'small', '900m', '1Gi', '2', '2Gi', 10, 5)").run();
    // The runs 0015 renames the deploy repository in: two that can still act, one succeeded (a record
    // that keeps what it froze), one that never froze the key, and a lock without the prefix.
    const run = standing.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?, 'noop', 'cluster', 'cl_1', ?, ?, ?, 'op_system')");
    const frozenParams = JSON.stringify({ guid: "abcdefghjkmn", catalogRepoUrl: "https://github.com/acme/acme-deploy.git" });
    const frozenPlan = JSON.stringify({ locks: [{ resource: "git-branch", key: "catalog@m1.example.com" }, { resource: "master-kube", key: "m" }], planHash: "h" });
    run.run("run_planned", frozenParams, frozenPlan, "planned");
    run.run("run_approved", frozenParams, frozenPlan, "approved");
    run.run("run_done", frozenParams, frozenPlan, "succeeded");
    run.run("run_other", JSON.stringify({ guid: "abcdefghjkmn" }), JSON.stringify({ locks: [] }), "planned");
    standing.prepare("INSERT INTO run_locks (resource, key, run_id) VALUES ('git-branch', 'catalog@m1.example.com', 'run_approved'), ('git-branch', 'm1.example.com', 'run_approved')").run();
    standing.close();
    // Opened by the Manager: the migrator applies 0001 onward.
    const h = openDb(file);
    handles.push(h);
    expect(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organisation_identities'").all()).toEqual([]); // 0004 dropped it again
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: journal.entries.length });
    expect(h.sqlite.prepare("SELECT id, creation, modified FROM apps").all()).toEqual([{ id: "app_1", creation: 1700000000000, modified: 1700000000000 }]); // 0002: carried, updated_at = created_at; 0028 renames both
    expect(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'apps' AND name NOT LIKE 'sqlite_%'").all()).toEqual([{ name: "apps_name_stage_uq" }]);
    expect(h.sqlite.prepare("SELECT name FROM pragma_table_info('credentials') WHERE name = 'server_id'").all()).toEqual([]); // 0004
    expect(h.sqlite.prepare("SELECT name FROM pragma_table_info('apps') WHERE name = 'repo_credential_id'").all()).toEqual([]); // 0006
    expect(h.sqlite.prepare("SELECT id, dkim_public_key FROM apps").all()).toEqual([{ id: "app_1", dkim_public_key: null }]); // 0007: carried, no key
    expect(h.sqlite.prepare("SELECT id, domain, name FROM clusters").all()).toEqual([{ id: "cl_1", domain: "s1.example.com", name: "s1" }]); // 0008: carried, named after its first label
    expect(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clusters' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      .toEqual([{ name: "clusters_domain_uq" }, { name: "clusters_name_uq" }, { name: "clusters_server_uq" }, { name: "clusters_slave_id_uq" }]);
    expect(h.sqlite.prepare("SELECT name FROM pragma_table_info('tenants') WHERE name = 'routing'").all()).toEqual([]); // 0009 added it, 0026 dropped it
    expect(h.sqlite.prepare("SELECT id, own_domain FROM tenants").all()).toEqual([{ id: "tnt_1", own_domain: "" }]); // 0010: carried, at its zone
    expect(h.sqlite.prepare("SELECT id, own_domain_redirects FROM tenants").all()).toEqual([{ id: "tnt_1", own_domain_redirects: "[]" }]); // 0011: carried, none
    expect(h.sqlite.prepare("SELECT id, approved_tags FROM tenants").all()).toEqual([{ id: "tnt_1", approved_tags: "{}" }]); // 0012: carried, none approved
    expect(h.sqlite.prepare("SELECT id, sender_domain FROM tenants").all()).toEqual([{ id: "tnt_1", sender_domain: "" }]); // 0014: carried, sends as the platform
    expect(h.sqlite.prepare("SELECT id, identity_provider_path FROM tenants").all()).toEqual([{ id: "tnt_1", identity_provider_path: "/idp" }]); // 0031: carried at the path it was addressed at
    expect(h.sqlite.prepare("SELECT component, name, requests_cpu FROM unit_sizes").all()).toEqual([{ component: "base", name: "small", requests_cpu: "900m" }]); // 0013: carried, for the unit plugin to adopt
    // 0015: the runs that can still act carry deployRepoUrl and deploy@<books>; the record and the rest do not move.
    const runRows = h.sqlite.prepare("SELECT id, params_json, plan_json FROM runs ORDER BY id").all() as { id: string; params_json: string; plan_json: string }[];
    expect(runRows.map((r) => [r.id, JSON.parse(r.params_json), (JSON.parse(r.plan_json) as { locks: { key: string }[] }).locks.map((l) => l.key)])).toEqual([
      ["run_approved", { guid: "abcdefghjkmn", deployRepoUrl: "https://github.com/acme/acme-deploy.git" }, ["deploy@m1.example.com", "m"]],
      ["run_done", { guid: "abcdefghjkmn", catalogRepoUrl: "https://github.com/acme/acme-deploy.git" }, ["catalog@m1.example.com", "m"]],
      ["run_other", { guid: "abcdefghjkmn" }, []],
      ["run_planned", { guid: "abcdefghjkmn", deployRepoUrl: "https://github.com/acme/acme-deploy.git" }, ["deploy@m1.example.com", "m"]],
    ]);
    expect(h.sqlite.prepare("SELECT key FROM run_locks ORDER BY key").all()).toEqual([{ key: "deploy@m1.example.com" }, { key: "m1.example.com" }]);
    // 0006 took the two unit rows (a unit has no row of its own); the server's four stay.
    expect(h.sqlite.prepare("SELECT id, subject_kind, subject_id, purpose FROM credentials ORDER BY id").all()).toEqual([
      { id: "cred_bearer", subject_kind: "server", subject_id: "srv_1", purpose: "cluster-bearer" },
      { id: "cred_jwt", subject_kind: "server", subject_id: "srv_1", purpose: "reviewer-jwt" },
      { id: "cred_key", subject_kind: "server", subject_id: "srv_1", purpose: "ssh-key" },
      { id: "cred_pw", subject_kind: "server", subject_id: "srv_1", purpose: "bootstrap-password" },
    ]);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  // An installation that stood on 0001 recorded an owner's identity as ids in a table of its
  // own; 0003 turns those ids into the owner and purpose of the rows themselves (#225).
  it("carries an owner identity recorded under 0001 into the rows' own owner and purpose", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const upTo0002 = join(dir, "up-to-0002");
    mkdirSync(join(upTo0002, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    writeFileSync(join(upTo0002, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }));
    for (const e of journal.entries.slice(0, 3)) copyFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(upTo0002, `${e.tag}.sql`));
    const file = join(dir, "manager.db");
    const standing = new Database(file);
    migrate(drizzle(standing), { migrationsFolder: upTo0002 });
    const cred = standing.prepare("INSERT INTO credentials (id, kind, label, encrypted_blob, fingerprint) VALUES (?,'pat',?,'plain:v0:eA==',?)");
    cred.run("cred_pkg", "packages reader (example-owner)", "sha256:pkg");
    cred.run("cred_pat", "repository PAT (example-owner)", "sha256:pat");
    cred.run("cred_pkg_only", "packages reader (acme-org)", "sha256:pkg2");
    standing.prepare("INSERT INTO organisation_identities (org, packages_credential_id, repo_credential_id) VALUES ('example-owner', 'cred_pkg', 'cred_pat'), ('acme-org', 'cred_pkg_only', NULL)").run();
    standing.close();
    const h = openDb(file);
    handles.push(h);
    expect(h.sqlite.prepare("SELECT id, subject_kind, subject_id, purpose FROM credentials ORDER BY id").all()).toEqual([
      { id: "cred_pat", subject_kind: "owner", subject_id: "example-owner", purpose: "repository-pat" },
      { id: "cred_pkg", subject_kind: "owner", subject_id: "example-owner", purpose: "packages-reader" },
      { id: "cred_pkg_only", subject_kind: "owner", subject_id: "acme-org", purpose: "packages-reader" },
    ]);
    expect(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organisation_identities'").all()).toEqual([]);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  // A tenant_apps row records no site before 0020, so a website removed since read as an offboarded
  // app; 0020 fills the site of every row an add-app run added as a website, off that run's params.
  it("backfills the site of a website's row from the run that added it, and leaves an app's row null", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const upTo0019 = join(dir, "up-to-0019");
    mkdirSync(join(upTo0019, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const before = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === "0020_tenant-app-site"));
    writeFileSync(join(upTo0019, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    for (const e of before) copyFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(upTo0019, `${e.tag}.sql`));
    const file = join(dir, "manager.db");
    const standing = new Database(file);
    migrate(drizzle(standing), { migrationsFolder: upTo0019 });
    standing.prepare("INSERT INTO servers (id, name, host, ssh_user) VALUES ('srv_1', 's1', '10.0.0.1', 'root')").run();
    standing.prepare("INSERT INTO clusters (id, server_id, stage, domain, name) VALUES ('cls_1', 'srv_1', 'prod', 's1.example', 's1')").run();
    standing.prepare("INSERT INTO tenants (id, cluster_id, guid, subdomain, stage, identity_provider, members) VALUES ('tnt_1', 'cls_1', 'zsjs023ctne0', 'show', 'prod', 'auth', '[\"auth\"]')").run();
    standing.prepare("INSERT INTO tenant_apps (id, tenant_id, name, status) VALUES ('tna_web', 'tnt_1', 'cycleshop-show-digitapla-a9665c', 'offboarded'), ('tna_app', 'tnt_1', 'workshop', 'active')").run();
    const run = standing.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by, created_at) VALUES (?, 'tenant-add-app', 'tenant', 'tnt_1', ?, '{}', 'succeeded', 'op_system', ?)");
    // The newest add-app run of the row wins: an older one named another site.
    run.run("run_web_old", JSON.stringify({ tenantId: "tnt_1", app: "cycleshop-show-digitapla-a9665c", website: { folder: "web", site: "old-site", domain: "old.show.example" } }), 1);
    run.run("run_web", JSON.stringify({ tenantId: "tnt_1", app: "cycleshop-show-digitapla-a9665c", website: { folder: "web", site: "cycleshop", domain: "cycleshop.show.example" } }), 3);
    run.run("run_app", JSON.stringify({ tenantId: "tnt_1", app: "workshop" }), 2);
    // Neither a run of another kind nor another tenant's website of the same name marks the app's row.
    standing.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by, created_at) VALUES ('run_kind', 'tenant-set-website-site', 'tenant', 'tnt_1', ?, '{}', 'succeeded', 'op_system', 4)").run(JSON.stringify({ tenantId: "tnt_1", app: "workshop", website: { site: "wrong-kind" } }));
    run.run("run_other", JSON.stringify({ tenantId: "tnt_2", app: "workshop", website: { folder: "web", site: "other-tenant", domain: "w.other.example" } }), 5);
    standing.close();
    const h = openDb(file);
    handles.push(h);
    expect(h.sqlite.prepare("SELECT id, site FROM tenant_apps ORDER BY id").all()).toEqual([
      { id: "tna_app", site: null },
      { id: "tna_web", site: "cycleshop" },
    ]);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("enforces append-only on events and audit (UPDATE and DELETE both raise)", () => {
    const { sqlite } = fresh();
    sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, owner, modified_by) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("run_x", "noop", "server", "srv_x", "{}", "{}", "planned", "op_system", "op_system");
    sqlite.prepare("INSERT INTO events (id, run_id, stream, seq, text, owner, modified_by) VALUES (?,?,?,?,?,?,?)").run("evt_x", "run_x", "stdout", 0, "hello", "op_system", "op_system");
    sqlite.prepare("INSERT INTO audit (id, action, owner, modified_by) VALUES (?,?,?,?)").run("aud_x", "run.started", "op_system", "op_system");

    expect(() => sqlite.prepare("UPDATE events SET text='y' WHERE id='evt_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM events WHERE id='evt_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("UPDATE audit SET action='x' WHERE id='aud_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM audit WHERE id='aud_x'").run()).toThrow(/append-only/);
  });

  it("the runs plan_json CHECK rejects a planned run with no plan, but allows a failed one", () => {
    const { sqlite } = fresh();
    const insert = (id: string, status: string) =>
      sqlite
        .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, status, owner, modified_by) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, "noop", "server", "srv_y", "{}", status, "op_system", "op_system");
    expect(() => insert("run_bad", "planned")).toThrow(); // planned + NULL plan_json violates the CHECK
    expect(() => insert("run_ok", "failed")).not.toThrow(); // failed may carry no plan
  });

  it("seeds the reserved system operators op_system + op_emergency", () => {
    const { sqlite } = fresh();
    const rows = sqlite.prepare("SELECT username FROM operators ORDER BY username").all() as { username: string }[];
    expect(rows.map((r) => r.username)).toEqual(["emergency", "system"]);
  });
});
