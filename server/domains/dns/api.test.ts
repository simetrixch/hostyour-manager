import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { DnsInventoryView, DnsWritesView } from "../../../shared/dns.ts";
import { registerDnsRoutes } from "./api.ts";

// GET /api/dns answers the inventory itself and GET /api/dns/writes the book — each route is a
// reading and nothing more, so what is asserted here is that both stand behind the session
// chokepoint and that the rows reach the browser in the shapes shared/dns.ts declares, the book's
// rows judged at the provider against the content the book holds.

const config = parseConfig({
  ...REQUIRED_ENV,
  PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

describe("GET /api/dns", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(withDns = true) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-dns-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "m1.example.com", sshUser: "m1", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example.com", name: "m1", status: "active" }).run();
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "CNAME", "m1.example.com");
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerDnsRoutes(a, {
        db: db.db, ...(withDns ? { dns } : {}),
        consumers: async (_domain, stage) => (stage === "prod" ? [{ name: "post", host: "post" }] : []),
        tenants: async () => [],
        unitApex: async () => "example.net",
      }),
    });
    return { app, db: db.db, dns, cookie: await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" }) };
  }

  it("answers the inventory to a signed-in operator and refuses an anonymous request", async () => {
    const { app, cookie } = await make();
    expect((await app.request("/api/dns")).status).toBe(401);
    const res = await app.request("/api/dns", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DnsInventoryView;
    expect(body.rows).toEqual([
      { owner: { kind: "consumer", name: "post", stage: "prod" }, name: "post.example.net", type: "CNAME", expected: "m1.example.com", found: "m1.example.com", verdict: "standing", removable: true },
    ]);
    // No mail reader is wired in this harness, so the mail block is simply absent — never a sentence
    // claiming the installation publishes none.
    expect(body.skipped).toEqual([]);
    expect(Date.parse(body.readAt)).not.toBeNaN();
  });

  it("answers the book to a signed-in operator, each row judged at the provider, and refuses an anonymous request", async () => {
    const { app, db, dns, cookie } = await make();
    recordDnsWrite(db, { name: "post.example.net", type: "CNAME", content: "m1.example.com", act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_1" });
    recordDnsWrite(db, { name: "*.acme.example.net", type: "CNAME", content: "m1.example.com", act: "updated", owner: { kind: "tenant", name: "zsjs023ctne0", stage: "prod" }, runId: "run_2" });
    recordDnsWrite(db, { name: "example.com", type: "TXT", content: "v=spf1 ip4:203.0.113.9 -all", act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_3" });
    dns.seed("*.acme.example.net", "CNAME", "s9.example.com"); // changed by a hand at the provider since the write
    dns.seed("example.com", "TXT", "MS=ms12345678", "v=spf1 ip4:203.0.113.9 -all"); // standing, beside another service's TXT
    expect((await app.request("/api/dns/writes")).status).toBe(401);
    const res = await app.request("/api/dns/writes", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DnsWritesView;
    expect(body.rows.map((r) => `${r.act} ${r.type} ${r.name} (${r.owner.kind} ${r.owner.name}${r.owner.stage ? " " + r.owner.stage : ""}) by ${r.runId}: ${r.verdict}`).sort()).toEqual([
      "inserted CNAME post.example.net (consumer post prod) by run_1: standing",
      "inserted TXT example.com (mail example.com) by run_3: standing",
      "updated CNAME *.acme.example.net (tenant zsjs023ctne0 prod) by run_2: other",
    ]);
    const wildcard = body.rows.find((r) => r.name === "*.acme.example.net")!;
    expect(wildcard.found).toBe("s9.example.com");
    expect(Date.parse(wildcard.writtenAt)).not.toBeNaN();
    expect(body.rows.find((r) => r.type === "TXT")!.found).toBe("MS=ms12345678 | v=spf1 ip4:203.0.113.9 -all");
    expect(body.skipped).toEqual([]);
    expect(Date.parse(body.readAt)).not.toBeNaN();
  });

  it("lists the book without a reading, and says so, when no DNS provider is wired", async () => {
    const { app, db, cookie } = await make(false);
    recordDnsWrite(db, { name: "post.example.net", type: "CNAME", content: "m1.example.com", act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_1" });
    const body = (await (await app.request("/api/dns/writes", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })).json()) as DnsWritesView;
    expect(body.rows).toMatchObject([{ name: "post.example.net", found: null, verdict: null }]);
    expect(body.skipped).toEqual([expect.stringContaining("no DNS provider wired")]);
  });
});
