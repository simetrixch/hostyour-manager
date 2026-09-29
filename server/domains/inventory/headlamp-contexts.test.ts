import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { parse } from "yaml";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import type { HeadlampKubeconfig, HeadlampSignIn } from "../../adapters/kube/port.ts";
import { activeSlaves, headlampKubeconfig, syncHeadlampContexts } from "./headlamp-contexts.ts";

// The shared Headlamp offers every active slave beside the master: one context per slave, dialing the
// address and CA its deployment sealed, signing the person in through Headlamp's own client.

const SIGN_IN: HeadlampSignIn = { issuerUrl: "https://idp.m1.example/application/o/headlamp/", clientId: "headlamp", clientSecret: "s3cret", scopes: "openid,profile,email,groups" };
const plane = (server: string): Record<string, unknown> => ({ v: 0, kube: { server, caData: "Q0E=" } });

class FakeHeadlamp implements HeadlampKubeconfig {
  written: string[] = [];
  constructor(private standing: string | null = null) {}
  async readSignIn(): Promise<HeadlampSignIn> { return SIGN_IN; }
  async readKubeconfig(): Promise<string | null> { return this.standing; }
  async writeKubeconfig(kubeconfig: string): Promise<void> { this.written.push(kubeconfig); this.standing = kubeconfig; }
}

let h: DbHandle;
beforeEach(() => {
  h = openDb(":memory:");
  const server = (id: string, n: number, role: "master" | "slave"): void => { h.db.insert(servers).values({ id, name: id, host: `10.0.0.${n}`, sshUser: "root", role, status: "healthy" }).run(); };
  server("m1", 10, "master"); server("s2", 2, "slave"); server("s1", 1, "slave"); server("s3", 3, "slave"); server("s4", 4, "slave");
  h.db.insert(clusters).values({ id: "cls_m", serverId: "m1", stage: "prod", domain: "m1.example", name: "m1", status: "active" }).run();
  h.db.insert(clusters).values({ id: "cls_2", serverId: "s2", stage: "prod", domain: "apps2.example", name: "apps2", status: "active", planeJson: plane("https://100.64.0.2:16443") }).run();
  h.db.insert(clusters).values({ id: "cls_1", serverId: "s1", stage: "prod", domain: "apps1.example", name: "apps1", status: "active", planeJson: plane("https://100.64.0.1:16443") }).run();
  h.db.insert(clusters).values({ id: "cls_3", serverId: "s3", stage: "prod", domain: "apps3.example", name: "apps3", status: "provisioning", planeJson: plane("https://100.64.0.3:16443") }).run();
  h.db.insert(clusters).values({ id: "cls_4", serverId: "s4", stage: "prod", domain: "apps4.example", name: "apps4", status: "active" }).run();
});
afterEach(() => { h.sqlite.close(); });

describe("the shared Headlamp's slave contexts", () => {
  it("PLANTED DEFECT: offers the active slaves alone, by name, and names one whose plane sealed no API address", () => {
    expect(activeSlaves(h.db)).toEqual({
      slaves: [{ name: "apps1", server: "https://100.64.0.1:16443", caData: "Q0E=" }, { name: "apps2", server: "https://100.64.0.2:16443", caData: "Q0E=" }],
      unreachable: ["apps4"],
    });
  });

  it("writes one context per slave, each dialing its own address and CA and signing in through Headlamp's client", () => {
    const config = parse(headlampKubeconfig(activeSlaves(h.db).slaves, SIGN_IN)) as Record<string, unknown>;
    expect(config).toEqual({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        { name: "apps1", cluster: { server: "https://100.64.0.1:16443", "certificate-authority-data": "Q0E=" } },
        { name: "apps2", cluster: { server: "https://100.64.0.2:16443", "certificate-authority-data": "Q0E=" } },
      ],
      users: [{ name: "headlamp", user: { "auth-provider": { name: "oidc", config: { "client-id": "headlamp", "client-secret": "s3cret", "idp-issuer-url": SIGN_IN.issuerUrl, scope: SIGN_IN.scopes } } } }],
      contexts: [{ name: "apps1", context: { cluster: "apps1", user: "headlamp" } }, { name: "apps2", context: { cluster: "apps2", user: "headlamp" } }],
    });
  });

  it("writes and restarts Headlamp where the kubeconfig differs, and leaves it alone the second time", async () => {
    const headlamp = new FakeHeadlamp();
    expect(await syncHeadlampContexts({ db: h.db, headlamp })).toBe("Headlamp offers apps1, apps2 beside the master, and restarts to read them; apps4 sealed no API address at deployment and cannot be offered");
    expect(await syncHeadlampContexts({ db: h.db, headlamp })).toBe("Headlamp offers apps1, apps2 beside the master already; apps4 sealed no API address at deployment and cannot be offered");
    expect(headlamp.written).toHaveLength(1);
  });

  it("takes a removed slave's context out", async () => {
    const headlamp = new FakeHeadlamp();
    await syncHeadlampContexts({ db: h.db, headlamp });
    h.db.delete(clusters).where(eq(clusters.name, "apps2")).run();
    await syncHeadlampContexts({ db: h.db, headlamp });
    expect((parse(headlamp.written[1]!) as { contexts: { name: string }[] }).contexts.map((c) => c.name)).toEqual(["apps1"]);
  });
});
