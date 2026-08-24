import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerReleaseRoutes } from "./api.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { searchPlatformApps } from "../registry-cleanup/search.ts";
import { FakeCarrierRepo, pinFile } from "../registry-cleanup/carriers.fixture.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ReleasesView } from "../../../shared/api-types.ts";

// The question this surface exists for is "which release does this cluster stand on, and which
// version does each of its apps run" — so what these cases guard is that every number in the answer
// came out of THAT installation's own files, and that a missing statement stays missing.

const config = parseConfig({
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test",
  DATA_DIR: "/d",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

const MASTER = "m1.example.com";
const SLAVE = "s1.example.com";
const LONELY = "s2.example.com"; // registered, install branch never cut
const MASTER_TAG = "1.2.0-stable-20260728120000";

const map = (fqdn: string, stage: string, role: string, release?: string): string =>
  `stage: ${stage}\nrole: ${role}\n${release ? `release: ${release}\n` : ""}\nglobal:\n  domain: ${fqdn}\n  buildPlane: ${MASTER}\n`;

/** The platform repo of an installation whose master is pinned and whose slave is not. Both branches
 *  carry app pins at BOTH stages, which is what a real install branch looks like — the trunk renders
 *  every stage's values file and only the cluster's own stage is deployed. */
function seededCloud(): FakeCarrierRepo {
  const cloud = new FakeCarrierRepo({ booksBranch: MASTER });
  cloud.seed(MASTER, clusterMarkingPath(MASTER), map(MASTER, "prod", "master", MASTER_TAG));
  cloud.seed(MASTER, clusterMarkingPath(SLAVE), map(SLAVE, "dev", "slave"));
  cloud.seed(MASTER, clusterMarkingPath(LONELY), map(LONELY, "dev", "slave"));
  cloud.seed(MASTER, "apps/manager/values-prod.yaml", pinFile([["manager", "1.2.0-stable-20260728120000-abc1234"]]));
  cloud.seed(MASTER, "apps/manager/values-dev.yaml", pinFile([["manager", "9.9.9-alpha-20260101000000-dddddd1"]]));
  cloud.seed(MASTER, "apps/auth/values-prod.yaml", pinFile([["auth", "1.1.0-stable-20260701000000-bbb2222"]]));
  cloud.seed(SLAVE, "apps/manager/values-dev.yaml", pinFile([["manager", "1.3.0-alpha-20260801000000-ccc3333"]]));
  return cloud;
}

describe("GET /api/releases — which release an installation stands on, and which version its apps run", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(deps: { cloud?: FakeCarrierRepo; readPins?: () => Promise<never> } = {}): Promise<{
    app: Hono<AppEnv>;
    cookie: string;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-releases-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    for (const [id, name, role, cls, domain, stage] of [
      ["srv_m", "m1", "master", "cls_m", MASTER, "prod"],
      ["srv_s", "s1", "slave", "cls_s", SLAVE, "dev"],
      ["srv_l", "s2", "slave", "cls_l", LONELY, "dev"],
    ] as const) {
      db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES (?,?,?,'root',?,'healthy')").run(id, name, domain, role);
      db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain) VALUES (?,?,?,?)").run(cls, id, stage, domain);
    }
    const session = new SessionCodec(db.db, config);
    const cloud = deps.cloud;
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) =>
        registerReleaseRoutes(a, {
          db: db.db,
          ...(cloud ? { platformRepo: cloud } : {}),
          // The pins come from THE pin search's platform-app class, exactly as boot/wire.ts binds it.
          ...(deps.readPins ? { readPlatformAppPins: deps.readPins } : cloud ? { readPlatformAppPins: () => searchPlatformApps(cloud) } : {}),
        }),
    });
    return { app, cookie: await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" }) };
  }

  const get = async (app: Hono<AppEnv>, cookie: string): Promise<ReleasesView> =>
    (await (await app.request("/api/releases", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })).json()) as ReleasesView;

  it("reports the release each cluster's OWN map pins", async () => {
    const { app, cookie } = await make({ cloud: seededCloud() });
    const view = await get(app, cookie);
    const master = view.installations.find((i) => i.branch === MASTER);
    expect(master?.release).toEqual({ kind: "pinned", tag: MASTER_TAG });
    expect(master).toMatchObject({ serverId: "srv_m", name: "m1", stage: "prod", role: "master" });
  });

  it("a cluster whose map carries no release reads UNKNOWN — never the tag of the cluster beside it", async () => {
    // THE counter-probe of this surface. s1's map has no release key, and m1's stands one line away
    // in the same directory; the only honest answer for s1 is that nothing states one.
    const { app, cookie } = await make({ cloud: seededCloud() });
    const slave = view(await get(app, cookie), SLAVE);
    expect(slave.release.kind).toBe("unknown");
    expect(slave.release).not.toHaveProperty("tag");
    expect(JSON.stringify(slave.release)).not.toContain(MASTER_TAG);
    if (slave.release.kind === "unknown") expect(slave.release.reason).toMatch(/carries no release key/);
  });

  it("an installation's apps are read off ITS branch at ITS stage — not the trunk's, not another stage's", async () => {
    const { app, cookie } = await make({ cloud: seededCloud() });
    const answer = await get(app, cookie);
    // The master is prod: the two prod pins, and never the dev file standing beside them.
    expect(view(answer, MASTER).apps).toEqual([
      { app: "auth", build: "auth", image: "auth", tag: "1.1.0-stable-20260701000000-bbb2222" },
      { app: "manager", build: "manager", image: "manager", tag: "1.2.0-stable-20260728120000-abc1234" },
    ]);
    // The slave is dev, and its own branch pins a different manager than the master's dev file.
    expect(view(answer, SLAVE).apps).toEqual([
      { app: "manager", build: "manager", image: "manager", tag: "1.3.0-alpha-20260801000000-ccc3333" },
    ]);
  });

  it("the chart, the build and the image are three separate fields, and none stands in for another", async () => {
    // EVERY OTHER SEED IN THIS FILE SPELLS ALL THREE THE SAME WAY, because `pinFile` writes
    // `name: <image>` beside `image: <image>` — so a projection that read the chart directory where
    // the build name belongs, or the image where the chart belongs, produced identical output and
    // no case here could see it. This seed spells them apart: the chart directory is `post`, the
    // builds[] entry is named `post-api`, and the image it names is `digita-post`.
    const cloud = seededCloud();
    cloud.seed(
      MASTER,
      "apps/post/values-prod.yaml",
      ["builds:", "  - name: post-api", "    image: digita-post", '    tag: "2.0.0-stable-20260815000000-eee5555"', ""].join("\n"),
    );
    const { app, cookie } = await make({ cloud });

    expect(view(await get(app, cookie), MASTER).apps).toContainEqual({
      app: "post",
      build: "post-api",
      image: "digita-post",
      tag: "2.0.0-stable-20260815000000-eee5555",
    });
  });

  it("a cluster whose install branch does not exist carries apps NULL, not an empty list", async () => {
    // Empty would read as "this installation pins nothing", which is a claim about a branch nobody
    // could open. Null says there was nothing to read.
    const { app, cookie } = await make({ cloud: seededCloud() });
    expect(view(await get(app, cookie), LONELY).apps).toBeNull();
  });

  it("a branch that exists and pins no app carries an EMPTY list — the opposite fact from the one above", async () => {
    const cloud = seededCloud();
    cloud.seed(LONELY, clusterMarkingPath("unused.example.com"), map("unused.example.com", "dev", "slave"));
    const { app, cookie } = await make({ cloud });
    expect(view(await get(app, cookie), LONELY).apps).toEqual([]);
  });

  it("a pin search that cannot run sets `error` and nulls every apps list — the release pins still answer", async () => {
    const cloud = seededCloud();
    const { app, cookie } = await make({
      cloud,
      readPins: () => Promise.reject(new Error("branch listing truncated")),
    });
    const answer = await get(app, cookie);
    expect(answer.error).toMatch(/branch listing truncated/);
    expect(answer.installations.map((i) => i.apps)).toEqual([null, null, null]);
    expect(view(answer, MASTER).release).toEqual({ kind: "pinned", tag: MASTER_TAG });
  });

  it("an unconfigured platform repo answers the rows, says WHY there are no versions, and invents none", async () => {
    const { app, cookie } = await make();
    const answer = await get(app, cookie);
    expect(answer.reason).toBe("onboarding-not-configured");
    expect(answer.installations).toHaveLength(3);
    for (const i of answer.installations) {
      expect(i.apps).toBeNull();
      expect(i.release.kind).toBe("unknown");
    }
    expect(view(answer, MASTER).release).toEqual({
      kind: "unknown",
      reason: expect.stringContaining("wire-units.ts:204"),
    });
  });

  it("unauthenticated → 401", async () => {
    const { app } = await make({ cloud: seededCloud() });
    expect((await app.request("/api/releases", { headers: { accept: "application/json" } })).status).toBe(401);
  });
});

/** One installation out of the answer, by the branch it stands on. Throws rather than returning
 *  undefined, so a case that lost a row fails on the row and not three lines later on a property. */
function view(answer: ReleasesView, branch: string): ReleasesView["installations"][number] {
  const found = answer.installations.find((i) => i.branch === branch);
  if (!found) throw new Error(`no installation for ${branch} in ${JSON.stringify(answer.installations.map((i) => i.branch))}`);
  return found;
}
