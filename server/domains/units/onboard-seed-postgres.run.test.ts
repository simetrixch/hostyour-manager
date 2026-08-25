import { describe, it, expect } from "vitest";
import { seedPostgresSuperuserStep } from "./onboard-seed-postgres.ts";
import { DeployableOnboardParams, type OnboardPorts } from "./onboard.run.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeedOutcome, PostgresSeedInput } from "./vault-seeder.ts";

// Focused tests for the onboard `seed-postgres-superuser` step (impl: onboard-seed-postgres.ts). Kept
// apart from onboard.run.test.ts so each file stays within the per-file line budget (the
// onboard-webhook / onboard-activate pattern). The step is built in isolation — it only touches
// ports.seeder + a few params, never the kube/git clients — so the harness stays tiny.
const SHA = "a".repeat(40);

function params(over: Partial<DeployableOnboardParams> = {}): DeployableOnboardParams {
  return DeployableOnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    report: { contractVersion: "1.4", runnerVersion: "t", repoURL: "https://github.com/x/acme.git", requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  });
}

/** Records seedPostgres; `created` toggles the create-only re-run (an existing leaf → nothing written). */
class RecordingSeeder {
  seededPostgres: PostgresSeedInput[] = [];
  created = true;
  async seedPostgres(i: PostgresSeedInput): Promise<VaultSeedOutcome> { this.seededPostgres.push(i); return { created: this.created }; }
}

function step(seeder: RecordingSeeder, over: Partial<DeployableOnboardParams> = {}): Step {
  return seedPostgresSuperuserStep({ seeder } as unknown as OnboardPorts, params(over));
}

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_onb", stepName: "seed-postgres-superuser", db: {} as unknown as StepCtx["db"], creds: {} as unknown as StepCtx["creds"], params: params(),
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("onboard seed-postgres-superuser step", () => {
  it("MINTS a 32-byte-hex superuser password and write-only seeds it to the SEPARATE postgres leaf when the consumer claims postgresql", async () => {
    const seeder = new RecordingSeeder();
    const logs: string[] = [];
    await step(seeder, { services: ["postgresql"] }).run(ctx(logs));

    expect(seeder.seededPostgres).toHaveLength(1);
    const seeded = seeder.seededPostgres[0]!;
    // The SEPARATE leaf coordinates: <stage>/consumer/<name>/postgres — and NOTHING else
    // beside the minted password. The step names no Vault and no write identity, because there is one
    // Vault and the seeder logs in as the Manager itself; asserting the exact key set is what keeps
    // a re-introduced address from riding along unread.
    const { password, ...coordinates } = seeded;
    expect(coordinates).toEqual({ stage: "prod", consumerName: "acme" });
    expect(password).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex = 256 bits
    expect(logs.some((l) => l.includes("seeded the PostgreSQL instance-superuser") && l.includes("secret/prod/consumer/acme/postgres"))).toBe(true);
    for (const l of logs) expect(l).not.toContain(seeded.password); // write-only: the minted value never logs
  });

  it("is a NO-OP for a consumer that does NOT claim postgresql (mongodb-only — every consumer today)", async () => {
    const seeder = new RecordingSeeder();
    const logs: string[] = [];
    await step(seeder, { services: ["mongodb"] }).run(ctx(logs));
    expect(seeder.seededPostgres).toHaveLength(0); // ZERO postgres Vault write — seeding is unchanged
    expect(logs.some((l) => l.includes("does not claim the postgresql service"))).toBe(true);
  });

  it("is a NO-OP for a zero-service consumer too (services defaults to [])", async () => {
    const seeder = new RecordingSeeder();
    const logs: string[] = [];
    await step(seeder).run(ctx(logs)); // no services override → []
    expect(seeder.seededPostgres).toHaveLength(0);
    expect(logs.some((l) => l.includes("does not claim the postgresql service"))).toBe(true);
  });

  it("is CREATE-ONLY: an existing leaf is left untouched (a re-onboard onto a surviving PGDATA)", async () => {
    const seeder = new RecordingSeeder();
    seeder.created = false; // Vault: the leaf already exists (cas=0 refused the write)
    const logs: string[] = [];
    await step(seeder, { services: ["postgresql"] }).run(ctx(logs)); // resolves — a re-onboard is legitimate
    expect(seeder.seededPostgres).toHaveLength(1); // it attempted the create-only write
    expect(logs.some((l) => l.includes("already present") && l.includes("left untouched"))).toBe(true);
  });
});
