import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { pino } from "pino";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { registerConsumerRoutes } from "./api.ts";

// The routes of the CI only form: its onboarding request, the list of such units and their offboard.

const REPO = (name: string): string => `https://github.com/x/${name}.git`;
const CI_REQUEST = { form: "ci-only", consumerName: "acme", repoURL: REPO("acme"), owner: "team" };

describe("the CI only routes", () => {
  let db: DbHandle;
  afterEach(() => db.sqlite.close());

  async function harness(register: (reg: Registrations) => Promise<void> = async () => undefined) {
    db = openDb(":memory:");
    const store = new CredentialStore({ db: db.db, logger: pino({ level: "silent" }) });
    for (const purpose of ["packages-reader", "repository-pat"] as const) {
      await store.seal({ kind: "pat", label: `${purpose} (x)`, plaintext: Buffer.from(`ghp_${purpose}`), fingerprint: `sha256:${purpose}`, subject: { kind: "owner", id: "x" }, purpose });
    }
    const registrations = new Registrations(new FakePlatformRepo());
    await register(registrations);
    const streamed: { kind: string; params: unknown }[] = [];
    const planned: { kind: string; params: unknown }[] = [];
    const executor = {
      planStreamed: async (kind: string, params: unknown) => { streamed.push({ kind, params }); return { runId: "run_1" }; },
      plan: async (kind: string, params: unknown) => { planned.push({ kind, params }); return { runId: "run_2" }; },
    } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerConsumerRoutes(app, { executor, db: db.db, store, onboardingEnabled: true, github: new FakeGitHubConsumer(), registrations });
    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { send, streamed, planned };
  }

  it("plans a CI only onboarding with the sealed credential and no release, whatever stage or channel the body names", async () => {
    const { send, streamed } = await harness();
    const res = await send("POST", "/api/consumers", { ...CI_REQUEST, stage: "prod", channel: "beta" });
    expect(res.status).toBe(201);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]!.kind).toBe("consumer-onboard");
    const params = streamed[0]!.params as Record<string, unknown>;
    expect(params).toMatchObject({ form: "ci-only", consumerName: "acme", repoURL: REPO("acme"), owner: "team" });
    expect(String(params["repoCredentialId"])).toMatch(/^cred_/);
    for (const key of ["version", "channel", "stage", "existing", "clusterId"]) expect(params).not.toHaveProperty(key);
  });

  it("refuses a CI only onboarding that lacks its owner, and plans nothing", async () => {
    const { send, streamed } = await harness();
    const res = await send("POST", "/api/consumers", { ...CI_REQUEST, owner: undefined });
    expect(res.status).toBe(400);
    expect(streamed).toEqual([]);
  });

  it("lists exactly the units that only run CI: not a unit that builds, and not a chart-only unit with an empty build list", async () => {
    const { send } = await harness(async (reg) => {
      const unit = (name: string) => ({ name, repoURL: REPO(name), owner: "team", onboardedAt: "2026-01-01T00:00:00.000Z", suspended: false, quiesced: false });
      await reg.createBuildRegistration({ unit: unit("ci-check"), builds: [], runId: "run_1" }, () => undefined);
      await reg.createBuildRegistration({ unit: unit("builds"), builds: ["builds-api"], runId: "run_2" }, () => undefined);
      await reg.commitRegistration({ unit: unit("chart-only"), builds: [], deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", host: "chart-only", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") }, runId: "run_3" });
    });
    const res = await send("GET", "/api/consumers/ci-only");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "ci-check", repoUrl: REPO("ci-check"), owner: "team", onboardedAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("plans the offboard of a CI only unit with the repository read off its registration", async () => {
    const { send, planned } = await harness(async (reg) => {
      await reg.createBuildRegistration({ unit: { name: "ci-check", repoURL: REPO("ci-check"), suspended: false, quiesced: false }, builds: [], runId: "run_1" }, () => undefined);
    });
    const res = await send("POST", "/api/consumers/ci-only/ci-check/offboard");
    expect(res.status).toBe(201);
    expect(planned).toEqual([{ kind: "consumer-offboard-ci-only", params: { consumerName: "ci-check", repoURL: REPO("ci-check") } }]);
  });

  it("answers 404 for the offboard of a unit nothing registers", async () => {
    const { send, planned } = await harness();
    expect((await send("POST", "/api/consumers/ci-only/ghost/offboard")).status).toBe(404);
    expect(planned).toEqual([]);
  });
});
