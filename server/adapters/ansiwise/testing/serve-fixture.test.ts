import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ansiwiseBinaries, MAY_SKIP_REAL_SERVE, NO_BINARY } from "./serve-fixture.ts";

// THE GATE THE REAL-SERVE SUITES ASK, AND THE ONE PLACE THAT CAN MAKE THEM VANISH.
//
// A green run that skipped the real-serve file reads exactly like a green run that passed it, and
// two tests of that file were red on master for a day underneath such a green (#110, #111). So the
// absence of the binaries is a REFUSAL and not a skip, and the concession for somebody who cannot
// build them is one named variable rather than the default. This file is what holds that: it is in
// the in-process project, so it runs on every machine whether the binaries are there or not.
//
// The lookup falls back to the sibling ansiwise-cli checkout, which is resolved against the WORKING
// DIRECTORY — so the absent case is made by standing the process in a temporary directory that has
// no sibling, which is the only way to measure "no binaries" on a machine that has them.

const HELD: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "serve-gate-"));
  HELD.push(dir);
  return dir;
};

/** Runs `body` with the environment and the working directory stated, and puts both back. */
function inWorld<T>(world: { cwd: string; env: Record<string, string | undefined> }, body: () => T): T {
  const was = process.cwd();
  const held = Object.fromEntries(Object.keys(world.env).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(world.env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.chdir(world.cwd);
    return body();
  } finally {
    process.chdir(was);
    for (const [k, v] of Object.entries(held)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A directory holding both binaries as FILES, and the directory itself — the two things a person
 *  sets the variables to, one of which used to pass and then die copying. */
function builtBinaries(): { dir: string; tool: string; rest: string } {
  const dir = join(scratch(), "build");
  mkdirSync(dir, { recursive: true });
  const tool = join(dir, "ansiwise");
  const rest = join(dir, "ansiwise-rest");
  writeFileSync(tool, "#!/bin/sh\n");
  writeFileSync(rest, "#!/bin/sh\n");
  return { dir, tool, rest };
}

const NO_SIBLING = { ANSIWISE_BIN: undefined, ANSIWISE_REST_BIN: undefined, [MAY_SKIP_REAL_SERVE]: undefined };

afterEach(() => {
  while (HELD.length > 0) rmSync(HELD.pop() as string, { recursive: true, force: true });
});

describe("the real-serve gate", () => {
  it("hands back the two files the variables name", () => {
    const { tool, rest } = builtBinaries();
    const got = inWorld(
      { cwd: scratch(), env: { ...NO_SIBLING, ANSIWISE_BIN: tool, ANSIWISE_REST_BIN: rest } },
      () => ansiwiseBinaries(),
    );
    expect(got).toEqual({ tool, rest });
  });

  it("REFUSES rather than skipping when the binaries are nowhere, and names what to set", () => {
    expect(() => inWorld({ cwd: scratch(), env: NO_SIBLING }, () => ansiwiseBinaries()))
      .toThrow(/ANSIWISE_BIN and ANSIWISE_REST_BIN/);
    // The refusal has to carry its own way out, or the person who genuinely cannot build the sibling
    // checkout is stopped with nothing to do about it.
    expect(NO_BINARY).toContain(MAY_SKIP_REAL_SERVE);
  });

  it("REFUSES one of the two as hard as none of them — a pair, never a binary", () => {
    const { tool } = builtBinaries();
    expect(() => inWorld({ cwd: scratch(), env: { ...NO_SIBLING, ANSIWISE_BIN: tool } }, () => ansiwiseBinaries()))
      .toThrow(NO_BINARY);
  });

  it("REFUSES a variable pointed at the DIRECTORY the binaries stand in", () => {
    // The measured second way to a green run that proved nothing: the directory exists, so an
    // existence check passed the pair through, and the fixture then died copying a directory with
    // the whole real-serve file reported as skipped — the same `31 skipped` the unset variables give.
    const { dir } = builtBinaries();
    expect(() => inWorld({ cwd: scratch(), env: { ...NO_SIBLING, ANSIWISE_BIN: dir, ANSIWISE_REST_BIN: dir } }, () => ansiwiseBinaries()))
      .toThrow(NO_BINARY);
  });

  it("lets the run through, skipping, only when the person said so by name", () => {
    const got = inWorld({ cwd: scratch(), env: { ...NO_SIBLING, [MAY_SKIP_REAL_SERVE]: "1" } }, () => ansiwiseBinaries());
    expect(got, "the opt-out has to give back the same absence the suites already skip on").toBeUndefined();
  });

  it("takes the sibling checkout's build output when the variables state nothing", () => {
    // The path every developer's machine actually runs on: no variables, the binaries beside the
    // checkout. Built as a fake sibling so this case is measured on a machine carrying none.
    const home = scratch();
    const { tool, rest } = (() => {
      const build = join(home, "ansiwise-cli", "build");
      mkdirSync(build, { recursive: true });
      const t = join(build, "ansiwise");
      const r = join(build, "ansiwise-rest");
      writeFileSync(t, "#!/bin/sh\n");
      writeFileSync(r, "#!/bin/sh\n");
      return { tool: t, rest: r };
    })();
    const here = join(home, "hostyour-manager");
    mkdirSync(here, { recursive: true });
    expect(inWorld({ cwd: here, env: NO_SIBLING }, () => ansiwiseBinaries())).toEqual({ tool, rest });
  });
});
