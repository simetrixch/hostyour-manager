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
import type { Stage } from "../../../shared/enums.ts";
import { registerConsumerRoutes } from "./api.ts";

// The onboard POST reads the release the onboarding puts on its stage; the operator types none. A unit
// another stage of which runs a release gets that one, put on the stage as it stands; a first stage
// gets the next version on stable.

const PROD = "0.4.007-stable-20261001100000";
const REQ = { consumerName: "acme", repoURL: "https://github.com/x/acme.git", stage: "test", clusterId: "cls_1", owner: "team" };

describe("POST /api/consumers and the release it plans", () => {
  let db: DbHandle;
  afterEach(() => db.sqlite.close());

  /** The route, with the unit registered at `registered`: only those stages run a release a new stage takes. */
  async function route(github: FakeGitHubConsumer, registered: Stage[] = []): Promise<(body: Record<string, unknown>) => Promise<unknown>> {
    const books = new FakePlatformRepo();
    for (const stage of registered) books.seed(books.booksBranch, `registrations/acme/${stage}.yaml`, "name: acme\n");
    db = openDb(":memory:");
    const store = new CredentialStore({ db: db.db, logger: pino({ level: "silent" }) });
    for (const purpose of ["packages-reader", "repository-pat"] as const) {
      await store.seal({ kind: "pat", label: `${purpose} (x)`, plaintext: Buffer.from(`ghp_${purpose}`), fingerprint: `sha256:${purpose}`, subject: { kind: "owner", id: "x" }, purpose });
    }
    const planned: unknown[] = [];
    const executor = { planStreamed: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerConsumerRoutes(app, { executor, db: db.db, store, onboardingEnabled: true, github, registrations: new Registrations(books) });
    return async (body) => {
      const res = await app.request("/api/consumers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status !== 201) throw new Error(`${res.status}: ${await res.text()}`);
      return planned.at(-1);
    };
  }

  it("PLANTED DEFECT: plans the stable release prod runs for a new stage, put on it as it stands, whatever channel the body names", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("x", "acme", [{ name: PROD, commit: "a".repeat(40) }, { name: "0.4.008-beta-20261005145138", commit: "b".repeat(40) }]);
    github.seedBranch("x", "acme", "deploy/prod", { sha: "f".repeat(40), parents: ["a".repeat(40)] });
    const post = await route(github, ["prod"]);
    expect(await post(REQ)).toMatchObject({ version: "0.4.007", channel: "stable", existing: true });
    expect(await post({ ...REQ, channel: "beta" })).toMatchObject({ version: "0.4.007", channel: "stable", existing: true });
  });

  it("plans the next version on stable for a unit no stage of which runs a release", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("x", "acme", [PROD]);
    const post = await route(github);
    expect(await post({ ...REQ, stage: "prod" })).toMatchObject({ version: "0.4.008", channel: "stable", existing: false });
  });
});
