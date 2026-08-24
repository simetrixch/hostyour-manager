import { describe, it, expect } from "vitest";
import type { CheckGate } from "./gates/gate.ts";
import { PRE_RENDER_GATES, POST_RENDER_GATES } from "./gate-list.ts";

// A census over the gate list, not a behaviour test: the two lists here decide which gates a consumer
// is actually judged by, and the report reads them as if all of them ran. A declared gate whose
// implementation is a stub, or a gate module sitting in gates/ that no list names, both mean the
// gates silently judge a chart by fewer rules than the contract advertises.
//
// The census walks the MODULES, not the ids: a gate file is named for its subject
// (image-discipline.gate.ts), the G-number is a data field on the gate, and nothing derives one from
// the other. structure.gate.ts and render-pinned-deps.gate.ts export pipeline PHASES rather than a
// CheckGate — they produce the context the gates run over — so they carry no CheckGate export and
// the census passes over them on that fact alone, not on their names.
const modules = import.meta.glob<Record<string, unknown>>("./gates/*.gate.ts");

function isCheckGate(v: unknown): v is CheckGate {
  const g = v as CheckGate | null;
  return (
    typeof g === "object" && g !== null &&
    typeof g.id === "string" && typeof g.title === "string" &&
    typeof g.severity === "string" && typeof g.check === "function"
  );
}

/** Every CheckGate any gates/*.gate.ts module exports, with the file it came from. */
async function implemented(): Promise<{ file: string; gate: CheckGate }[]> {
  const found: { file: string; gate: CheckGate }[] = [];
  for (const [file, load] of Object.entries(modules)) {
    for (const value of Object.values(await load())) {
      if (isCheckGate(value)) found.push({ file, gate: value });
    }
  }
  return found;
}

const declared = [...PRE_RENDER_GATES, ...POST_RENDER_GATES];

describe("gate list census: every declared gate has an implementation", () => {
  it("declares gates at all (the census has something to check)", () => {
    expect(declared.length).toBeGreaterThan(3);
    expect(PRE_RENDER_GATES.length).toBeGreaterThan(0);
    expect(POST_RENDER_GATES.length).toBeGreaterThan(0);
  });

  it("finds gate modules at all (the module walk is not silently empty)", async () => {
    expect(Object.keys(modules).length).toBeGreaterThan(declared.length);
    expect((await implemented()).length).toBeGreaterThan(0);
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

  it("resolves every declared gate to a module in gates/, one gate per module", async () => {
    const found = await implemented();
    const missing = declared.filter((g) => !found.some((f) => f.gate === g)).map((g) => g.id);
    expect(missing, `declared gates exported by no gates/*.gate.ts module: ${missing.join(", ")}`).toEqual([]);

    const perFile = new Map<string, string[]>();
    for (const { file, gate } of found) perFile.set(file, [...(perFile.get(file) ?? []), gate.id]);
    const crowded = [...perFile].filter(([, ids]) => ids.length > 1).map(([file, ids]) => `${file}: ${ids.join(", ")}`);
    expect(crowded, `gate modules exporting more than one gate: ${crowded.join("; ")}`).toEqual([]);
  });

  it("declares every gate module that exists in gates/", async () => {
    const undeclared = (await implemented())
      .filter(({ gate }) => !declared.includes(gate))
      .map(({ file, gate }) => `${file} (${gate.id})`);
    expect(undeclared, `gate modules no list runs: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("names every gate module after a word of the gate's own title", async () => {
    const opaque = (await implemented())
      .filter(({ file, gate }) => {
        const stem = file.replace(/^.*\//, "").replace(/\.gate\.ts$/, "");
        return !gate.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).some((w) => stem.includes(w));
      })
      .map(({ file, gate }) => `${file} (title "${gate.title}")`);
    expect(opaque, `gate modules whose name shares no word with their title: ${opaque.join(", ")}`).toEqual([]);
  });
});
