import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import { CredentialStore } from "../../security/store.ts";
import { createLogger, type Logger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { findUnitCallKey, keepUnitCallKey } from "#unit/server/unit-call-key.ts";
import { makeOnboardDef, OnboardParams } from "./onboard.run.ts";
import { makeOffboardDef, type OffboardPorts } from "./offboard.run.ts";
import { makePurgeDef, type PurgePorts } from "./purge.run.ts";
import { SHA, passReport, ports as onboardPorts, FakeSeeder } from "./onboard.fixture.ts";
import { RecordingTeardownSeeder } from "./teardown.fixture.ts";

// The key a stage accepts from the Manager alone lives exactly as long as the stage's Vault entry:
// the onboarding's seed keeps it on the create, and every path that deletes the entry drops it.

const logger = createLogger(
  parseConfig({
    ...REQUIRED_ENV,
    PUBLIC_URL: "https://m1.example",
    OIDC_ISSUER: "https://idp.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    MANAGER_VERSION: "test",
    DATA_DIR: "/data",
    ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);

let db: DbHandle;
let store: CredentialStore;
beforeEach(() => {
  db = openDb(":memory:");
  store = new CredentialStore({ db: db.db, logger });
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "1.2.3.4", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", host: "acme", stage: "prod", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function ctx(stepName: string, params: Readonly<Record<string, unknown>>, cleanups: Cleanup[] = []): StepCtx {
  return {
    runId: "run_key", stepName, db: db.db, creds: store, params,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: (cleanup) => { cleanups.push(cleanup); },
  };
}
const opened = async (stage: "prod" | "test"): Promise<string | null> => {
  const ref = await findUnitCallKey(store, "acme", stage);
  return ref ? (await store.open(ref.id, { purpose: "unit-call-key.run.test" })).toString("utf8") : null;
};
/** Two rows of prod's key (one rotated) and test's, which no prod teardown may touch. */
async function keepBothStages(): Promise<void> {
  await keepUnitCallKey(store, { unit: "acme", stage: "prod", key: "ACME_MANAGER_KEY", value: "a".repeat(64) });
  await keepUnitCallKey(store, { unit: "acme", stage: "prod", key: "ACME_MANAGER_KEY", value: "b".repeat(64) });
  await keepUnitCallKey(store, { unit: "acme", stage: "test", key: "ACME_MANAGER_KEY", value: "c".repeat(64) });
}
const prodRows = async (): Promise<number> => (await store.list({ subject: { kind: "unit-stage", id: "acme-prod" }, purpose: "unit-call-key" })).length;

describe("the key a unit's stage accepts from the Manager, across the runs", () => {
  it("seed-secrets keeps the minted manager-key, the value it wrote; the onboarding's abort drops it with the entry", async () => {
    const seeder = new FakeSeeder();
    const p = OnboardParams.parse({
      consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "x", repoCredentialId: "cred_pat",
      version: "1.0.0", channel: "stable", resolvedSha: SHA, builds: ["acme"], form: "deployable", stage: "prod",
      domain: "s1.example", clusterId: "cls_1", cluster: "s1", namespace: "acme-prod", unitApex: "example.com", host: "acme",
      chartPath: "deploy/chart", argoAppName: "acme-prod", report: passReport(),
      secretSpecs: [{ key: "ACME_MANAGER_KEY", required: true, generate: "manager-key" }],
    });
    const cleanups: Cleanup[] = [];
    await makeOnboardDef(onboardPorts({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!.run(ctx("seed-secrets", p, cleanups));
    expect(await opened("prod")).toBe(seeder.seeded[0]!.data["ACME_MANAGER_KEY"]);
    await cleanups.find((cleanup) => cleanup.name === "remove-ceremony-secrets")!.run(ctx("remove-ceremony-secrets", p));
    expect(await prodRows()).toBe(0);
  });

  it("offboard's remove-app-secrets drops every row of the stage's key and leaves the other stage's", async () => {
    await keepBothStages();
    const ports = { seeder: new RecordingTeardownSeeder() } as unknown as OffboardPorts;
    await makeOffboardDef(ports).steps({ appId: "app_1" }).find((s) => s.name === "remove-app-secrets")!.run(ctx("remove-app-secrets", { appId: "app_1" }));
    expect(await prodRows()).toBe(0);
    expect(await opened("test")).toBe("c".repeat(64));
  });

  it("purge's remove-app-secrets drops every row of the stage's key and leaves the other stage's", async () => {
    await keepBothStages();
    const params = { consumerName: "acme", stage: "prod" as const, clusterId: "cls_1" };
    const ports = { seeder: new RecordingTeardownSeeder() } as unknown as PurgePorts;
    await makePurgeDef(ports).steps(params).find((s) => s.name === "remove-app-secrets")!.run(ctx("remove-app-secrets", params));
    expect(await prodRows()).toBe(0);
    expect(await opened("test")).toBe("c".repeat(64));
  });
});
