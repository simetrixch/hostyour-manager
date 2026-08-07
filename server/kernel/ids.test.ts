import { describe, it, expect } from "vitest";
import { mintTenantGuid } from "./ids.ts";
import { guid } from "../../shared/tenant.ts";

describe("mintTenantGuid", () => {
  it("mints a 12-char guid matching the guid regex", () => {
    for (let i = 0; i < 200; i++) {
      const g = mintTenantGuid();
      expect(g).toHaveLength(12);
      expect(guid.safeParse(g).success).toBe(true);
    }
  });

  it("mints unique values across a batch (CSPRNG, no collisions)", () => {
    const batch = new Set<string>();
    for (let i = 0; i < 1000; i++) batch.add(mintTenantGuid());
    expect(batch.size).toBe(1000);
  });
});
