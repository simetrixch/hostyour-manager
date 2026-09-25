import { describe, it, expect } from "vitest";
import { servers } from "../../db/schema/inventory.ts";
import { slaveApiHost } from "./defs/deploy-slave.kit.ts";

// The address the master's in-cluster components dial a slave's kube-apiserver on. Resolved ONCE
// per run and taken by BOTH sources of it — the cluster map's apiHost through git, and the address
// the slave composes its own credentials blob on — so a slave can never be half-reachable.
describe("slaveApiHost — one dial address, three places it can come from", () => {
  const row = (over: Partial<typeof servers.$inferSelect>): typeof servers.$inferSelect =>
    ({ host: "s1.example.com", lanHost: null, tailnetHost: null, ...over }) as typeof servers.$inferSelect;

  it("takes the tailnet address when the row carries one — the private network is what makes a slave outside the master's own network reachable", () => {
    expect(slaveApiHost(row({ lanHost: "10.1.1.11", tailnetHost: "100.64.0.11" }))).toBe("100.64.0.11");
  });

  it("falls back to the LAN address for a slave that sits in the master's own network", () => {
    expect(slaveApiHost(row({ lanHost: "10.1.1.11" }))).toBe("10.1.1.11");
  });

  it("falls back to the public address when the row carries neither — a row that states no internal address at all", () => {
    expect(slaveApiHost(row({}))).toBe("s1.example.com");
  });
});
