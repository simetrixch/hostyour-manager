import { describe, it, expect } from "vitest";
import { seedRedisInstanceStep } from "./onboard-seed-redis.ts";
import type { DeployableOnboardParams, OnboardPorts } from "./onboard.run.ts";
import type { RedisSeedInput } from "#unit/server/adapters/vault/seeder-port.ts";
import type { StepCtx } from "../../executor/types.ts";

// seed-redis-instance writes the password a Redis of the consumer's own boots with, create-only, and
// nothing for a consumer on the cluster's shared server.

function run(redis: "shared" | "standalone", created = true): { seeded: RedisSeedInput[]; logs: string[]; done: Promise<void> } {
  const seeded: RedisSeedInput[] = [];
  const logs: string[] = [];
  const ports = { seeder: { seedRedis: async (i: RedisSeedInput) => { seeded.push(i); return { created }; } } } as unknown as OnboardPorts;
  const params = { stage: "prod", consumerName: "acme", redis } as unknown as DeployableOnboardParams;
  const ctx = { log: (_kind: string, text: string) => void logs.push(text) } as unknown as StepCtx;
  return { seeded, logs, done: seedRedisInstanceStep(ports, params).run(ctx) };
}

describe("seed-redis-instance", () => {
  it("seeds nothing for a consumer on the cluster's shared Redis", async () => {
    const r = run("shared");
    await r.done;
    expect(r.seeded).toEqual([]);
    expect(r.logs.join(" ")).toContain("shared Redis");
  });

  it("seeds a fresh 32-byte password for a Redis of the consumer's own, and a different one each time", async () => {
    const first = run("standalone");
    const second = run("standalone");
    await Promise.all([first.done, second.done]);
    expect(first.seeded).toEqual([{ stage: "prod", consumerName: "acme", password: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(first.seeded[0]?.password).not.toBe(second.seeded[0]?.password);
    expect(first.logs.join(" ")).toContain("secret/prod/consumer/acme/redis");
  });

  it("leaves a standing password untouched and says so", async () => {
    const r = run("standalone", false);
    await r.done;
    expect(r.logs.join(" ")).toMatch(/already present .* left untouched/);
  });
});
