import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RUN_KIND, type RunKind } from "../../../shared/enums.ts";
import { KIND_GUARDS } from "../../executor/guards.ts";

// A census over the verb list, not a behaviour test. RUN_KIND is what the UI offers, what the plan
// route accepts and what the runs table records, so a literal with no definition behind it is not an
// inert leftover: the operator finds the verb, asks for it, and only then learns nothing implements it.
// This asserts it against the SOURCE, which is where a verb is actually implemented or not. The boot
// check registry.total (server/boot/selfchecks.ts) asserts the narrower runtime property — no family
// half-registered — because a definition that exists but is not wired in one configuration is a
// configuration, while a definition that does not exist anywhere is a lie in the enum.
//
// It reads the definition modules rather than importing them: a definition is built by a factory that
// takes ports, so importing one would mean supplying adapters, and the census would then be testing
// the wiring instead of the verb list.

const SERVER_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Every `.ts` file under server/, minus tests and fixtures — the definitions live in two places
 *  (domains/runs/defs for the cluster verbs, domains/onboarding for the unit verbs), and hard-coding
 *  those two directories is how a definition moved to a third would start reading as missing. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".fixture.ts")) out.push(path);
  }
  return out;
}

/** The kinds the SOURCE implements: every `kind: "<literal>"` that names a member of RUN_KIND. A run
 *  definition states its own kind on that field (RunDefinition.kind, executor/types.ts), and it is the
 *  field the registry files the definition under — so the field is the implementation's own claim. */
function implementedKinds(): Set<string> {
  const found = new Set<string>();
  const members = new Set<string>(RUN_KIND);
  for (const file of sourceFiles(SERVER_DIR)) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bkind:\s*"([a-z-]+)"/g)) {
      if (m[1] !== undefined && members.has(m[1])) found.add(m[1]);
    }
  }
  return found;
}

describe("run-kind census: every RUN_KIND literal has a definition behind it", () => {
  it("names verbs at all (the census has something to check)", () => {
    expect(RUN_KIND.length).toBeGreaterThan(10);
    expect(implementedKinds().size).toBeGreaterThan(10);
  });

  it("leaves no literal without an implementation in the source", () => {
    const implemented = implementedKinds();
    const orphans = RUN_KIND.filter((kind) => !implemented.has(kind));
    expect(orphans, `RUN_KIND literals no run definition implements: ${orphans.join(", ")}`).toEqual([]);
  });

  it("keeps the guard table total over the same list, with no entry for a verb that is gone", () => {
    // KIND_GUARDS is a Record<RunKind, …>, so TypeScript already forbids a missing entry. What it
    // cannot forbid is the entry OUTLIVING its verb — a key removed from RUN_KIND leaves the object
    // literal compiling as an excess property in some positions — so the two lists are compared here.
    expect(Object.keys(KIND_GUARDS).sort()).toEqual([...RUN_KIND].sort());
  });

  it("files every guard entry under a verb the source implements", () => {
    const implemented = implementedKinds();
    const guarded = (Object.keys(KIND_GUARDS) as RunKind[]).filter((kind) => KIND_GUARDS[kind].length > 0);
    const dangling = guarded.filter((kind) => !implemented.has(kind));
    expect(dangling, `guards armed on verbs nothing implements: ${dangling.join(", ")}`).toEqual([]);
  });
});
