import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerConsumerRoutes } from "./api.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { Registrations } from "./registrations.ts";
import type { DetectedScanView } from "../../../shared/api-types.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AppEnv } from "../../http/app-env.ts";

// GET /api/consumers/detected — the ROUTE, which is where the scan's two independent halves are
// COMPOSED. The halves themselves are covered in consumer-detected.test.ts; what only shows up here is
// how they fail: the registration diff fails whole (`error`), the cluster scan fails per cluster
// (`unscanned`), and neither may be told in the other's words or empty the other's list. That
// composition is the whole reason the route exists as more than a passthrough.

const SELECTOR = "hostyour.cloud/consumer=true";
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
});
afterEach(() => db.sqlite.close());

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

/** A resolver whose one cluster holds `namespaces`, each smoked as one ready workload. */
function resolverHolding(namespaces: readonly string[]): FakeClusterKubeResolver {
  return new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({
      namespacesByLabel: { [SELECTOR]: namespaces },
      smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "api", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
    }),
    argoReader: new FakeMasterArgoReader(),
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: "argocd",
  });
}

/** A Registrations whose registration reads REJECT — the unreadable install branch. */
const brokenRegistrations = (): Registrations => ({ listConsumerRegistrations: () => Promise.reject(new Error("install branch unreachable")) }) as unknown as Registrations;

async function makeApp(opts: { resolver?: FakeClusterKubeResolver; registrations?: Registrations }): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const store = new CredentialStore({ db: db.db, logger });
  const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) =>
      registerConsumerRoutes(a, {
        executor, db: db.db, store, onboardingEnabled: true,
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
        ...(opts.registrations ? { registrations: opts.registrations } : {}),
      }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

const scan = async (app: Hono<AppEnv>, cookie: string): Promise<DetectedScanView> =>
  (await (await app.request("/api/consumers/detected", authed(cookie))).json()) as DetectedScanView;

describe("GET /api/consumers/detected — the two halves composed", () => {
  it("answers both halves in one response", async () => {
    const registrations = new Registrations(new FakePlatformRepo(), async () => ({ name: "s1", stage: "prod" }));
    const { app, cookie } = await makeApp({ resolver: resolverHolding(["ghost"]), registrations });
    const body = await scan(app, cookie);
    expect(body.error).toBeUndefined();
    expect(body.detected).toEqual([]);
    expect(body.clusterOrphans.map((o) => o.name)).toEqual(["ghost"]);
    expect(body.unscanned).toEqual([]);
  });

  it("keeps the cluster orphans found on a HEALTHY cluster when another cluster's read fails", async () => {
    // The composition property this route exists for: a failure has to stay where it happened. One
    // slave being unreachable must not empty the answer for the cluster that was read fine, and must
    // not vanish either.
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "1.2.3.6", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", status: "active" }).run();
    const registrations = new Registrations(new FakePlatformRepo(), async () => ({ name: "s1", stage: "prod" }));
    const resolver = resolverHolding(["ghost"]);
    resolver.set("cls_2", {
      clusterReader: new FakeClusterReader({ throwOnListNamespaces: new Error("dial tcp 100.64.0.11:16443: connect: no route to host") }),
      argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "s2",
    });
    const { app, cookie } = await makeApp({ resolver, registrations });
    const body = await scan(app, cookie);
    expect(body.error).toBeUndefined();
    expect(body.clusterOrphans.map((o) => o.name)).toEqual(["ghost"]);
    expect(body.unscanned.map((u) => u.clusterId)).toEqual(["cls_2"]);
  });

  it("an unreadable install branch fails BOTH halves, and each says so in its own words", async () => {
    // The two halves share ONE input — the registrations — so this is the one failure that reaches
    // both, and each has to report it in its own vocabulary rather than one covering for the other.
    // The registration diff cannot run at all (`error`). The cluster half CAN list the namespaces, but
    // it has nothing to subtract: without the registration names, every healthy registered consumer on
    // the cluster would be reported as having no registration — a lie about every one of them. So it
    // refuses that cluster by name (`unscanned`) instead of guessing, and the operator sees which
    // clusters were not answered for.
    const { app, cookie } = await makeApp({ resolver: resolverHolding(["ghost"]), registrations: brokenRegistrations() });
    const body = await scan(app, cookie);
    expect(body.error).toContain("install branch unreachable");
    expect(body.detected).toEqual([]);
    expect(body.clusterOrphans).toEqual([]);
    expect(body.unscanned).toHaveLength(1);
    expect(body.unscanned[0]).toMatchObject({ clusterId: "cls_1", domain: "s1.example" });
    expect(body.unscanned[0]!.reason).toContain("install branch unreachable");
  });

  it("degrades the CLUSTER half alone when no resolver is wired, and still answers the registration half", async () => {
    const registrations = new Registrations(new FakePlatformRepo(), async () => ({ name: "s1", stage: "prod" }));
    const { app, cookie } = await makeApp({ registrations });
    const body = await scan(app, cookie);
    expect(body.error).toBeUndefined();
    expect(body.clusterOrphans).toEqual([]);
    expect(body.unscanned).toEqual([]);
  });

  it("degrades the WHOLE route with a reason when consumer onboarding is not wired", async () => {
    const { app, cookie } = await makeApp({});
    expect(await scan(app, cookie)).toEqual({ detected: [], skipped: [], clusterOrphans: [], unscanned: [], reason: "onboarding-not-configured" });
  });
});
