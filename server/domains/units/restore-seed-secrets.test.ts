import { createPublicKey } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { seedCredentialRow } from "../../security/store.fixture.ts";
import { consumerSecretEntry, recordSecretWrites } from "../../db/secret-writes.ts";
import { FakeSeeder } from "./onboard.fixture.ts";
import { planRestoreSecrets, seedRestoredSecrets, type RestoreSecretsPorts } from "./restore-seed-secrets.ts";
import type { InstallationStore } from "#unit/server/adapters/vault/installation-store-port.ts";
import type { GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeedOutcome } from "#unit/server/adapters/vault/seeder-port.ts";

const REPO_URL = "https://github.com/acme-org/acme-app.git";
const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme
owner: acme-org
envs: [test]
chart:
  path: deploy/chart
secrets:
  - key: SMTP_PASSWORD
    required: true
  - key: JWT_SECRET
    required: true
    generate: hex32
  - key: POST_OIDC_CLIENT_SECRET
    required: true
    store:
      entry: idp/clients/post
      field: client-secret
`;

const STORE_SECRET_VALUE = "super-secret-oidc-client-token";

class RecordingSeeder extends FakeSeeder {
  postgresCalls: VaultSeedOutcome[] = [];
  mongodbCalls: VaultSeedOutcome[] = [];
  redisCalls: VaultSeedOutcome[] = [];
  mariadbCalls: VaultSeedOutcome[] = [];

  override async seedPostgres(): Promise<VaultSeedOutcome> {
    const res = await super.seedPostgres();
    this.postgresCalls.push(res);
    return res;
  }

  override async seedMongodb(): Promise<VaultSeedOutcome> {
    const res = await super.seedMongodb();
    this.mongodbCalls.push(res);
    return res;
  }

  override async seedRedis(): Promise<VaultSeedOutcome> {
    const res = await super.seedRedis();
    this.redisCalls.push(res);
    return res;
  }

  override async seedMariadb(): Promise<VaultSeedOutcome> {
    const res = await super.seedMariadb();
    this.mariadbCalls.push(res);
    return res;
  }
}

function fakeStore(entries: Record<string, Record<string, string>>): InstallationStore {
  return {
    stage: "test",
    readField: async (entry, field) => entries[entry]?.[field] ?? null,
  };
}

let db: DbHandle;

beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "test", domain: "test.example", name: "test", status: "active" }).run();
  seedCredentialRow(db.db, {
    id: "cred_pat_acme",
    kind: "pat",
    label: "repository PAT (acme-org)",
    subject: { kind: "owner", id: "acme-org" },
    purpose: "repository-pat",
  });
  db.db.insert(apps).values({
    id: "app_1",
    clusterId: "cls_1",
    name: "acme",
    host: "acme",
    stage: "test",
    repoUrl: REPO_URL,
    chartPath: "deploy/chart",
    provenance: "manager",
    status: "offboarded",
  }).run();
});

afterEach(() => {
  db.sqlite.close();
});

function makePorts(
  seeder: RecordingSeeder,
  storeEntries: Record<string, Record<string, string>> = { "idp/clients/post": { "client-secret": STORE_SECRET_VALUE } },
  gh?: GitHubConsumer,
): RestoreSecretsPorts {
  return {
    seeder,
    installationStore: fakeStore(storeEntries),
    github: gh ?? ({
      readFile: async () => MANIFEST_YAML,
    } as unknown as GitHubConsumer),
    store: {
      open: async () => Buffer.from("ghp_fake_owner_token"),
      list: async () => [{ id: "cred_pat_acme", kind: "pat", subject: { kind: "owner", id: "acme-org" }, purpose: "repository-pat" }],
    } as unknown as Pick<CredentialStore, "open" | "list">,
  };
}

function makeCtx(logs: string[], runSecrets: Record<string, string> = {}): StepCtx {
  return {
    runId: "run_restore_test",
    stepName: "provision-target",
    db: db.db,
    creds: {
      open: async () => Buffer.from("ghp_fake_repo_pat"),
      list: async () => [],
      seal: async () => ({ id: "c1", recordedAt: new Date() }),
      revoke: async () => undefined,
      find: async () => null,
      drop: async () => 0,
    } as unknown as CredentialStore,
    params: {},
    secrets: {
      get: (k: string) => (runSecrets[k] !== undefined ? Buffer.from(runSecrets[k]!, "utf8") : undefined),
      wipe: () => undefined,
    },
    signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")),
    openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined,
    attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t),
    checkpoint: () => undefined,
    readCheckpoint: () => undefined,
    registerCleanup: () => undefined,
  };
}

describe("restore-seed-secrets", () => {
  it("1. Entry gone: planRestoreSecrets returns required operator secret and warning naming ceremony secret path", async () => {
    const seeder = new RecordingSeeder();
    const ports = makePorts(seeder);
    const plan = await planRestoreSecrets(ports, db.db, { stage: "test", consumerName: "acme", repoURL: REPO_URL });

    expect(plan.requiredSecrets).toEqual(["consumer-secret:SMTP_PASSWORD"]);
    expect(plan.warnings).toEqual([
      "the Manager holds no record of secret/test/consumer/acme/app (an offboard removes it) — this restore seeds it where Vault holds none, create-only: 1 typed by you, the rest minted or copied from the installation's store; if Vault holds the entry without a record here, your typed values are discarded and the standing entry stays",
    ]);
  });

  it("2. Entry stands: planRestoreSecrets returns empty secrets and warnings, never calling github.readFile", async () => {
    recordSecretWrites(db.db, {
      entry: consumerSecretEntry("test", "acme"),
      keys: ["SMTP_PASSWORD", "JWT_SECRET", "POST_OIDC_CLIENT_SECRET"],
      act: "seeded",
      runId: "run_prev",
    });

    const seeder = new RecordingSeeder();
    const throwingGithub: GitHubConsumer = {
      readFile: async () => {
        throw new Error("github.readFile must not be called when entry stands");
      },
    } as unknown as GitHubConsumer;

    const ports: RestoreSecretsPorts = {
      ...makePorts(seeder),
      github: throwingGithub,
    };

    const plan = await planRestoreSecrets(ports, db.db, { stage: "test", consumerName: "acme", repoURL: REPO_URL });
    expect(plan).toEqual({ requiredSecrets: [], warnings: [] });
  });

  it("3. Entry gone, run: seeds redis and mariadb, ceremony entry with 3 keys, and no secret value is logged", async () => {
    const seeder = new RecordingSeeder();
    const ports = makePorts(seeder);
    const logs: string[] = [];
    const typedPassword = "operator-typed-smtp-secret-987";
    const ctx = makeCtx(logs, { "consumer-secret:SMTP_PASSWORD": typedPassword });

    await seedRestoredSecrets(
      ports,
      ctx,
      {
        stage: "test",
        consumerName: "acme",
        repoURL: REPO_URL,
        services: ["redis", "mariadb"],
        mongodb: "shared",
        redis: "standalone",
      },
      "cred_pat_acme",
    );

    expect(seeder.redisCalls).toHaveLength(1);
    expect(seeder.mariadbCalls).toHaveLength(1);
    expect(seeder.postgresCalls).toHaveLength(0);
    expect(seeder.mongodbCalls).toHaveLength(0);

    expect(seeder.seeded).toHaveLength(1);
    const seededData = seeder.seeded[0]!.data;
    expect(seededData["SMTP_PASSWORD"]).toBe(typedPassword);
    expect(seededData["POST_OIDC_CLIENT_SECRET"]).toBe(STORE_SECRET_VALUE);
    expect(seededData["JWT_SECRET"]).toBeDefined();
    expect(seededData["JWT_SECRET"]).toHaveLength(64);

    const logText = logs.join("\n");
    expect(logText).not.toContain(typedPassword);
    expect(logText).not.toContain(STORE_SECRET_VALUE);
    expect(logText).not.toContain(seededData["JWT_SECRET"]!);
  });

  it("4. Entry stands, run: ceremony entry is not seeded while instance seeds still run", async () => {
    recordSecretWrites(db.db, {
      entry: consumerSecretEntry("test", "acme"),
      keys: ["SMTP_PASSWORD", "JWT_SECRET", "POST_OIDC_CLIENT_SECRET"],
      act: "seeded",
      runId: "run_prev",
    });

    const seeder = new RecordingSeeder();
    const ports = makePorts(seeder);
    const logs: string[] = [];
    const ctx = makeCtx(logs);

    await seedRestoredSecrets(
      ports,
      ctx,
      {
        stage: "test",
        consumerName: "acme",
        repoURL: REPO_URL,
        services: ["redis", "mariadb"],
        mongodb: "shared",
        redis: "standalone",
      },
      "cred_pat_acme",
    );

    expect(seeder.redisCalls).toHaveLength(1);
    expect(seeder.mariadbCalls).toHaveLength(1);
    expect(seeder.seeded).toHaveLength(0);

    const logText = logs.join("\n");
    expect(logText).toContain("secret/test/consumer/acme/app stands — its secrets come back as they are, nothing seeded");
  });

  it("5. Entry gone, store holds no value: planRestoreSecrets throws naming POST_OIDC_CLIENT_SECRET", async () => {
    const seeder = new RecordingSeeder();
    const ports = makePorts(seeder, {});

    await expect(
      planRestoreSecrets(ports, db.db, { stage: "test", consumerName: "acme", repoURL: REPO_URL }),
    ).rejects.toThrow(/POST_OIDC_CLIENT_SECRET/);
  });

  it("6. Entry gone, manifest with no secrets: planRestoreSecrets returns empty secrets and warnings", async () => {
    const seeder = new RecordingSeeder();
    const ports: RestoreSecretsPorts = {
      ...makePorts(seeder),
      github: {
        readFile: async () => `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme
owner: acme-org
envs: [test]
chart:
  path: deploy/chart
`,
      } as unknown as GitHubConsumer,
    };

    const plan = await planRestoreSecrets(ports, db.db, { stage: "test", consumerName: "acme", repoURL: REPO_URL });
    expect(plan).toEqual({ requiredSecrets: [], warnings: [] });
  });

  it("7. Manifest with smtpEntry naming generated RSA dkimKey sets dkimPublicKey on app row", async () => {
    const seeder = new RecordingSeeder();
    const ports: RestoreSecretsPorts = {
      ...makePorts(seeder),
      github: {
        readFile: async () => `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme
owner: acme-org
envs: [test]
chart:
  path: deploy/chart
secrets:
  - key: MAIL_DKIM_PRIVATE_KEY
    required: true
    generate: rsa2048
smtpEntry:
  service: acme-mta
  port: 2525
  dkimKey: MAIL_DKIM_PRIVATE_KEY
`,
      } as unknown as GitHubConsumer,
    };
    const logs: string[] = [];
    const ctx = makeCtx(logs);

    await seedRestoredSecrets(
      ports,
      ctx,
      {
        stage: "test",
        consumerName: "acme",
        repoURL: REPO_URL,
        services: [],
      },
      "cred_pat_acme",
    );

    const appRow = db.db.select({ k: apps.dkimPublicKey }).from(apps).where(eq(apps.name, "acme")).get();
    expect(appRow?.k).toBeDefined();
    expect(appRow?.k).toContain("-----BEGIN PUBLIC KEY-----");
    const privatePem = seeder.seeded[0]!.data["MAIL_DKIM_PRIVATE_KEY"]!;
    expect(appRow?.k).toBe(createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString());
  });

  it("reads the manifest at deploy/<stage>", async () => {
    const seeder = new RecordingSeeder();
    const fakeGh = new FakeGitHubConsumer();
    fakeGh.seedFile("acme-org", "acme-app", "deploy/platform.yaml", MANIFEST_YAML);
    const ports = makePorts(seeder, undefined, fakeGh);
    await planRestoreSecrets(ports, db.db, { stage: "test", consumerName: "acme", repoURL: REPO_URL });
    expect(fakeGh.fileReads).toContainEqual(expect.objectContaining({ path: "deploy/platform.yaml", ref: "deploy/test" }));
  });
});
