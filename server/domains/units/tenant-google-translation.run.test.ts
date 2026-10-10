import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { getRun, getRunEnding, getRunParams, getRunStepCheckpoint, readEvents } from "../../executor/read.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { listSecretWrites } from "../../db/secret-writes.ts";
import type { GoogleTranslationWriteInput } from "#unit/server/adapters/vault/seeder-port.ts";
import { GOOGLE_TRANSLATION_EXTERNAL_SECRET, makeTenantSetGoogleTranslationDef, readGoogleTranslationSettings, type TenantSetGoogleTranslationPorts } from "./tenant-google-translation.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";

// tenant-set-google-translation through the real Executor: the typed settings written whole into the
// tenant's one entry, ESO asked to write every app's Secret again, the restarts only once it has, and
// no typed value anywhere but Vault.

const GUID = "zsjs023ctne0";
const SHOW = `${GUID}-show-prod`;
const SHOP = `${GUID}-shop-prod`;
const ENTRY = `prod/tenants/${GUID}/google-translation`;
const PROJECT = "acme-translate-42";
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nplanted-key-body\\n-----END PRIVATE KEY-----\\n";
const ACCOUNT = JSON.stringify({ type: "service_account", client_email: "t@acme-translate-42.iam.gserviceaccount.com", private_key: PRIVATE_KEY });

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

const googleRow = (refreshTime: string, key = ENTRY) =>
  ({ name: GOOGLE_TRANSLATION_EXTERNAL_SECRET, ready: true, reason: "SecretSynced", targetSecret: GOOGLE_TRANSLATION_EXTERNAL_SECRET, refreshTime, remoteKeys: [key] });

/** ESO as the live cluster answers: a refresh request moves refreshTime, except in `silent`. */
class EsoClusterReader extends FakeClusterReader {
  silent = new Set<string>();
  restartsAtRefresh: number[] = [];
  override async refreshExternalSecret(namespace: string, name: string): Promise<void> {
    await super.refreshExternalSecret(namespace, name);
    this.restartsAtRefresh.push(this.restarted.length);
    if (!this.silent.has(namespace)) this.setExternalSecrets(namespace, [googleRow("2026-10-08T12:00:05Z")]);
  }
}

describe("tenant-set-google-translation through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A tenant with the members auth, show and shop, and an offboarded app old. Show's and shop's charts
   *  render the ExternalSecret; auth's does not. */
  function make(opts: { externalSecret?: boolean; shopKey?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-google-translation-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", status: "active" }).run();
    db.db.insert(tenantApps).values([
      { id: "tna_show", tenantId: "tnt_1", name: "show", status: "active" },
      { id: "tna_shop", tenantId: "tnt_1", name: "shop", status: "active" },
      { id: "tna_old", tenantId: "tnt_1", name: "old", status: "offboarded" },
    ]).run();
    const kube = new EsoClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 }, workloadsPerNamespace: { [SHOW]: 2, [SHOP]: 3, [`${GUID}-auth-prod`]: 1 } });
    if (opts.externalSecret ?? true) {
      kube.setExternalSecrets(SHOW, [googleRow("2026-10-08T12:00:00Z")]);
      kube.setExternalSecrets(SHOP, [googleRow("2026-10-08T12:00:00Z", opts.shopKey)]);
    }
    const writes: GoogleTranslationWriteInput[] = [];
    const def = makeTenantSetGoogleTranslationDef({
      registrations: new TenantRegistrations(new FakePlatformRepo()),
      resolver: new FakeClusterKubeResolver({ clusterReader: kube, argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }),
      deployRepoUrl: "https://github.com/acme/acme-deploy.git", argoWatchTimeoutMs: 1000,
      seeder: { replaceGoogleTranslation: async (input: GoogleTranslationWriteInput) => { writes.push(input); } },
      refreshWaitMs: 50, refreshPollMs: 5,
    } as unknown as TenantSetGoogleTranslationPorts);
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-google-translation", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")),
    });
    /** Every text the run left in the database: its plan, its params, its log, its checkpoints and its error. */
    const traces = (runId: string): string => JSON.stringify([
      getRun(db.db, runId), getRunParams(db.db, runId), readEvents(db.db, runId), getRunEnding(db.db, runId),
      getRun(db.db, runId)?.steps.map((st) => getRunStepCheckpoint(db.db, runId, st.name)),
    ]);
    const stepError = (runId: string): string => getRunEnding(db.db, runId)?.error ?? "";
    return { db, executor, kube, writes, traces, stepError };
  }

  async function type(h: ReturnType<typeof make>, typed: Record<string, string>): Promise<string> {
    const { runId } = await h.executor.plan("tenant-set-google-translation", { tenantId: "tnt_1" });
    await h.executor.approve(runId, Object.fromEntries(Object.entries(typed).map(([k, v]) => [`google-translation:${k}`, Buffer.from(v, "utf8")])));
    await h.executor.settle(runId);
    return runId;
  }

  it("writes all four properties into the tenant's entry, refreshes every app that reads it, and restarts them only once ESO has written every Secret", async () => {
    const h = make();
    const runId = await type(h, { project: ` ${PROJECT}\n`, "service-account": ACCOUNT });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.writes).toEqual([{ stage: "prod", guid: GUID, data: { project: PROJECT, "service-account": ACCOUNT, location: "", glossary: "" } }]);
    expect(listSecretWrites(h.db.db, ENTRY).map((w) => [w.key, w.act, w.runId]).sort()).toEqual(
      ["glossary", "location", "project", "service-account"].map((k) => [k, "set", runId]));
    expect(h.kube.refreshedExternalSecrets.sort()).toEqual([`${SHOP}/${GOOGLE_TRANSLATION_EXTERNAL_SECRET}`, `${SHOW}/${GOOGLE_TRANSLATION_EXTERNAL_SECRET}`]);
    expect(h.kube.restartsAtRefresh).toEqual([0, 0]);
    // The identity provider's chart renders no Google settings, so it is not rolled.
    expect(h.kube.restarted.map((r) => r.namespace).sort()).toEqual([SHOP, SHOW]);
    expect(new Set(h.kube.restarted.map((r) => r.stampedAt)).size).toBe(1);
  });

  it("PLANTED DEFECT: an app whose ExternalSecret still reads its own entry — refused before the write, naming it", async () => {
    const h = make({ shopKey: `prod/tenants/${GUID}/google-translation/shop` });
    const runId = await type(h, { project: PROJECT, "service-account": ACCOUNT });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.stepError(runId)).toContain(`${SHOP} reads prod/tenants/${GUID}/google-translation/shop`);
    expect(h.stepError(runId)).not.toContain(SHOW);
    expect(h.writes).toEqual([]);
    expect(h.kube.refreshedExternalSecrets).toEqual([]);
    expect(h.kube.restarted).toEqual([]);
  });

  it("leaves no typed value in the plan, the log, a checkpoint or an error", async () => {
    const h = make();
    const runId = await type(h, { project: PROJECT, "service-account": ACCOUNT, location: "europe-west1", glossary: "shop-terms" });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    const traces = h.traces(runId);
    for (const value of [PROJECT, "planted-key-body", "europe-west1", "shop-terms"]) expect(traces).not.toContain(value);
    expect(h.writes[0]?.data).toMatchObject({ location: "europe-west1", glossary: "shop-terms" });
  });

  it("PLANTED DEFECT: ESO never writes one app's Secret again — the step fails naming it, and no engine is restarted", async () => {
    const h = make();
    h.kube.silent.add(SHOP);
    const runId = await type(h, { project: PROJECT, "service-account": ACCOUNT });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.stepError(runId)).toContain(`was not written again within 0s of the refresh request in ${SHOP} (Ready)`);
    expect(h.stepError(runId)).not.toContain(SHOW);
    expect(h.writes).toHaveLength(1);
    expect(h.kube.restarted).toEqual([]);
  });

  it("PLANTED DEFECT: no ExternalSecret renders the settings — fails before any refresh or restart", async () => {
    const h = make({ externalSecret: false });
    const runId = await type(h, { project: PROJECT, "service-account": ACCOUNT });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.stepError(runId)).toContain(`no member namespace of tenant ${GUID} holds the ExternalSecret ${GOOGLE_TRANSLATION_EXTERNAL_SECRET}`);
    expect(h.writes).toEqual([]);
    expect(h.kube.refreshedExternalSecrets).toEqual([]);
    expect(h.kube.restarted).toEqual([]);
  });

  it("PLANTED DEFECT: a service account that is not a key file is refused before the write, without quoting it", async () => {
    for (const account of [`{"private_key": "${PRIVATE_KEY}"`, JSON.stringify({ type: "authorized_user", private_key: PRIVATE_KEY })]) {
      const h = make();
      const runId = await type(h, { project: PROJECT, "service-account": account });
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      expect(h.writes).toEqual([]);
      expect(h.traces(runId)).not.toContain("planted-key-body");
    }
  });

  it("names whether settings were typed before", async () => {
    const h = make();
    const first = await h.executor.plan("tenant-set-google-translation", { tenantId: "tnt_1" });
    expect(getRun(h.db.db, first.runId)?.summary).toContain("No settings were typed for this tenant yet");
    expect(getRun(h.db.db, first.runId)?.requiredSecrets).toEqual(["google-translation:project", "google-translation:service-account"]);
    await h.executor.deleteRun(first.runId);
    const typed = await type(h, { project: PROJECT, "service-account": ACCOUNT });
    const again = await h.executor.plan("tenant-set-google-translation", { tenantId: "tnt_1" });
    expect(getRun(h.db.db, again.runId)?.summary).toContain(`typed by run ${typed}`);
  });
});

describe("readGoogleTranslationSettings", () => {
  const typed = (values: Record<string, string>) => (key: string) => values[key.replace("google-translation:", "")];

  it("takes a project, a key file and blanks for the rest", () => {
    expect(readGoogleTranslationSettings(typed({ project: PROJECT, "service-account": ACCOUNT }))).toEqual({ project: PROJECT, "service-account": ACCOUNT, location: "", glossary: "" });
  });

  it("PLANTED DEFECT: refuses a missing project, a path character in a name, and a key file without its key, naming no value", () => {
    expect(() => readGoogleTranslationSettings(typed({ "service-account": ACCOUNT }))).toThrow(/no project was typed/);
    expect(() => readGoogleTranslationSettings(typed({ project: PROJECT, "service-account": ACCOUNT, glossary: "a/../b" }))).toThrow(/the glossary holds a character/);
    expect(() => readGoogleTranslationSettings(typed({ project: PROJECT, "service-account": JSON.stringify({ client_email: "x@y" }) }))).toThrow(/no client_email and private_key/);
    expect(() => readGoogleTranslationSettings(typed({ project: PROJECT, "service-account": "planted-key-body" }))).toThrow(/^(?!.*planted-key-body).*not JSON/);
  });
});
