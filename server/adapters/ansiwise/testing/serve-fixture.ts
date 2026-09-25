// The REAL surface, started in-process for tests — never a mock of it. The contract under test
// (the gate, the answers validation, the run records, the ?from= resume) is the machine's own, so
// the fixture builds a minimal INSTALLATION (ansiwise.yaml + programs/) in a temp directory and
// starts the actual binaries on it.
//
// TWO BINARIES, AND THE FIXTURE CARRIES BOTH BECAUSE A MACHINE HAS TO. The surface is
// `ansiwise-rest`, and it has one program: `serve`, over one session's own pipes. It starts every
// run as a DETACHED CHILD of the deployment tool and refuses to come up at all when `ansiwise` is
// not standing BESIDE it, exiting 78 (ansiwise-cli bin/ansiwise_rest.dart,
// `deploymentToolBesideThis`). So both are copied into the fixture directory, side by side, exactly
// as place-ansiwise puts them side by side in a machine's home.
//
// NOTHING HERE LISTENS, AND NOTHING HERE HOLDS A CREDENTIAL. The installation is placed once and
// every caller opens `serve` on it for itself, so the fixture proves the manager against the door
// the manager actually uses. The engine has no `ansiwise-rest service` program any more, and a
// fixture standing on a door nothing dials would prove nothing against the real engine.
//
// WHERE THEY COME FROM: $ANSIWISE_BIN / $ANSIWISE_REST_BIN, or the sibling checkout's build output
// (../ansiwise-cli/build/). Absent ⇒ the suites that need them REFUSE THE RUN, unless the person
// starting it said they may skip (ansiwiseBinaries below). They are COPIED into the fixture (Windows
// spawn needs the .exe name, and a copy cannot collide with a rebuild of the sibling checkout
// mid-test).
//
// THE PROGRAMS ARE PURE MEASUREMENTS: every step is require_answer_matches (ansiwise-host), a
// step that reads the run's own answers and touches nothing — so a `run` mode run is safe on
// the workstation and the record semantics are still the real engine's.
//
// NOTHING OUTSIDE THE FIXTURE DIRECTORY. The engine's default run root is `/var/lib/ansiwise/runs`
// (RunDirectory.defaultRoot), which on Windows resolves to `<drive>\var\lib\ansiwise\runs` — a
// directory outside every repository, and one every fixture on the drive would share. `serve` is
// given `--runs` inside the fixture directory instead (hostyour-manager#228), the engine hands that
// placement to every detached run child, and removing the fixture directory removes every record.

import { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { copyFileSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The variable a person sets to be let through WITHOUT the binaries — the one way past the refusal
 *  below, and deliberately the only one. Somebody who cannot build the sibling Dart checkout has to
 *  be able to work; what they may not do is get that concession by accident, which is exactly what a
 *  silent skip is. Set to anything at all. */
export const MAY_SKIP_REAL_SERVE = "ANSIWISE_TESTS_MAY_SKIP";

/** What the refusal says, and what a skip prints where one was asked for: actionable, not silent. */
export const NO_BINARY =
  "no ansiwise binaries — set ANSIWISE_BIN and ANSIWISE_REST_BIN to the two FILES (not the directory " +
  "they stand in), or build the sibling checkout (ansiwise-cli tool/build.dart); these tests prove the " +
  "transport against the REAL surface and cannot run without BOTH, because the serving binary refuses to " +
  `start when the deployment tool is not standing beside it. To run without them anyway, set ${MAY_SKIP_REAL_SERVE}` +
  " — and then the run proves nothing about the machine's own surface";

/** The deployment tool and the serving binary — the PAIR and never one of them, because a machine
 *  carrying one of the two answers nothing at all.
 *
 *  A MISSING PAIR REFUSES THE RUN. These are the only tests that prove this manager against the real
 *  engine surface, and they skip themselves when the pair is absent — which is the state every push
 *  is made in, so a run reported `2483 passed | 31 skipped` and nobody read the line. Two of the
 *  twenty-nine were red on master for a day underneath such a green (repaired as #110): a skip reads
 *  exactly like a pass, and it is the reader who is expected to tell them apart at the moment they
 *  are least likely to look. So the absence is a THROW, and the run that would have been green is
 *  red with the reason in it.
 *
 *  The throw stands HERE and not in the pre-push hook, because the blindness is the suite's: a
 *  `npx vitest run` typed by hand is how those two red tests were finally found, and a guard living
 *  in the hook leaves that command reporting green. It is also why nothing here names a FILE or a
 *  vitest project — every real-serve suite asks this one function for its binaries and the three
 *  legitimate skips (two `process.platform === "win32"`, one absent sibling checkout) never do, so
 *  having asked IS the rule, and a real-serve file added tomorrow is covered by asking. */
export function ansiwiseBinaries(): { tool: string; rest: string } | undefined {
  const tool = binaryNamed("ANSIWISE_BIN", "ansiwise");
  const rest = binaryNamed("ANSIWISE_REST_BIN", "ansiwise-rest");
  if (tool !== undefined && rest !== undefined) return { tool, rest };
  if (process.env[MAY_SKIP_REAL_SERVE] === undefined) throw new Error(NO_BINARY);
  return undefined;
}

/** A FILE, and that is the load-bearing word. `ANSIWISE_BIN` pointed at the build DIRECTORY — the
 *  obvious reading of "where the binaries are" — passed an existence test, and the fixture then died
 *  copying a directory (EISDIR) with the whole real-serve file reported as skipped: the same
 *  `31 skipped` the unset variables produce, from the opposite mistake. Asking for a file is what the
 *  gate always meant, and it sends that case to the refusal above, which names itself. */
function binaryNamed(variable: string, name: string): string | undefined {
  const named = process.env[variable];
  if (named && isFile(named)) return named;
  for (const candidate of siblingCandidates(name)) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/** THE SIBLING IS FOUND BY WALKING UP, not by one `..`, because the work is done in WORKTREES. A
 *  checkout stands beside `ansiwise-cli`; a worktree of it stands two levels deeper, under
 *  `.worktrees/hostyour-manager/<branch>/`, and one `..` from there names `.worktrees/ansiwise-cli`,
 *  which is nothing. The fallback therefore held everywhere except where every change is actually
 *  built — measured when the pre-push hook refused this very commit. Walking up asks the same
 *  question at each level and stops at the first tree that answers, so a worktree at any depth is
 *  covered without naming one. */
function* siblingCandidates(name: string): Generator<string> {
  let directory = process.cwd();
  for (;;) {
    yield resolve(directory, "..", "ansiwise-cli", "build", name);
    yield resolve(directory, "..", "ansiwise-cli", "build", `${name}.exe`);
    const up = resolve(directory, "..");
    if (up === directory) return;
    directory = up;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** One measuring row of a fixture program. Every row is REQUIRED and carries no default: a default
 *  that matches the pattern cannot tell "sent the right value" from "sent nothing", so an answer no
 *  caller states has to be refused at the door rather than filled in by the fixture. */
export interface ProbeRow {
  answer: string;
  /** The regular expression the answer must match — '.+' passes anything non-empty, '$a' ("end
   *  then a") can never match and is the planted red.
   *
   *  ABSENT ON A `text_list` ROW, and that is what such a row costs: require_answer_matches reads
   *  its answer as TEXT (ansiwise-host require_answer_matches.dart), so a list handed to it fails
   *  inside the step instead of measuring anything. A row without a pattern is measured by being
   *  REQUIRED — an answer the caller does not send stops the run at the door, by name. */
  pattern?: string;
  /** The kind the program declares the answer as. `text` unless the caller sends a LIST, which the
   *  engine refuses against a `text` declaration. */
  kind?: "text" | "text_list";
  /** Declared `secret: true`, so the engine keeps the value out of every record it writes and out of
   *  the description it hands back. The engine refuses a secret answer that also carries a default,
   *  by name, when the installation is parsed — which is why a secret row is a required row. */
  secret?: boolean;
}

export function programYaml(name: string, rows: ProbeRow[]): string {
  const byAnswer = new Map(rows.map((r) => [r.answer, r]));
  return [
    `name: ${name}`,
    "roles: [master, slave]",
    "answers:",
    ...[...byAnswer.values()].flatMap((r) => [
      `  - name: ${r.answer}`,
      `    kind: ${r.kind ?? "text"}`,
      `    describes: the ${r.answer} this fixture measures`,
      ...(r.secret === true ? ["    secret: true"] : []),
    ]),
    "steps:",
    ...rows.filter((r) => r.pattern !== undefined).flatMap((r) => [
      "  - step: require_answer_matches",
      `    answer: ${r.answer}`,
      `    pattern: '${r.pattern}'`,
      `    refusal: the ${r.answer} does not match ${r.pattern}`,
      "    on_failure: exit",
    ]),
    "",
  ].join("\n");
}

export interface ServeFixture {
  /** The SERVING binary itself: spawn it and its own stdio is the connection, which is what an SSH
   *  exec channel gives (openChannel below). */
  exe: string;
  /** The installation the binary runs from. */
  dir: string;
  /** Delete the installation and every run record the machine wrote. */
  close(): Promise<void>;
}

/** Build the installation [programs] stand in and put both real binaries beside each other in it.
 *  Nothing is started here: a caller opens `serve` on it with [openChannel]. */
export async function placeInstallation(
  binaries: { tool: string; rest: string },
  programs: Record<string, string>,
): Promise<ServeFixture> {
  const dir = mkdtempSync(join(tmpdir(), "ansiwise-serve-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  // BESIDE EACH OTHER, under their own names. The serving binary looks for `ansiwise` in the
  // directory it was started from and exits 78 when it is not there, so a fixture that copied only
  // the surface would prove nothing at all about a surface that cannot come up.
  copyFileSync(binaries.tool, join(dir, `ansiwise${suffix}`));
  const exe = join(dir, `ansiwise-rest${suffix}`);
  copyFileSync(binaries.rest, exe);
  writeFileSync(join(dir, "ansiwise.yaml"), [
    "log_level: info",
    "plugins:",
    "  - ansiwise-host",
    "elevation:",
    "  password_from_caller: true",
    "",
  ].join("\n"));
  mkdirSync(join(dir, "programs"));
  for (const [name, yaml] of Object.entries(programs)) {
    writeFileSync(join(dir, "programs", `${name}.yaml`), yaml);
  }

  return {
    exe,
    dir,
    close: async (): Promise<void> => {
      // Windows keeps an executable locked until the process holding it is GONE. Every process this
      // fixture's callers started is a `serve` of its own, killed when its conversation closed, so
      // the removal waits for the last of them rather than racing it.
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt >= 20) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    },
  };
}

/** WHERE the machine's run records land for an installation at [dir]: the `--runs` every `serve`
 *  of it is given (serveArgv), inside the installation, so close() removing [dir] removes every
 *  record with it. */
export function runRoot(dir: string): string {
  return join(dir, "runs");
}

/** THE ONE COMMAND LINE a `serve` of [fixture] is started with, wherever it is spawned from — the
 *  in-process channel below and the fake sshd's exec alike — so no serve is ever started without
 *  the run root that keeps its records inside the fixture. */
export function serveArgv(fixture: ServeFixture): string[] {
  return ["serve", "--programs", "programs", "--config", "ansiwise.yaml", "--runs", runRoot(fixture.dir)];
}

/** THE SURFACE, as a duplex: spawn the SERVING binary and its own standard input and output are the
 *  connection — which is exactly what an SSH exec channel hands a process. It is `ansiwise-rest
 *  serve`; the deployment tool answers "no program is called serve".
 *
 *  No credential rides here, and there is nowhere for one to ride: a session is authenticated by
 *  sshd before this process exists, and `serve` is the binary's only program. */
export function openChannel(fixture: ServeFixture): Duplex {
  const child = spawn(fixture.exe, serveArgv(fixture), { cwd: fixture.dir });
  const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
  channel.on("close", () => child.kill());
  return channel;
}
