import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// WHO MAY WRITE `servers.machine_id`, held to two writers by reading the source back.
//
// That column is one half of what this manager records about a machine's operating system: the
// /etc/machine-id every mutating run re-reads before it writes anything, so a stranger that grabs a
// recycled address is refused in place of the machine that was recorded there. Its protection is
// entirely a property of WHO WRITES IT:
//
//   - executor/attest.ts RECORDS one, and only where the column is NULL. A value rewritten on every
//     connect would be a record of the last connection rather than a claim about the machine, and
//     such a record can never disagree with anything — so a second writer of a fresh value would not
//     add a route, it would remove the check.
//   - domains/inventory/machine-identity.ts CLEARS one, and only where a person states what the
//     machine presents. Clearing it is how a machine that really was rebuilt gets back: the next run
//     records the rebuilt machine's own. So the clear must exist, and it must be the statement.
//
// AND THERE MUST BE NO THIRD. A run kind that cleared the column on a mismatch would turn the
// refusal into a shrug; one that recorded over a standing value would agree with whatever answered
// the address. Both are one line of code, so the count is read back here rather than trusted:
// this census is what says the two writers above are still the only two.
//
// It is the same shape as the elevated-command census (domains/runs/elevation.test.ts) and the same
// reasoning: a list of who is permitted to write drifts behind the call sites, while a reading of
// every call site cannot.

/** Every source file of the server tree, tests and fixtures aside: what this manager ships. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes(".fixture.")) out.push(path);
  }
  return out;
}

/** Prose is not a call site: the column is named in the comments of both files that write it and of
 *  several that only read it, so the census reads the code with the comments taken out. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
}

/** Where a text WRITES the column — a line that hands `machineId` to a Drizzle `.set()`. Reading and
 *  reporting it is not writing it: the projection asks whether one is recorded and every attesting
 *  step puts the outcome in its checkpoint, and neither can move what the row holds. Written as a
 *  function over the text rather than over the tree, so the same reading that counts the repository's
 *  writers can be shown to find a planted one — a scan whose only evidence is that it found nothing
 *  proves nothing. */
export function machineIdWriteSites(text: string): string[] {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(".set(") && /\bmachineId\s*:/.test(l));
}

const SERVER_TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("servers.machine_id has exactly two writers, and each of them is one direction", () => {
  function census(): { file: string; line: string }[] {
    const found: { file: string; line: string }[] = [];
    for (const file of sourceFilesUnder(SERVER_TREE)) {
      for (const line of machineIdWriteSites(readFileSync(file, "utf8"))) {
        found.push({ file: relative(SERVER_TREE, file).replace(/\\/g, "/"), line });
      }
    }
    return found;
  }

  it("one records where the column is NULL, one clears it, and nothing else touches it", () => {
    const files = sourceFilesUnder(SERVER_TREE);
    expect(files.length).toBeGreaterThan(100); // a walk that found nothing would pass by measuring nothing
    expect(census().map((w) => w.file).sort()).toEqual([
      "domains/inventory/machine-identity.ts",
      "executor/attest.ts",
    ]);
  });

  it("the clear is the statement a person makes, and it is the only clear", () => {
    // A run kind that cleared the column on a mismatch would record whatever answered the address on
    // its next pass, which is the refusal removing itself. The clear belongs to the one act where a
    // person states what they read off the machine, and this is what says it still does.
    const clears = census().filter((w) => /machineId\s*:\s*null/.test(w.line));
    expect(clears.map((w) => w.file)).toEqual(["domains/inventory/machine-identity.ts"]);
  });

  it("finds a planted writer, so the count above is a measurement and not a blind spot", () => {
    expect(machineIdWriteSites('db.update(servers).set({ machineId: observed }).where(eq(servers.id, id)).run();'))
      .toEqual(["db.update(servers).set({ machineId: observed }).where(eq(servers.id, id)).run();"]);
    expect(machineIdWriteSites('tx.update(servers).set({ preflightJson: pf, machineId: null }).run();'))
      .toEqual(["tx.update(servers).set({ preflightJson: pf, machineId: null }).run();"]);
    // …and what a reader is not: the projection's boolean, an attesting step's checkpoint, and the
    // sentence a file keeps about the column it names.
    expect(machineIdWriteSites("machineIdRecorded: r.machineId !== null,")).toEqual([]);
    expect(machineIdWriteSites("ctx.checkpoint({ machineId: outcome.machineId, machineIdAction: outcome.action });")).toEqual([]);
    expect(machineIdWriteSites("// the statement that drops this recorded id: .set({ machineId: null })")).toEqual([]);
  });
});
