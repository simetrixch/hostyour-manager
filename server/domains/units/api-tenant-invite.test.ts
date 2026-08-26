import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerTenantRoutes } from "./api.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { BOOTSTRAP_TOKEN_KEY } from "./tenant-admin-invite.ts";
import { TENANT_SECRET } from "./tenant-secrets.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AppEnv } from "../../http/app-env.ts";

// WHERE the operator-driven first-admin invite (POST /api/tenants/:id/invite-admin) sends the tenant's
// bootstrap token. A tenant member is addressed at `<member>.<subdomain>.<unitApex>` — the three parts
// the member's chart renders and the tenant's wildcard DNS record covers — so this route must resolve
// the TARGET CLUSTER's own apex. `clusters.domain` is a different fact: it is where the CLUSTER is
// reached, and install.sh defaults `unit-apex` to that FQDN minus its first label, so on every cluster
// that is not itself the apex a host composed from the domain resolves nowhere and the invite fails
// loud on transport. Split into this sibling file next to api-tenant-provisional.test.ts (the invite's
// status guard) because api.test.ts is long past the 400-line budget.

const GUID = "e2e8ymj86dk8";
const DOMAIN = "s1.example"; // where the CLUSTER is reached
const APEX = "example.com"; // where its UNITS serve — deliberately not a suffix relationship with DOMAIN
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

/** An ACTIVE tenant on the slave — the state the invite route acts on (a provisioning or suspended one
 *  is refused before the token read, which api-tenant-provisional.test.ts covers). */
function seedTenant(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: DOMAIN, status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
}

/** The tenant routes with the invite's port set. `apex` is left out to model a manager where the
 *  platform repo — the only source of a cluster's values chain — is not wired. */
async function makeTenant(apex?: string): Promise<{ app: Hono<AppEnv>; cookie: string; activator: FakeActivator }> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  const resolver = new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({
      secretValues: { [`${memberNamespace(GUID, "auth")}/${TENANT_SECRET}/${BOOTSTRAP_TOKEN_KEY}`]: "boot_tok_abc" },
    }),
    argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
  });
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const activator = new FakeActivator();
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantRoutes(a, {
      executor, db: db.db, onboardingEnabled: true, resolver, activator,
      ...(apex !== undefined ? { resolveUnitApex: async () => apex } : {}),
    }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie, activator };
}

const invite = async (app: Hono<AppEnv>, cookie: string): Promise<Response> =>
  await app.request("/api/tenants/tnt_1/invite-admin", { method: "POST", ...authed(cookie), body: JSON.stringify({ email: "admin@acme.test" }) });

describe("POST /api/tenants/:id/invite-admin addresses the tenant's own example-auth", () => {
  it("posts the bootstrap token to auth.<subdomain>.<unitApex>, never to auth.<subdomain>.<clusterDomain>", async () => {
    seedTenant();
    const { app, cookie, activator } = await makeTenant(APEX);
    expect((await invite(app, cookie)).status).toBe(200);
    const call = activator.calls[0]!;
    expect(call.url).toBe(`https://auth.acme.${APEX}/api/v1/bootstrap/invite-admin`);
    expect(call.url).not.toContain(DOMAIN);
    // The token still rides the header alone — the host is the only thing this fix moves.
    expect(call.tokenHeader).toBe("X-Bootstrap-Token");
    expect(call.token).toBe("boot_tok_abc");
  });

  it("follows the apex the cluster states, so a cluster that IS its own apex composes that instead", async () => {
    seedTenant();
    const { app, cookie, activator } = await makeTenant(DOMAIN);
    expect((await invite(app, cookie)).status).toBe(200);
    expect(activator.calls[0]?.url).toBe(`https://auth.acme.${DOMAIN}/api/v1/bootstrap/invite-admin`);
  });

  it("answers 501 with no apex resolver wired — a credential is never posted at a guessed host", async () => {
    seedTenant();
    const { app, cookie, activator } = await makeTenant(); // no resolveUnitApex threaded
    expect((await invite(app, cookie)).status).toBe(501);
    expect(activator.calls).toHaveLength(0);
  });
});
