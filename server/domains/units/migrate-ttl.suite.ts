import { describe, it, expect, vi } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { makeMigrateDef } from "./migrate.run.ts";
import {
  seedClusters, seedMaster, seedConsumerRow, seedConsumerRegistration,
  makeFakes, consumerPorts, stepCtx, CONSUMER, TARGET,
} from "./relocation.fixture.ts";

export function migrateTtlSuite(getDb: () => DbHandle): void {
  describe("authoritative TTL before clear-source", () => {
    it("clear-source started 10 s after the switch does not clear before the clock passes switch + 300 s, and its log names the wait", async () => {
      vi.useFakeTimers();
      try {
        const db = getDb();
        seedMaster(db);
        seedClusters(db);
        seedConsumerRow(db);
        const f = makeFakes();
        let provisionedAtReadTime: boolean | undefined;
        const ports = {
          ...consumerPorts(f),
          authoritativeTtl: async () => {
            provisionedAtReadTime = f.dns.upserts.length > 0;
            return { ttlSeconds: 300, server: "ns1.example.org" };
          },
        };
        await seedConsumerRegistration(ports.registrations);
        const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
        const steps = makeMigrateDef(ports).steps(params);
        const switchDns = steps.find((s) => s.name === "switch-dns")!;
        const clearSource = steps.find((s) => s.name === "clear-source")!;

        const switchLogs: string[] = [];
        await switchDns.run(stepCtx(db, switchDns.name, params, switchLogs));
        expect(provisionedAtReadTime).toBe(false);
        expect(f.dns.upserts.length).toBeGreaterThan(0);
        expect(switchLogs.some((l) => l.includes(`${CONSUMER}.${TARGET.domain} serves TTL 300 s at its authoritative server ns1.example.org`))).toBe(true);

        // Advance clock by 10 s (started 10 s after the switch)
        await vi.advanceTimersByTimeAsync(10_000);

        const clearLogs: string[] = [];
        let cleared = false;
        const clearPromise = clearSource.run(stepCtx(db, clearSource.name, params, clearLogs)).then(() => {
          cleared = true;
        });

        // 299 s after switch: not yet cleared
        await vi.advanceTimersByTimeAsync(289_000);
        expect(cleared).toBe(false);

        // Pass switch + 300 s
        await vi.advanceTimersByTimeAsync(2_000);
        await clearPromise;
        expect(cleared).toBe(true);

        const waitLog = clearLogs.find((l) => l.startsWith("waiting for the TTL of"));
        expect(waitLog).toBeDefined();
        expect(waitLog).toContain(`${CONSUMER}.${TARGET.domain}`);
        expect(waitLog).toContain("(300 s)");
        expect(waitLog).toContain("until");
      } finally {
        vi.useRealTimers();
      }
    });

    it("PLANTED INNOCENT: started after the TTL has passed, it clears at once and logs that the TTL has passed", async () => {
      vi.useFakeTimers();
      try {
        const db = getDb();
        seedMaster(db);
        seedClusters(db);
        seedConsumerRow(db);
        const f = makeFakes();
        const ports = {
          ...consumerPorts(f),
          authoritativeTtl: async () => ({ ttlSeconds: 300, server: "ns1.example.org" }),
        };
        await seedConsumerRegistration(ports.registrations);
        const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
        const steps = makeMigrateDef(ports).steps(params);
        const switchDns = steps.find((s) => s.name === "switch-dns")!;
        const clearSource = steps.find((s) => s.name === "clear-source")!;

        await switchDns.run(stepCtx(db, switchDns.name, params, []));

        // Advance clock past switch + 300 s
        await vi.advanceTimersByTimeAsync(301_000);

        const clearLogs: string[] = [];
        await clearSource.run(stepCtx(db, clearSource.name, params, clearLogs));

        const passedLog = clearLogs.find((l) => l.startsWith("the TTL of"));
        expect(passedLog).toBeDefined();
        expect(passedLog).toContain(`${CONSUMER}.${TARGET.domain}`);
        expect(passedLog).toContain("(300 s) has passed");
        expect(passedLog).toContain("clearing the source");
      } finally {
        vi.useRealTimers();
      }
    });

    it("PLANTED DEFECT: without the authoritativeTtl port, switch-dns fails and clear-source never runs", async () => {
      const db = getDb();
      seedMaster(db);
      seedClusters(db);
      seedConsumerRow(db);
      const f = makeFakes();
      const ports = consumerPorts(f);
      delete (ports as Partial<typeof ports>).authoritativeTtl;
      await seedConsumerRegistration(ports.registrations);
      const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
      const steps = makeMigrateDef(ports).steps(params);
      const switchDns = steps.find((s) => s.name === "switch-dns")!;

      await expect(switchDns.run(stepCtx(db, switchDns.name, params, []))).rejects.toThrow(
        /cannot read authoritative TTL: port authoritativeTtl is missing; the source would be cleared while resolvers still answer it/,
      );
    });
  });
}
