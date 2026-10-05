import { describe, it, expect } from "vitest";
import { seedMariadbInstanceStep } from "./onboard-seed-mariadb.ts";
import type { DeployableOnboardParams, OnboardPorts } from "./onboard.run.ts";
import type { MariadbSeedInput } from "#unit/server/adapters/vault/seeder-port.ts";
import type { StepCtx } from "../../executor/types.ts";

// seed-mariadb-instance writes the root password a MariaDB of the consumer's own is initialised with,
// create-only, and nothing for a consumer that brings none.

function run(services: string[], created = true): { seeded: MariadbSeedInput[]; logs: string[]; done: Promise<void> } {
  const seeded: MariadbSeedInput[] = [];
  const logs: string[] = [];
  const ports = { seeder: { seedMariadb: async (i: MariadbSeedInput) => { seeded.push(i); return { created }; } } } as unknown as OnboardPorts;
  const params = { stage: "prod", consumerName: "acme", services } as unknown as DeployableOnboardParams;
  const ctx = { log: (_kind: string, text: string) => void logs.push(text) } as unknown as StepCtx;
  return { seeded, logs, done: seedMariadbInstanceStep(ports, params).run(ctx) };
}

describe("seed-mariadb-instance", () => {
  it("seeds nothing for a consumer that brings no MariaDB", async () => {
    const r = run(["postgresql"]);
    await r.done;
    expect(r.seeded).toEqual([]);
    expect(r.logs.join(" ")).toContain("no MariaDB of its own");
  });

  it("seeds a fresh 32-byte root password for a MariaDB of the consumer's own, and a different one each time", async () => {
    const first = run(["mariadb"]);
    const second = run(["mariadb"]);
    await Promise.all([first.done, second.done]);
    expect(first.seeded).toEqual([{ stage: "prod", consumerName: "acme", password: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(first.seeded[0]?.password).not.toBe(second.seeded[0]?.password);
    expect(first.logs.join(" ")).toContain("secret/prod/consumer/acme/mariadb");
  });

  it("leaves a standing password untouched and says so", async () => {
    const r = run(["mariadb"], false);
    await r.done;
    expect(r.logs.join(" ")).toMatch(/already present .* left untouched/);
  });
});
