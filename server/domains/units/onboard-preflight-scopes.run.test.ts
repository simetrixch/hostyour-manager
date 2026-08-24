import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { preflightScopesStep } from "./onboard-preflight-scopes.ts";
import { OnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// Focused tests for the onboard `preflight-scopes` step (impl: onboard-preflight-scopes.ts). It
// only touches ports.webhook (readTokenScopes) + the sealed PAT, so the harness mirrors the tiny
// onboard-webhook.run.test.ts one. The repoURL github.com/x/acme means the step checks owner "x".
const SHA = "a".repeat(40);

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function params(over: Partial<OnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    report: { contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git", requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  });
}

function fixedCreds(bufOut?: (b: Buffer) => void): CredentialStore {
  return { open: () => { const b = Buffer.from("github_pat_secret", "utf8"); bufOut?.(b); return Promise.resolve(b); } } as unknown as CredentialStore;
}

function ctx(logs: string[], creds: CredentialStore = fixedCreds()): StepCtx {
  return {
    runId: "run_onb", stepName: "preflight-scopes", db: db.db, creds, params: params(),
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function step(ports: Record<string, unknown>): Step {
  return preflightScopesStep(ports as unknown as OnboardPorts, params());
}

describe("onboard preflight-scopes step", () => {
  it("passes when the PAT has repo + workflow + admin:repo_hook (logs OK, no throw)", async () => {
    const github = new FakeGitHubConsumer(); // default: all three present
    const logs: string[] = [];
    await step({ github }).run(ctx(logs));
    expect(logs.some((l) => l.includes("consumer PAT scopes OK for x/acme"))).toBe(true);
  });

  it("FAILS with the COMPLETE missing set at once (workflow + admin:repo_hook), not one at a time", async () => {
    const github = new FakeGitHubConsumer();
    github.tokenScopes = { classic: true, scopes: ["repo"] };
    const ports = { github };
    await expect(step(ports).run(ctx([]))).rejects.toThrow(/missing the scopes workflow \+ admin:repo_hook/);
    // and it states the full contract + the "mint a NEW token" instruction (a classic PAT can't be edited)
    await expect(step(ports).run(ctx([]))).rejects.toThrow(/cannot be edited after creation/);
  });

  it("FAILS when only admin:repo_hook is missing (the historic swissbookai gap), naming exactly it", async () => {
    const github = new FakeGitHubConsumer();
    github.tokenScopes = { classic: true, scopes: ["repo", "workflow"] };
    await expect(step({ github }).run(ctx([]))).rejects.toThrow(/missing the scope admin:repo_hook/);
  });

  it("accepts the narrower write:repo_hook in place of admin:repo_hook", async () => {
    const github = new FakeGitHubConsumer();
    github.tokenScopes = { classic: true, scopes: ["repo", "workflow", "write:repo_hook"] };
    const logs: string[] = [];
    await step({ github }).run(ctx(logs));
    expect(logs.some((l) => l.includes("scopes OK"))).toBe(true);
  });

  it("FAILS closed on a fine-grained token (no scope metadata) with a 'use a classic PAT' ask", async () => {
    const github = new FakeGitHubConsumer();
    github.tokenScopes = { classic: false, scopes: [] };
    const ports = { github };
    await expect(step(ports).run(ctx([]))).rejects.toThrow(/fine-grained token/);
    await expect(step(ports).run(ctx([]))).rejects.toThrow(/CLASSIC personal access token/);
  });

  it("FAILS on an invalid/expired PAT (401 → WebhookScopeError → a clear ask)", async () => {
    const github = new FakeGitHubConsumer();
    github.tokenInvalid = true;
    await expect(step({ github }).run(ctx([]))).rejects.toThrow(/invalid or expired/);
  });

  it("FAILS LOUD when no GitHub client is wired (never a silent skip)", async () => {
    await expect(step({}).run(ctx([]))).rejects.toThrow(/none is wired/);
  });

  it("zeroes the PAT buffer after use and never logs it", async () => {
    const github = new FakeGitHubConsumer();
    let patBuf: Buffer | undefined;
    const logs: string[] = [];
    await step({ github }).run(ctx(logs, fixedCreds((b) => { patBuf = b; })));
    expect(patBuf && [...patBuf].every((byte) => byte === 0)).toBe(true);
    for (const l of logs) expect(l).not.toContain("github_pat_secret");
  });
});
