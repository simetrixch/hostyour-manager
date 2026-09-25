import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOnboardDef, OnboardParams, type DeployableOnboardParams } from "./onboard.run.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SHA, passReport, ports, FakeSeeder } from "./onboard.fixture.ts";

// A mail sender's DKIM key: seed-secrets mints the declared rsa2048 key like every generated secret,
// and on the create that put the private half into Vault it keeps the PUBLIC half on the unit's row —
// the half the Mail page publishes. A re-run over an entry that stands mints nothing that lands, and
// writes nothing to the row.

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "a1", host: "157.90.201.186", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "post", stage: "prod", host: "post", status: "provisioning" }).run();
});
afterEach(() => { db.sqlite.close(); });

function params(over: Partial<DeployableOnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    consumerName: "post", repoURL: "https://github.com/x/post.git", owner: "platform", repoCredentialId: "cred_pat",
    version: "1.0.0", channel: "stable", resolvedSha: SHA, builds: ["post"], form: "deployable", stage: "prod",
    domain: "s1.example", clusterId: "cls_1", cluster: "s1", namespace: "post-prod", unitApex: "example.com", host: "post",
    chartPath: "deploy/chart", argoAppName: "post-prod", report: passReport(),
    secretSpecs: [{ key: "MAIL_DKIM_PRIVATE_KEY", required: true, generate: "rsa2048" }],
    smtpEntry: { service: "post-mta", port: 2525, dkimKey: "MAIL_DKIM_PRIVATE_KEY" },
    ...over,
  });
}

function ctx(p: OnboardParams, logs: string[]): StepCtx {
  return {
    runId: "run_onb", stepName: "seed-secrets", db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const rowKey = (): string | null | undefined => db.db.select({ k: apps.dkimPublicKey }).from(apps).where(eq(apps.id, "app_1")).get()?.k;

describe("seed-secrets keeps a mail sender's DKIM public half", () => {
  it("on the create, the row carries the public half of exactly the private key seeded into Vault", async () => {
    const seeder = new FakeSeeder();
    const p = params();
    const logs: string[] = [];
    await makeOnboardDef(ports({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!.run(ctx(p, logs));
    const privatePem = seeder.seeded[0]!.data["MAIL_DKIM_PRIVATE_KEY"]!;
    expect(rowKey()).toBe(createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString());
    expect(logs.some((l) => l.includes("MAIL_DKIM_PRIVATE_KEY") && l.includes("Mail page"))).toBe(true);
    for (const l of logs) expect(l).not.toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("on a re-run over a standing entry, nothing new lands and the row is left as it was", async () => {
    const seeder = new FakeSeeder();
    seeder.created = false;
    const p = params();
    await makeOnboardDef(ports({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!.run(ctx(p, []));
    expect(rowKey()).toBeNull();
  });

  it("a unit that is no mail sender keeps no key on its row, though it mints an rsa2048 key", async () => {
    const seeder = new FakeSeeder();
    const { smtpEntry: _none, ...plain } = params() as DeployableOnboardParams;
    const p = OnboardParams.parse(plain);
    await makeOnboardDef(ports({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!.run(ctx(p, []));
    expect(seeder.seeded).toHaveLength(1);
    expect(rowKey()).toBeNull();
  });
});
