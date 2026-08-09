import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultSelfSeeder } from "./vault-self-seeder.ts";
import { VaultError } from "./port.ts";
import type { BuildRepoPatSeedInput, VaultSeedInput, AppSecretsDeleteInput, PostgresSeedInput, PostgresSecretDeleteInput, TenantCryptoSeedInput } from "./seeder-port.ts";

interface Recorded {
  method: string;
  url: string;
  token?: string;
  body?: unknown;
}

let server: Server;
let base: string;
let recorded: Recorded[];
let loginStatus: number;
let metaDeleteStatus: number;
/** What the KV-v2 data write answers. Default 200 = the entry did not exist and was created; a test
 *  overrides this to replay Vault's cas-conflict (an entry that already exists). */
let dataPut: { status: number; body: string };

function start(): Promise<void> {
  recorded = [];
  loginStatus = 200;
  metaDeleteStatus = 200;
  dataPut = { status: 200, body: "{}" };
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method ?? "", url: req.url ?? "" };
      const t = req.headers["x-vault-token"];
      if (typeof t === "string") rec.token = t;
      if (raw) {
        try {
          rec.body = JSON.parse(raw);
        } catch {
          rec.body = raw;
        }
      }
      recorded.push(rec);
      if (req.url?.endsWith("/login")) {
        if (loginStatus !== 200) {
          res.writeHead(loginStatus);
          res.end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ auth: { client_token: "s.tok123" } }));
        return;
      }
      if (req.method === "DELETE" && req.url?.includes("/metadata/")) {
        res.writeHead(metaDeleteStatus);
        res.end();
        return;
      }
      if (req.method === "POST" && req.url?.includes("/data/")) {
        res.writeHead(dataPut.status, { "content-type": "application/json" });
        res.end(dataPut.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      const addr = server.address();
      base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
      resolve();
    }),
  );
}

beforeEach(start);
afterEach(() => new Promise<void>((r) => server.close(() => r())));

/** Every write rides the Controller's OWN kubernetes-auth identity, so every test needs a real
 *  ServiceAccount token file on disk — a scaffold torn down per test. */
function withSelf<T>(fn: (seeder: VaultSelfSeeder) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ctrl-seeder-sa-"));
  const saTokenPath = join(dir, "token");
  writeFileSync(saTokenPath, "sa-jwt\n", "utf8");
  const seeder = new VaultSelfSeeder({ self: { addr: base, k8sAuthMount: "kubernetes", k8sRole: "controller", saTokenPath } });
  return fn(seeder).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const input = (over: Partial<VaultSeedInput> = {}): VaultSeedInput => ({
  stage: "prod",
  consumerName: "acme",
  data: { API_KEY: "xyz" },
  ...over,
});

describe("VaultSelfSeeder seed (the consumer's ceremony secrets)", () => {
  it("logs in over the controller's own kubernetes-auth identity, puts the app entry write-only, and revokes the token", async () => {
    await withSelf(async (seeder) => {
      expect(await seeder.seed(input())).toEqual({ created: true });
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "POST /v1/secret/data/prod/consumer/acme/app",
        "POST /v1/auth/token/revoke-self",
      ]);
      expect(recorded[0]!.body).toEqual({ role: "controller", jwt: "sa-jwt" });
      expect(recorded[1]!.token).toBe("s.tok123");
      // `options.cas: 0` is LOAD-BEARING, not decoration — it is the whole create-only guarantee.
      // Drop it and the write silently becomes an overwrite: the caller re-mints every `generate:`
      // key on every run, so a re-onboard would rotate a LIVE consumer's signing keys underneath
      // pods that read their env once at start. Assert the exact body so that regression cannot
      // pass. (An earlier test in this repo asserted a portless vaultServer and thereby FROZE a
      // real bug — a test that asserts the broken shape is worse than no test.)
      expect(recorded[1]!.body).toEqual({ data: { API_KEY: "xyz" }, options: { cas: 0 } });
      expect(recorded[2]!.token).toBe("s.tok123");
    });
  });

  it("reports created:false and writes NOTHING when the entry already exists (cas conflict)", async () => {
    // Vault's real answer when cas=0 hits an existing entry. Not an error: a re-run legitimately
    // finds the consumer already seeded and must leave the live values alone.
    dataPut = { status: 400, body: JSON.stringify({ errors: ["check-and-set parameter did not match the current version"] }) };
    await withSelf(async (seeder) => {
      expect(await seeder.seed(input())).toEqual({ created: false });
      // Still a clean ceremony: the token is revoked even on the no-op path.
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "POST /v1/secret/data/prod/consumer/acme/app",
        "POST /v1/auth/token/revoke-self",
      ]);
    });
  });

  it("still fails closed on a 400 that is NOT a cas conflict (a real error is never read as 'already seeded')", async () => {
    dataPut = { status: 400, body: JSON.stringify({ errors: ["missing data for version 2"] }) };
    await withSelf(async (seeder) => {
      await expect(seeder.seed(input())).rejects.toBeInstanceOf(VaultError);
    });
  });

  it("still fails closed when the seed put is denied (403) — a policy gap is never a silent no-op", async () => {
    dataPut = { status: 403, body: JSON.stringify({ errors: ["permission denied"] }) };
    await withSelf(async (seeder) => {
      await expect(seeder.seed(input())).rejects.toBeInstanceOf(VaultError);
    });
  });

  it("throws VaultError when the kubernetes login is refused", async () => {
    loginStatus = 403;
    await withSelf(async (seeder) => {
      await expect(seeder.seed(input())).rejects.toBeInstanceOf(VaultError);
    });
  });

  it("fails the seed closed when the Controller carries no own Vault login", async () => {
    const seeder = new VaultSelfSeeder({});
    await expect(seeder.seed(input())).rejects.toBeInstanceOf(VaultError);
    expect(recorded).toHaveLength(0); // no HTTP happened — refused before any call
  });
});

// ---- the build-tier repo-pat write ("one PAT per unit", stage-free) ----

const patInput = (over: Partial<BuildRepoPatSeedInput> = {}): BuildRepoPatSeedInput => ({
  consumerName: "acme",
  pat: "github_pat_x",
  ...over,
});

describe("VaultSelfSeeder build repo-pat (stage-free)", () => {
  it("writes the PAT to secret/build/<name>/repo-pat (cas=0)", async () => {
    await withSelf(async (seeder) => {
      const out = await seeder.seedBuildRepoPat(patInput());
      expect(out).toEqual({ created: true });
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "POST /v1/secret/data/build/acme/repo-pat",
        "POST /v1/auth/token/revoke-self",
      ]);
      expect(recorded[0]!.body).toEqual({ role: "controller", jwt: "sa-jwt" });
      expect(recorded[1]!.body).toEqual({ data: { pat: "github_pat_x" }, options: { cas: 0 } });
    });
  });

  it("ATTESTS an existing path: the cas conflict answers created:false, nothing is overwritten", async () => {
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        if (req.url?.endsWith("/login")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ auth: { client_token: "s.tok123" } }));
        } else if (req.method === "POST" && req.url?.includes("/data/")) {
          res.writeHead(400);
          res.end(JSON.stringify({ errors: ["check-and-set parameter did not match the current version"] }));
        } else {
          res.writeHead(200);
          res.end("{}");
        }
      });
    });
    await withSelf(async (seeder) => {
      expect(await seeder.seedBuildRepoPat(patInput())).toEqual({ created: false });
    });
  });

  it("fails closed when the controller self identity is missing (dev/tests without Vault)", async () => {
    const seeder = new VaultSelfSeeder({});
    await expect(seeder.seedBuildRepoPat(patInput())).rejects.toBeInstanceOf(VaultError);
    expect(recorded).toHaveLength(0); // no HTTP happened — refused before any call
  });

  it("propagates a put failure (fail-closed onboard) after a successful login", async () => {
    loginStatus = 200;
    // re-script: the data write answers 403 (the build-tier grant is missing GitOps-side)
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        if (req.url?.endsWith("/login")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ auth: { client_token: "s.tok123" } }));
        } else if (req.method === "POST" && req.url?.includes("/data/")) {
          res.writeHead(403);
          res.end("{}");
        } else {
          res.writeHead(200);
          res.end("{}");
        }
      });
    });
    await withSelf(async (seeder) => {
      await expect(seeder.seedBuildRepoPat(patInput())).rejects.toThrow(/repo-pat put failed/);
    });
  });

  it("deleteBuildRepoPat metadata-deletes the entry and tolerates an already-absent one (404)", async () => {
    await withSelf(async (seeder) => {
      await seeder.deleteBuildRepoPat({ consumerName: "acme" });
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "DELETE /v1/secret/metadata/build/acme/repo-pat",
        "POST /v1/auth/token/revoke-self",
      ]);
      recorded.length = 0;
      metaDeleteStatus = 404; // idempotent offboard retry
      await seeder.deleteBuildRepoPat({ consumerName: "acme" });
      expect(recorded.some((r) => r.method === "DELETE")).toBe(true);
    });
  });
});

// ---- the consumer-tier ceremony-secret delete (offboard's inverse of `seed`) ----

const appDeleteInput = (over: Partial<AppSecretsDeleteInput> = {}): AppSecretsDeleteInput => ({
  stage: "prod",
  consumerName: "acme",
  ...over,
});

describe("VaultSelfSeeder deleteApp (consumer tier)", () => {
  it("metadata-deletes secret/<stage>/consumer/<name>/app and tolerates an already-absent entry (404)", async () => {
    await withSelf(async (seeder) => {
      await seeder.deleteApp(appDeleteInput());
      // The METADATA endpoint is LOAD-BEARING and belongs in the assertion. A `data` delete is a SOFT
      // delete that keeps version information, and cas=0 is allowed only where there is none — so a
      // soft delete would leave the next onboard's write still refused AND hide the values from ESO:
      // a consumer that can neither be re-seeded nor read its secrets. Only the metadata delete drops
      // every version and returns the path to non-existent. Asserting `/data/` here would freeze that
      // bug, so the exact URL is pinned.
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "DELETE /v1/secret/metadata/prod/consumer/acme/app",
        "POST /v1/auth/token/revoke-self",
      ]);
      expect(recorded[1]!.token).toBe("s.tok123");
      // Value-FREE: the delete carries no body, so the write-only property survives — the seeder
      // learns a status code, never a secret.
      expect(recorded[1]!.body).toBeUndefined();

      recorded.length = 0;
      metaDeleteStatus = 404;
      // 404 is a NORMAL case, not just a crash-retry: `seed` returns early without writing when the
      // manifest declares no secrets, so many consumers never had an entry to delete. A 404-intolerant
      // delete would fail offboard for every secret-less consumer.
      await seeder.deleteApp(appDeleteInput());
      expect(recorded.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it("fails closed when the delete is denied (403) — a missing policy grant is never read as 'already gone'", async () => {
    // The grant (delete on secret/metadata/<stage>/consumer/+/app) is imperative in hostyour-cloud and
    // may simply not be deployed yet. Treating that 403 as success would report a clean offboard
    // while the keys survive, and the next onboard would inherit them under cas=0 — the exact bug.
    metaDeleteStatus = 403;
    await withSelf(async (seeder) => {
      await expect(seeder.deleteApp(appDeleteInput())).rejects.toBeInstanceOf(VaultError);
      await expect(seeder.deleteApp(appDeleteInput())).rejects.toThrow(/app-secrets delete failed/);
    });
  });

  it("revokes its token even when the delete fails (no token outlives a failed offboard step)", async () => {
    metaDeleteStatus = 500;
    await withSelf(async (seeder) => {
      await expect(seeder.deleteApp(appDeleteInput())).rejects.toBeInstanceOf(VaultError);
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "DELETE /v1/secret/metadata/prod/consumer/acme/app",
        "POST /v1/auth/token/revoke-self",
      ]);
    });
  });

  it("fails closed when the Controller carries no own Vault login", async () => {
    const seeder = new VaultSelfSeeder({});
    await expect(seeder.deleteApp(appDeleteInput())).rejects.toBeInstanceOf(VaultError);
    expect(recorded).toHaveLength(0); // no HTTP happened — refused before any call
  });
});

// ---- the per-consumer PostgreSQL instance-superuser seed (create-only) ----

const pgSeedInput = (over: Partial<PostgresSeedInput> = {}): PostgresSeedInput => ({
  stage: "prod",
  consumerName: "acme",
  password: "pg-secret-hex",
  ...over,
});

describe("VaultSelfSeeder seedPostgres (per-consumer postgres, create-only)", () => {
  it("logs in, PUTs the postgres leaf write-only with cas=0 (property postgres-password), and revokes the token", async () => {
    await withSelf(async (seeder) => {
      expect(await seeder.seedPostgres(pgSeedInput())).toEqual({ created: true });
      // A SEPARATE leaf from .../app: <stage>/consumer/<name>/postgres. Asserting the exact path +
      // cas=0 body pins the whole reason it is not folded into the create-only `app` entry — a consumer
      // that adds services:[postgresql] on a later re-pin would never get it there.
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "POST /v1/secret/data/prod/consumer/acme/postgres",
        "POST /v1/auth/token/revoke-self",
      ]);
      expect(recorded[1]!.token).toBe("s.tok123");
      expect(recorded[1]!.body).toEqual({ data: { "postgres-password": "pg-secret-hex" }, options: { cas: 0 } });
    });
  });

  it("reports created:false and writes nothing when the leaf already exists (cas conflict) — a re-onboard onto surviving PGDATA", async () => {
    dataPut = { status: 400, body: JSON.stringify({ errors: ["check-and-set parameter did not match the current version"] }) };
    await withSelf(async (seeder) => {
      expect(await seeder.seedPostgres(pgSeedInput())).toEqual({ created: false });
    });
  });

  it("fails closed on a non-cas 400 and on a 403 (a policy gap is never read as 'already seeded')", async () => {
    await withSelf(async (seeder) => {
      dataPut = { status: 400, body: JSON.stringify({ errors: ["missing data for version 2"] }) };
      await expect(seeder.seedPostgres(pgSeedInput())).rejects.toBeInstanceOf(VaultError);
      dataPut = { status: 403, body: JSON.stringify({ errors: ["permission denied"] }) };
      await expect(seeder.seedPostgres(pgSeedInput())).rejects.toBeInstanceOf(VaultError);
    });
  });
});

// ---- the per-consumer PostgreSQL superuser delete (offboard/purge inverse) ----

const pgDeleteInput = (over: Partial<PostgresSecretDeleteInput> = {}): PostgresSecretDeleteInput => ({
  stage: "prod",
  consumerName: "acme",
  ...over,
});

describe("VaultSelfSeeder deletePostgres (offboard/purge)", () => {
  it("metadata-deletes <stage>/consumer/<name>/postgres and tolerates an already-absent leaf (404 = the no-op for a consumer that never claimed postgresql)", async () => {
    await withSelf(async (seeder) => {
      await seeder.deletePostgres(pgDeleteInput());
      // METADATA path (hard, all versions), never the data path — the same argument as deleteApp: only a
      // metadata delete returns the leaf to "no version information", which the next onboard's cas=0 needs.
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "DELETE /v1/secret/metadata/prod/consumer/acme/postgres",
        "POST /v1/auth/token/revoke-self",
      ]);
      // Value-free: the delete carries no body, so the write-only property survives.
      expect(recorded[1]!.body).toBeUndefined();

      recorded.length = 0;
      metaDeleteStatus = 404; // the NORMAL case: offboard/purge call this UNCONDITIONALLY, and a consumer
      // that never claimed postgresql simply has no leaf — the 404 tolerance is what makes that a no-op.
      await seeder.deletePostgres(pgDeleteInput());
      expect(recorded.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it("fails closed when the delete is denied (403) — a missing metadata-delete grant is never read as 'already gone'", async () => {
    metaDeleteStatus = 403;
    await withSelf(async (seeder) => {
      await expect(seeder.deletePostgres(pgDeleteInput())).rejects.toBeInstanceOf(VaultError);
      await expect(seeder.deletePostgres(pgDeleteInput())).rejects.toThrow(/postgres-secret delete failed/);
    });
  });
});

const tenantCryptoInput = (over: Partial<TenantCryptoSeedInput> = {}): TenantCryptoSeedInput => ({
  stage: "prod",
  guid: "zsjs023ctne0",
  data: { "auth-jwt-private-key": "PRIV", "auth-jwt-public-key": "PUB", "auth-totp-enc-key": "T", "auth-bootstrap-token": "B", "engine-api-key": "E" },
  ...over,
});

describe("VaultSelfSeeder seedTenantCrypto (create-tenant)", () => {
  it("writes <stage>/tenants/<guid> ONCE, cas=0, as the leaf every member namespace reads", async () => {
    await withSelf(async (seeder) => {
      expect(await seeder.seedTenantCrypto(tenantCryptoInput())).toEqual({ created: true });
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        // The bare guid IS the leaf, with nothing under it: the tenant's ACL template resolves to
        // exactly this path, so a deeper one would be written where no member can read it.
        "POST /v1/secret/data/prod/tenants/zsjs023ctne0",
        "POST /v1/auth/token/revoke-self",
      ]);
      expect(recorded[1]!.body).toEqual({
        data: { "auth-jwt-private-key": "PRIV", "auth-jwt-public-key": "PUB", "auth-totp-enc-key": "T", "auth-bootstrap-token": "B", "engine-api-key": "E" },
        options: { cas: 0 },
      });
    });
  });

  it("an EXISTING entry is left untouched (created:false), never overwritten", async () => {
    // Vault's own cas conflict. This is what makes a re-run of create-tenant safe: the mint upstream is
    // unconditional, so an overwrite here would rotate a LIVE tenant's signing key and bootstrap token
    // out from under pods that read their env once, at container start.
    dataPut = { status: 400, body: JSON.stringify({ errors: ["check-and-set parameter did not match the current version"] }) };
    await withSelf(async (seeder) => {
      expect(await seeder.seedTenantCrypto(tenantCryptoInput())).toEqual({ created: false });
    });
  });

  it("fails closed on any other status — a 403 is a missing grant, never 'already there'", async () => {
    dataPut = { status: 403, body: "permission denied" };
    await withSelf(async (seeder) => {
      await expect(seeder.seedTenantCrypto(tenantCryptoInput())).rejects.toBeInstanceOf(VaultError);
      await expect(seeder.seedTenantCrypto(tenantCryptoInput())).rejects.toThrow(/tenant-crypto seed put failed/);
    });
  });
});

describe("VaultSelfSeeder deleteTenantCrypto (purge)", () => {
  it("metadata-deletes the entry and tolerates an already-absent one", async () => {
    await withSelf(async (seeder) => {
      await seeder.deleteTenantCrypto({ stage: "prod", guid: "zsjs023ctne0" });
      // METADATA, all versions: only that returns the leaf to "no version information", which a future
      // create-only seed of the same guid needs — and a soft delete would let the next tenant of that
      // guid inherit the purged tenant's signing key.
      expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/auth/kubernetes/login",
        "DELETE /v1/secret/metadata/prod/tenants/zsjs023ctne0",
        "POST /v1/auth/token/revoke-self",
      ]);
      // Value-free: a delete returns nothing, so the write-only property survives this exception to it.
      expect(recorded[1]!.body).toBeUndefined();

      recorded.length = 0;
      metaDeleteStatus = 404; // a retry, or a tenant whose create-tenant died before the seed step
      await seeder.deleteTenantCrypto({ stage: "prod", guid: "zsjs023ctne0" });
      expect(recorded.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it("fails closed when the delete is denied (403)", async () => {
    metaDeleteStatus = 403;
    await withSelf(async (seeder) => {
      await expect(seeder.deleteTenantCrypto({ stage: "prod", guid: "zsjs023ctne0" })).rejects.toThrow(/tenant-crypto delete failed/);
    });
  });
});
