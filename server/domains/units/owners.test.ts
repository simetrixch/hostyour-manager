import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pino } from "pino";
import type { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { listOwnerIdentities, readOwnerIdentity, recordPackagesReader, recordRepositoryPat, forgetOwnerCredential, type OwnerDeps } from "#unit/server/owners.ts";
import { registerOwnerRoutes } from "./api-owners.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { OwnersListView } from "../../../shared/api-types-owners.ts";

// The identity of an owner (#219): a token is MEASURED against GitHub before it is sealed,
// refused by name otherwise, and only its fingerprint is ever listed. Replacing revokes what stood.

const logger = pino({ level: "silent" });
const ORG = "acme-org";

let db: DbHandle;
let store: CredentialStore;
let github: FakeGitHubConsumer;
let githubApp: FakeGitHubApp;
beforeEach(() => {
  db = openDb(":memory:");
  store = new CredentialStore({ db: db.db, logger });
  github = new FakeGitHubConsumer();
  github.orgPackageReaders.set(ORG, ["ghp_reads"]);
  githubApp = new FakeGitHubApp();
  githubApp.org = ORG;
});
afterEach(() => { db.sqlite.close(); });

function deps(over: Partial<OwnerDeps> = {}): OwnerDeps {
  return { db: db.db, store, github, githubApp, actor: () => "op_test", ...over };
}

describe("the packages reader of an owner", () => {
  it("is recorded after the measurement says the token reads the owner's packages; the list shows its fingerprint and the App's owner first", async () => {
    const view = await recordPackagesReader(deps(), ORG, "ghp_reads");
    expect(view.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(github.orgReads).toEqual([{ org: ORG, token: "ghp_reads" }]);
    const ids = readOwnerIdentity(db.db, ORG);
    expect(ids?.packagesCredentialId).toMatch(/^cred_/);
    expect(ids?.repoCredentialId).toBeNull();
    // The sealed row opens to the token — what the build seed reads later — and nothing else was kept.
    expect((await store.open(ids!.packagesCredentialId!, { purpose: "test" })).toString("utf8")).toBe("ghp_reads");
    const list = await listOwnerIdentities(deps());
    expect(list).toEqual([{ org: ORG, appInstalled: true, packagesReader: { fingerprint: view.fingerprint, recordedAt: expect.any(String) }, repositoryPat: null }]);
  });

  it("refuses by name a token that does not read the packages, an invalid one, and an owner the token cannot see — and seals nothing", async () => {
    github.tokenScopes = { classic: true, scopes: ["repo"] };
    await expect(recordPackagesReader(deps(), ORG, "ghp_norepo")).rejects.toThrow(/does not read the packages of acme-org — a classic PAT needs the read:packages scope \(granted: repo\)/);
    github.tokenScopes = { classic: false, scopes: [] };
    await expect(recordPackagesReader(deps(), ORG, "github_pat_x")).rejects.toThrow(/a fine-grained PAT needs the "Packages: Read" permission/);
    await expect(recordPackagesReader(deps(), "other-org", "ghp_reads")).rejects.toThrow(/knows no owner "other-org"/);
    github.tokenInvalid = true;
    await expect(recordPackagesReader(deps(), ORG, "ghp_reads")).rejects.toThrow(/invalid or expired/);
    await expect(recordPackagesReader(deps(), "not an org!", "ghp_reads")).rejects.toThrow(/is not a GitHub owner login/);
    expect(await store.list({ kind: "pat" })).toEqual([]);
    expect(readOwnerIdentity(db.db, ORG)).toBeNull();
  });

  it("replacing revokes the row that stood; forgetting revokes and clears, and the owner's row goes with its last credential", async () => {
    await recordPackagesReader(deps(), ORG, "ghp_reads");
    const first = readOwnerIdentity(db.db, ORG)!.packagesCredentialId!;
    github.orgPackageReaders.set(ORG, ["ghp_reads", "ghp_reads2"]);
    await recordPackagesReader(deps(), ORG, "ghp_reads2");
    const second = readOwnerIdentity(db.db, ORG)!.packagesCredentialId!;
    expect(second).not.toBe(first);
    await expect(store.open(first, { purpose: "test" })).rejects.toThrow(/revoked/);
    await forgetOwnerCredential(deps(), ORG, "packages-reader");
    expect(readOwnerIdentity(db.db, ORG)).toBeNull();
    await expect(store.open(second, { purpose: "test" })).rejects.toThrow(/revoked/);
    await expect(forgetOwnerCredential(deps(), ORG, "packages-reader")).rejects.toThrow(/records no packages-reader/);
  });
});

describe("the repository PAT of an owner", () => {
  it("is recorded after its classic scopes are measured (repo + workflow + admin:repo_hook, read:packages not asked), refused fine-grained or short", async () => {
    github.tokenScopes = { classic: true, scopes: ["repo", "workflow", "admin:repo_hook"] };
    await recordRepositoryPat(deps(), "other-org", "ghp_repo");
    expect(readOwnerIdentity(db.db, "other-org")?.repoCredentialId).toMatch(/^cred_/);
    github.tokenScopes = { classic: true, scopes: ["repo"] };
    await expect(recordRepositoryPat(deps(), "other-org", "ghp_short")).rejects.toThrow(/lacks workflow, admin:repo_hook \(granted: repo\)/);
    github.tokenScopes = { classic: false, scopes: [] };
    await expect(recordRepositoryPat(deps(), "other-org", "github_pat_x")).rejects.toThrow(/fine-grained, which reports no scopes/);
    const list = await listOwnerIdentities(deps());
    expect(list.map((o) => [o.org, o.appInstalled, o.repositoryPat !== null])).toEqual([[ORG, true, false], ["other-org", false, true]]);
  });

  it("of a personal account is one that account created: another account's token is refused, naming both (#252)", async () => {
    github.tokenScopes = { classic: true, scopes: ["repo", "workflow", "admin:repo_hook"] };
    github.tokenAccess = { login: "kartalbas", ownerKind: "User", repoPermission: "push" };
    await expect(recordRepositoryPat(deps(), "ahkutun", "ghp_collaborator")).rejects.toThrow(/acts as kartalbas, and ahkutun is a personal account, whose repositories have ahkutun alone as admin/);
    expect(readOwnerIdentity(db.db, "ahkutun")?.repoCredentialId ?? null).toBeNull();
    github.tokenAccess = { login: "AhKutun", ownerKind: "User", repoPermission: "admin" };
    await recordRepositoryPat(deps(), "ahkutun", "ghp_owner");
    expect(readOwnerIdentity(db.db, "ahkutun")?.repoCredentialId).toMatch(/^cred_/);
  });
});

describe("the owners over HTTP", () => {
  const config = parseConfig({ ...REQUIRED_ENV, PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/tmp/x.sock" });
  async function serve(): Promise<{ app: Hono<AppEnv>; cookie: string }> {
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerOwnerRoutes(a, deps()),
    });
    const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
    return { app, cookie };
  }
  const headers = (cookie: string, body?: unknown): RequestInit => ({
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  it("PUT measures and records, answering the fingerprint only; GET lists; DELETE forgets; a body without the token is refused by field name", async () => {
    const { app, cookie } = await serve();
    const put = await app.request(`/api/owners/${ORG}/packages-reader`, { method: "PUT", ...headers(cookie, { token: "ghp_reads" }) });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { packagesReader: { fingerprint: string } };
    expect(JSON.stringify(body)).not.toContain("ghp_reads");
    const list = (await (await app.request("/api/owners", headers(cookie))).json()) as OwnersListView;
    expect(list.owners[0]?.packagesReader?.fingerprint).toBe(body.packagesReader.fingerprint);
    const refused = await app.request(`/api/owners/${ORG}/packages-reader`, { method: "PUT", ...headers(cookie, { pat: "x" }) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("one field, token");
    const gone = await app.request(`/api/owners/${ORG}/packages-reader`, { method: "DELETE", ...headers(cookie) });
    expect(gone.status).toBe(200);
    expect(readOwnerIdentity(db.db, ORG)).toBeNull();
  });
});
