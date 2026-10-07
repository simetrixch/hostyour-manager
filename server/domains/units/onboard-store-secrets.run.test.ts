import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, OnboardParams } from "./onboard.run.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { InstallationStore } from "#unit/server/adapters/vault/installation-store-port.ts";
import { SHA, MANIFEST, passReport, ports, FakeSeeder } from "./onboard.fixture.ts";

// A key the installer minted into the installation's store (manifest `store`): the onboarding asks
// the operator nothing for it, refuses the plan where the store holds no value and names where it
// looked, and copies the value into the consumer's own entry at the seed without logging it.

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  recordTestOwners(db.db);
  seedUnitSizes(db.db);
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

const CLIENT_SECRET = "post-client-secret-from-the-store";
const STORE_KEY = { key: "POST_OIDC_CLIENT_SECRET", required: true, store: { entry: "idp/clients/post", field: "client-secret" } };
const SECRETS = [STORE_KEY, { key: "SMTP_PASSWORD", required: true }];
const STORE_MANIFEST: ConsumerManifest = { ...MANIFEST, secrets: SECRETS } as ConsumerManifest;

/** The installation's store at stage prod, holding `entries` (entry → field → value). */
function storeHolding(entries: Record<string, Record<string, string>>): InstallationStore & { asked: string[] } {
  const asked: string[] = [];
  return {
    stage: "prod",
    asked,
    readField: async (entry, field) => {
      asked.push(`${entry}:${field}`);
      return entries[entry]?.[field] ?? null;
    },
  };
}

const request = { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", stage: "prod", clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat" };
const plan = (installationStore?: InstallationStore) =>
  makeOnboardDef(ports({ runner: new FakeGateRunner({ report: passReport(STORE_MANIFEST) }), ...(installationStore ? { installationStore } : {}) })).planStream!(
    request,
    { db: db.db, log: () => undefined, signal: new AbortController().signal },
  );

function ctx(p: OnboardParams, logs: string[], runSecrets: Record<string, string>): StepCtx {
  return {
    runId: "run_onb", stepName: "seed-secrets", db: db.db, creds: { list: () => Promise.resolve([]) } as unknown as CredentialStore, params: p,
    secrets: { get: (name: string) => (runSecrets[name] === undefined ? undefined : Buffer.from(runSecrets[name]!, "utf8")), wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("a consumer key the installation's store holds", () => {
  it("is not asked of the operator; the plan reads the entry and asks only the typed key", async () => {
    const store = storeHolding({ "idp/clients/post": { "client-secret": CLIENT_SECRET } });
    const res = await plan(store);
    expect(res.outcome).toBe("planned");
    if (res.outcome !== "planned") return;
    expect(res.plan.requiredSecrets).toEqual(["consumer-secret:SMTP_PASSWORD"]);
    expect(store.asked).toEqual(["idp/clients/post:client-secret"]);
    expect(JSON.stringify(res)).not.toContain(CLIENT_SECRET);
  });

  it("refuses the plan where the entry holds no such value, or where this Manager reads no store, naming where it looked", async () => {
    const missing = await plan(storeHolding({}));
    expect(missing.outcome).toBe("rejected");
    expect(missing.outcome === "rejected" && missing.summary).toMatch(/POST_OIDC_CLIENT_SECRET comes from secret\/prod\/idp\/clients\/post \(field client-secret\), which holds no such value/);
    const none = await plan();
    expect(none.outcome === "rejected" && none.summary).toMatch(/POST_OIDC_CLIENT_SECRET come from the installation's store, and this Manager reads none/);
  });

  it("is copied into the consumer's entry at the seed beside the typed key, and only its location is logged", async () => {
    const seeder = new FakeSeeder();
    const store = storeHolding({ "idp/clients/post": { "client-secret": CLIENT_SECRET } });
    const p = OnboardParams.parse({
      consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme", repoCredentialId: "cred_pat", version: "1.0.0", channel: "stable", resolvedSha: SHA,
      builds: ["acme-api"], form: "deployable", stage: "prod", domain: "s1.example", clusterId: "cls_1", cluster: "s1", namespace: "acme-prod", unitApex: "example.com",
      host: "acme", chartPath: "deploy/chart", argoAppName: "acme-prod", report: passReport(STORE_MANIFEST), secretSpecs: SECRETS,
    });
    const logs: string[] = [];
    await makeOnboardDef(ports({ seeder, installationStore: store })).steps(p).find((s) => s.name === "seed-secrets")!.run(ctx(p, logs, { "consumer-secret:SMTP_PASSWORD": "typed" }));
    expect(seeder.seeded[0]!.data).toEqual({ POST_OIDC_CLIENT_SECRET: CLIENT_SECRET, SMTP_PASSWORD: "typed" });
    expect(logs.some((l) => l.includes("copied from the installation's store: POST_OIDC_CLIENT_SECRET from secret/prod/idp/clients/post (field client-secret)"))).toBe(true);
    for (const l of logs) expect(l).not.toContain(CLIENT_SECRET);
  });

  it("fails the seed, naming the location, where the value went missing since the plan", async () => {
    const p = OnboardParams.parse({
      consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme", repoCredentialId: "cred_pat", version: "1.0.0", channel: "stable", resolvedSha: SHA,
      builds: ["acme-api"], form: "deployable", stage: "prod", domain: "s1.example", clusterId: "cls_1", cluster: "s1", namespace: "acme-prod", unitApex: "example.com",
      host: "acme", chartPath: "deploy/chart", argoAppName: "acme-prod", report: passReport(STORE_MANIFEST), secretSpecs: SECRETS,
    });
    const seeder = new FakeSeeder();
    const step = makeOnboardDef(ports({ seeder, installationStore: storeHolding({}) })).steps(p).find((s) => s.name === "seed-secrets")!;
    await expect(step.run(ctx(p, [], { "consumer-secret:SMTP_PASSWORD": "typed" }))).rejects.toThrow(/secret\/prod\/idp\/clients\/post \(field client-secret\), which holds no such value/);
    expect(seeder.seeded).toEqual([]);
  });
});
