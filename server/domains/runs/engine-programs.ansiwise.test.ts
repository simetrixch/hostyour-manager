import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ansiwiseBinaries, NO_BINARY } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { ENGINE_PROGRAMS, ANSIWISE_REST_TOOL, ANSIWISE_TOOL } from "./defs/place-ansiwise.ts";

// WHERE THE ENGINE'S PROGRAM SET COMES FROM, and the whole reason this file exists rather than a
// comment saying the two repositories agree.
//
// This manager composes command lines naming the engine's binaries, and ENGINE_PROGRAMS is what says
// which words those binaries answer. Written down and left alone, that record is a SECOND statement
// of a fact that lives somewhere else — which is exactly the defect it was added to catch:
// `installServiceArgv` was such a statement, it was true on the day it was written, and
// simetrixch/ansiwise-cli#14 deleted the program underneath it without one check here going red.
//
// SO IT IS ASKED, AND ASKED OF THE ARTEFACT. Refused a word it does not carry, `ansiwise-rest` names
// its own set on the line `it serves: …` and exits 64 (ansiwise-cli bin/ansiwise_rest.dart) — before
// it opens a configuration or a catalogue, which is what makes this answerable on a bare temporary
// directory. The binary comes from the sibling checkout's build output, found by the same walk every
// real-serve suite uses (adapters/ansiwise/testing/serve-fixture.ts).
//
// THE BUILD AND NOT THE SOURCE, deliberately. hostyour-deploy's check reaches into ../ansiwise-cli
// for a Dart SUITE, which reads that repository's source. What reaches a machine is the compiled
// binary, and the two can differ: measured while this was written, the build standing beside this
// checkout was three programs ahead of its own source, so every real-serve test in this repository
// was proving the manager against a door the engine no longer has. Reading the source would have
// called that tree green; asking the binary does not.
//
// IT STARTS NO INSTALLATION AND NO SERVE. The word is refused before anything is opened, so this
// file touches no run root and cannot collide with the suite that does — it is a `.ansiwise.` file
// only because it needs the sibling build, which is what that project marks.

const bin = ansiwiseBinaries();

/** The binary under its own name in a directory of this test's own. A copy, because Windows will not
 *  start an extensionless file and the build carries no suffix — the same reason the serve fixture
 *  copies rather than spawning in place. */
function askBinary(from: string, name: string, argv: string[]): { status: number | null; said: string } {
  const dir = mkdtempSync(join(tmpdir(), "engine-programs-"));
  try {
    const exe = join(dir, `${name}${process.platform === "win32" ? ".exe" : ""}`);
    copyFileSync(from, exe);
    const answered = spawnSync(exe, argv, { cwd: dir, encoding: "utf8", timeout: 30_000 });
    return { status: answered.status, said: `${answered.stdout ?? ""}${answered.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A word no engine binary will ever carry, and it is not a plausible program name by accident: what
 *  is being measured is the REFUSAL, so a word that might one day become real would make this test
 *  go red for the wrong reason. */
const NOT_A_PROGRAM = "no-such-program";

describe.skipIf(bin === undefined)("the engine's program set, read off the binary this manager composes words for", () => {
  if (bin === undefined) {
    // eslint-disable-next-line no-console -- the skip must be loud, not silent (see NO_BINARY)
    console.warn(NO_BINARY);
  }
  const binaries = bin as { tool: string; rest: string };

  it("the serving binary names the same set ENGINE_PROGRAMS carries for it", () => {
    const { status, said } = askBinary(binaries.rest, ANSIWISE_REST_TOOL, [NOT_A_PROGRAM]);
    expect(said).toContain(`${ANSIWISE_REST_TOOL} has no program called "${NOT_A_PROGRAM}"`);
    expect(status, "the exit code a caller reads a refused word by").toBe(64);
    const serves = /^it serves: (.+)$/m.exec(said)?.[1]?.trim().split(", ");
    expect(
      serves,
      "the binary names its own programs on this line; a set this repository carries and the binary does not is a " +
        "command line that reaches a machine and is refused there",
    ).toEqual(ENGINE_PROGRAMS.get(ANSIWISE_REST_TOOL));
  });

  it("the deployment tool carries no such set, because its programs are the machine's catalogue", () => {
    // Asked the same word on a directory with no installation, it answers about the CONFIGURATION and
    // not about a word — the program set is resolved against the catalogue that would have been
    // opened. That is why ENGINE_PROGRAMS holds no entry for it, and this is the measurement behind
    // that absence rather than a sentence asserting it.
    const { said } = askBinary(binaries.tool, ANSIWISE_TOOL, [NOT_A_PROGRAM]);
    expect(said).not.toContain("has no program called");
    expect(said).toContain("ansiwise.yaml");
    expect(ENGINE_PROGRAMS.has(ANSIWISE_TOOL)).toBe(false);
  });
});
