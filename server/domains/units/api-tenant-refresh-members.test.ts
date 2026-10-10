import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import type { LineMoveView } from "../../../shared/api-types-line-move.ts";
import { registerTenantRefreshMembersRoutes } from "./api-tenant-refresh-members.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";
import { eq } from "drizzle-orm";
import type { OperatorSession } from "../access/session.ts";
import type { TenantFollower } from "./tenant-follow.ts";
import { runAsActor } from "../../kernel/actor.ts";

// The Versions dialog's routes: the GET answers what the reader answers, and the POST plans the run with
// the version chosen per part, refusing a body whose versions are no image tags before anything runs.

const TAG = "0.1.12-stable-20260925120000-abc1234";
const VIEW: VersionsView = { stage: "prod", parts: [{ name: "example-platform", builds: ["example-engine"], running: [TAG], versions: [{ tag: TAG, older: false }] }] };

describe("the Versions routes of a tenant", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  function route(versions?: (db: unknown, tenantId: string) => Promise<VersionsView>, lineMoves?: (db: unknown, tenantId: string) => Promise<LineMoveView>) {
    h = openDb(":memory:");
    h.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    h.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", status: "active" }).run();
    const planned: unknown[] = [];
    const executor = { planStreamed: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const checked: string[] = [];
    const follower = { checkTenant: async (id: string) => { checked.push(id); } } as unknown as TenantFollower;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    app.use(async (c, next) => { c.set("operator", { sub: "op_1" } as OperatorSession); return runAsActor("op_1", () => next()); });
    registerTenantRefreshMembersRoutes(app, { db: h.db, executor, tenantEnabled: true, follower, ...(versions ? { versions } : {}), ...(lineMoves ? { lineMoves } : {}) });
    const post = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/refresh-members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const follow = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/follow-releases", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const move = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/line-move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { app, post, follow, move, planned, checked };
  }

  it("answers the versions the reader reads for the tenant, and 501 where no reader is wired", async () => {
    const asked: string[] = [];
    const r = route(async (_db, tenantId) => { asked.push(tenantId); return VIEW; });
    const res = await r.app.request("/api/tenants/tnt_1/versions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(asked).toEqual(["tnt_1"]);
    h.sqlite.close();
    expect((await route().app.request("/api/tenants/tnt_1/versions")).status).toBe(501);
  });

  it("answers the line move the reader reads for the tenant, and 501 where no reader is wired", async () => {
    const view: LineMoveView = { line: "0.3", offer: { line: "0.4", fromBundle: "0.3.002-stable-20260927000000-aaaaaaa", toBundle: "0.4.000-stable-20261010120000-bbbbbbb", part: "example-platform", partTag: "0.4.001-stable-20261010000000-3333333", builds: ["example-engine"], refusals: [] } };
    const r = route(undefined, async () => view);
    const res = await r.app.request("/api/tenants/tnt_1/line-moves");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    h.sqlite.close();
    expect((await route().app.request("/api/tenants/tnt_1/line-moves")).status).toBe(501);
  });

  it("PLANTED DEFECT: plans the line move with the line asked for, and refuses a line that is no x.y before anything runs", async () => {
    const r = route();
    expect((await r.move({ line: "0.4" })).status).toBe(201);
    expect(r.planned).toEqual([{ tenantId: "tnt_1", line: "0.4" }]);
    const bad = await r.move({ line: "0.4.1" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("invalid line move request");
    expect(r.planned).toHaveLength(1);
  });

  it("plans with the version chosen per part, with none where the body names none, and refuses a version that is no image tag", async () => {
    const r = route();
    expect((await r.post({ versions: { "example-platform": TAG } })).status).toBe(201);
    expect((await r.post({})).status).toBe(201);
    expect(r.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-platform": TAG } }, { tenantId: "tnt_1", versions: {} }]);
    const bad = await r.post({ versions: { "example-platform": "0.1.12" } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("invalid versions request");
    expect(r.planned).toHaveLength(2);
  });

  it("turns following releases on and off on the row, records who did in the audit, and checks the tenant at once when on (#328)", async () => {
    const r = route();
    const on = await r.follow({ followReleases: true });
    expect(on.status).toBe(200);
    expect(h.db.select({ f: tenants.followReleases }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.f).toBe(true);
    expect(r.checked).toEqual(["tnt_1"]);
    expect((await r.follow({ followReleases: false })).status).toBe(200);
    expect(h.db.select({ f: tenants.followReleases }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.f).toBe(false);
    expect(r.checked).toEqual(["tnt_1"]); // turned off: nothing to catch up with
    expect(h.sqlite.prepare("SELECT owner, action, detail_json AS detail FROM audit ORDER BY rowid").all()).toEqual([
      { owner: "op_1", action: "tenant.follow-releases.set", detail: JSON.stringify({ followReleases: true }) },
      { owner: "op_1", action: "tenant.follow-releases.set", detail: JSON.stringify({ followReleases: false }) },
    ]);
    expect((await r.follow({ followReleases: "yes" })).status).toBe(400);
  });
});
