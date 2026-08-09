import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PRE_RENDER_GATES, POST_RENDER_GATES } from "./registry.ts";

// A census over the registry, not a behaviour test: the two lists here decide which gates a consumer
// is actually judged by, and the report reads them as if all of them ran. A declared gate whose
// implementation is a stub, or a gate module sitting in gates/ that no list names, both mean the
// gates silently judge a chart by fewer rules than the contract advertises.
//
// G1 (structure) and G3 (render) are pipeline PHASES, not CheckGates — they produce the context and
// live one directory up (../g1.ts, ../g3.ts), so they are not part of this census.

const GATES_DIR = fileURLToPath(new URL("./gates", import.meta.url));
const declared = [...PRE_RENDER_GATES, ...POST_RENDER_GATES];

describe("gate registry census: every declared gate has an implementation", () => {
  it("declares gates at all (the census has something to check)", () => {
    expect(declared.length).toBeGreaterThan(3);
    expect(PRE_RENDER_GATES.length).toBeGreaterThan(0);
    expect(POST_RENDER_GATES.length).toBeGreaterThan(0);
  });

  it("gives every declared gate a unique, contract-shaped id", () => {
    const bad = declared.filter((g) => !/^G[0-9]{1,2}$/.test(g.id)).map((g) => g.id || "(empty id)");
    expect(bad, `gate ids that do not match the report contract: ${bad.join(", ")}`).toEqual([]);

    const seen = new Set<string>();
    const duplicates = declared.filter((g) => !seen.add(g.id)).map((g) => g.id);
    expect(duplicates, `gates declared more than once: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("backs every declared gate with a real check, not a stub", () => {
    const hollow = declared
      .filter((g) => typeof g.check !== "function" || g.title.trim() === "" || !["hard", "soft"].includes(g.severity))
      .map((g) => g.id);
    expect(hollow, `gates without a usable title/severity/check: ${hollow.join(", ")}`).toEqual([]);
  });

  it("resolves every declared gate to its own module in gates/", () => {
    const missing = declared
      .filter((g) => {
        const file = join(GATES_DIR, `${g.id.toLowerCase()}.ts`);
        try {
          return !new RegExp(`export const ${g.id.toLowerCase()}\\b`).test(readFileSync(file, "utf8"));
        } catch {
          return true;
        }
      })
      .map((g) => g.id);
    expect(missing, `declared gates with no gates/<id>.ts implementation: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares every gate module that exists in gates/", () => {
    const ids = new Set(declared.map((g) => g.id.toLowerCase()));
    const undeclared = readdirSync(GATES_DIR)
      .filter((f) => /^g[0-9]{1,2}\.ts$/.test(f))
      .filter((f) => !ids.has(f.replace(/\.ts$/, "")));
    expect(undeclared, `gate modules no list runs: ${undeclared.join(", ")}`).toEqual([]);
  });
});
