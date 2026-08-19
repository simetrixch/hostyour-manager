// The REAL `ansiwise serve`, started in-process for tests — never a mock of it. The contract
// under test (the gate, the answers validation, the run records, the ?from= resume) is the
// machine's own, so the fixture builds a minimal INSTALLATION (ansiwise.yaml + programs/) in a
// temp directory and starts the actual binary on it.
//
// WHERE THE BINARY COMES FROM: $ANSIWISE_BIN, or the sibling checkout's build output
// (../ansiwise-cli/build/ansiwise). Absent ⇒ the suites that need it SKIP, loudly — the same
// shape the ansiwise repositories use for a missing installation. It is COPIED into the
// fixture (Windows spawn needs the .exe name, and a copy cannot collide with a rebuild of the
// sibling checkout mid-test).
//
// THE PROGRAMS ARE PURE MEASUREMENTS: every step is require_answer_matches (ansiwise-host), a
// step that reads the run's own answers and touches nothing — so a `run` mode run is safe on
// the workstation and the record semantics are still the real engine's.

import { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { createServer, connect, type Server } from "node:net";

export function ansiwiseBinary(): string | undefined {
  const named = process.env.ANSIWISE_BIN;
  if (named && existsSync(named)) return named;
  for (const candidate of [
    resolve(process.cwd(), "..", "ansiwise-cli", "build", "ansiwise"),
    resolve(process.cwd(), "..", "ansiwise-cli", "build", "ansiwise.exe"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The reason a suite prints when it skips: actionable, not silent. */
export const NO_BINARY =
  "no ansiwise binary — set ANSIWISE_BIN or build the sibling checkout (ansiwise-cli tool/build.dart); " +
  "these tests prove the transport against the REAL `ansiwise serve` and cannot run without it";

/** One measuring row of a fixture program. */
export interface ProbeRow {
  answer: string;
  /** The regular expression the answer must match — '.+' passes anything non-empty, '$a' ("end
   *  then a") can never match and is the planted red. */
  pattern: string;
  /** Declare the answer optional with this default — for a program two verbs share, where one
   *  verb states the value and the other legitimately leaves the engine's default to fill it.
   *  The default is then what the pattern judges for the silent verb, so a default that matches
   *  cannot tell "sent the right value" from "sent nothing"; use it only where that is stated. */
  fallback?: string;
}

export function programYaml(name: string, rows: ProbeRow[]): string {
  const byAnswer = new Map(rows.map((r) => [r.answer, r]));
  return [
    `name: ${name}`,
    "roles: [master, slave]",
    "answers:",
    ...[...byAnswer.values()].flatMap((r) => [
      `  - name: ${r.answer}`,
      "    kind: text",
      ...(r.fallback !== undefined ? ["    required: false", `    default: '${r.fallback}'`] : []),
      `    describes: the ${r.answer} this fixture measures`,
    ]),
    "steps:",
    ...rows.flatMap((r) => [
      "  - step: require_answer_matches",
      `    answer: ${r.answer}`,
      `    pattern: '${r.pattern}'`,
      `    refusal: the ${r.answer} does not match ${r.pattern}`,
      "    on_failure: exit",
    ]),
    "",
  ].join("\n");
}

/** The credential every caller on the fixture's address presents.
 *
 *  A fixture that served open would prove the transport against a surface nobody will run: an
 *  address is authenticated by nothing until a token says otherwise, and the binary refuses to bind
 *  one without a token file behind it. */
export const FIXTURE_SERVICE_TOKEN = "a-token-for-the-transport-proof";

export interface ServeFixture {
  /** The listening surface's address. */
  port: number;
  /** What a caller on that address must present. */
  token: string;
  /** The binary itself, for a caller that wants the CHANNEL form: spawn it and its own stdio is the
   *  connection, which is what an SSH exec channel gives. */
  exe: string;
  /** The installation the binary runs from. */
  dir: string;
  /** Delete the installation, the serve process, and every run record the machine wrote. */
  close(): Promise<void>;
}

/** Build an installation carrying [programs] and start the real binary on it, listening on an
 *  OS-chosen port. The channel form of serve is served by piping a channel to this listener —
 *  same binary, same surface, one door (the stdio door is mute today; see the handover in the
 *  session that wrote this fixture). */
export async function startServe(binary: string, programs: Record<string, string>): Promise<ServeFixture> {
  const dir = mkdtempSync(join(tmpdir(), "ansiwise-serve-"));
  const exe = join(dir, process.platform === "win32" ? "ansiwise.exe" : "ansiwise");
  copyFileSync(binary, exe);
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

  const tokenFile = join(dir, "service-token");
  writeFileSync(tokenFile, FIXTURE_SERVICE_TOKEN);
  const child: ChildProcess = spawn(
    exe,
    ["serve", "--listen", "127.0.0.1:0", "--service-token-file", tokenFile],
    { cwd: dir },
  );
  const port = await new Promise<number>((res, rej) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      const m = /serving on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) res(Number(m[1]));
    });
    child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("exit", (code) => rej(new Error(`ansiwise serve exited ${code} before binding — a binary without --listen predates the resident service; rebuild it\n${out}${err}`)));
    setTimeout(() => rej(new Error(`ansiwise serve did not bind within 20s\n${out}${err}`)), 20_000).unref();
  });

  return {
    port,
    token: FIXTURE_SERVICE_TOKEN,
    exe,
    dir,
    close: async (): Promise<void> => {
      // Windows keeps the executable locked until the process is GONE, so the removal waits for
      // the exit rather than racing it.
      const exited = new Promise<void>((res) => (child.exitCode !== null ? res() : child.once("exit", () => res())));
      child.kill();
      await exited;
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt >= 20) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      // The engine's run root is fixed ('/var/lib/ansiwise/runs', RunDirectory.defaultRoot),
      // which on Windows lands on the drive of the process's working directory — this fixture's
      // temp dir. Removing it un-does everything the detached run children wrote.
      rmSync(runRoot(dir), { recursive: true, force: true });
    },
  };
}

/** WHERE the machine's run records land for an installation at [dir] (see close above). */
export function runRoot(dir: string): string {
  return process.platform === "win32" ? join(parse(resolve(dir)).root, "var", "lib", "ansiwise", "runs") : "/var/lib/ansiwise/runs";
}

export interface StartSpacer {
  port: number;
  close(): void;
}

/** A pass-through TCP proxy in front of the serve listener that holds every `POST /runs` back
 *  by [delayMs] before forwarding it.
 *
 *  WHY IT EXISTS: the machine names a run by second + pid (ansiwise-cli _newRunId), so two runs
 *  STARTED within the same second collide onto one record — a real defect for the resident
 *  service, handed to ansiwise-cli. Real programs never trip it (a dry run of deploy-cluster
 *  takes minutes); the fixture's measuring programs finish in milliseconds, so without spacing
 *  the starts the tests would prove the collision instead of the transport. */
export function startSpacer(targetPort: number, delayMs = 1_100): Promise<StartSpacer> {
  const server: Server = createServer((downstream) => {
    const upstream = connect(targetPort, "127.0.0.1");
    // Chunks stay IN ORDER through the delay: a held-back request start must not be overtaken
    // by its own body arriving in a later chunk, so every chunk rides one promise chain.
    let chain: Promise<void> = Promise.resolve();
    const forward = (wait: number, act: () => void): void => {
      chain = chain.then(() => new Promise<void>((r) => setTimeout(r, wait))).then(act);
    };
    downstream.on("data", (chunk: Buffer) => {
      forward(chunk.toString("latin1").startsWith("POST /runs") ? delayMs : 0, () => void upstream.write(chunk));
    });
    downstream.on("end", () => forward(0, () => upstream.end()));
    upstream.pipe(downstream);
    const drop = (): void => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on("error", drop);
    upstream.on("error", drop);
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      res({
        port: addr !== null && typeof addr === "object" ? addr.port : 0,
        close: (): void => void server.close(),
      });
    });
  });
}

/** The CHANNEL form of the surface, as a duplex: spawn the binary and its own standard input and
 *  output are the connection — which is exactly what an SSH exec channel hands a process.
 *
 *  No token rides here. A session is authenticated by sshd, and a machine at its first installation
 *  holds no token yet, so the channel door demands none by construction. */
export function openChannel(fixture: ServeFixture): Duplex {
  const child = spawn(fixture.exe, ["serve", "--programs", "programs", "--config", "ansiwise.yaml"], {
    cwd: fixture.dir,
  });
  const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
  channel.on("close", () => child.kill());
  return channel;
}
