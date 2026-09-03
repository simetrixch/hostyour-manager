import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DISABLE_SCRIPT } from "./defs/password-login.kit.ts";
import { REMOTE_COMMANDS, REMOTE_SCRIPTS } from "./remote-scripts.fixture.ts";

// WHAT THIS MANAGER SHIPS TO A MACHINE, READ BY THE PROGRAM THAT WILL READ IT THERE.
//
// Every bash script a run uploads leaves this repository as TEXT and would otherwise be parsed for
// the first time on somebody's machine. Nothing here models bash, so text that no real parser has
// ever read is text whose first reader is the customer.
//
// What a failure costs is what makes this worth its runtime. A bash script with a syntax error runs
// nothing and reports an exit code from a host, so the operator reads a run that failed on the
// machine and starts looking at the machine.
//
// HOW MUCH IS COVERED: every script a run UPLOADS, and every command
// LINE a run composes under a name. The set is not a list here — the census below walks the source
// with the TypeScript compiler and fails when a call sends something the collection does not carry,
// so shell added to a run cannot quietly narrow this check.
//
// WHAT IT DOES NOT REACH, and it is held rather than merely admitted: a command written INLINE at its
// call site. The census holds every one of those to a single line, because a one-line command is one
// the reader sees whole and cannot carry an unclosed block; the moment one grows a second line the
// census fails and it has to become a symbol like everything else.

/** How a POSIX shell is reached from here. On Linux it is the shell itself; on Windows, where this
 *  suite runs today, the same tools answer inside WSL. Nothing else is tried: a parser that is not
 *  the real one would be worth less than no parser, because it would read as a guarantee. */
const SHELL = process.platform === "win32"
  ? { file: "wsl", args: ["-e", "sh", "-c"] }
  : { file: "sh", args: ["-c"] };

/** Is [tool] on the PATH of that shell? The answer is its own path, so a distribution that is not
 *  installed at all (wsl.exe present, no distro) says no rather than answering with its own error. */
function reachable(tool: string): boolean {
  try {
    const out = execFileSync(SHELL.file, [...SHELL.args, `command -v ${tool}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().startsWith("/");
  } catch {
    return false;
  }
}

/** Hand [text] to [check] as a file and report what the parser said. The file is written on the
 *  parser's own side — the text rides in on stdin — so the Windows path and the Linux path differ
 *  in nothing but which shell runs the same three commands. */
function parse(check: (file: string) => string, text: string): { ok: boolean; report: string } {
  const script = `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && f="$d/subject" && cat > "$f" && ${check('"$f"')}`;
  try {
    execFileSync(SHELL.file, [...SHELL.args, script], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, report: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, report: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const BASH = reachable("bash");
const ABSENT = (tool: string): string =>
  `no ${tool} this suite can reach — install it, or on Windows install a WSL distribution that carries it; ` +
  `until then nothing in this repository has ever parsed what it ships`;

// ── THE CENSUS: which scripts this repository actually uploads ────────────────────────────────────
//
// The two uploaders (executor/stepkit.ts) write their fourth argument to /tmp on the host and run it
// with bash. So the set of scripts this repository ships is the set of fourth arguments, and reading
// it out of the source with the compiler is the only way it stays right when somebody adds a run.
// A hand-written list would go stale on the first addition, and from then on this file would read as
// a guarantee while covering less than it did.
//
// A run reaches a host two ways, and both are shell this repository composed. remoteScript uploads a
// FILE; remoteCmd/remoteExec/execCapture send a command LINE. A quote closed one character early
// breaks either of them, so both are read here — the argument position is all that differs.
const SENDERS: readonly { names: ReadonlySet<string>; argIndex: number; what: "script" | "command" }[] = [
  { names: new Set(["remoteScript", "remoteScriptCapture"]), argIndex: 3, what: "script" }, // (ctx, session, name, script, opts)
  { names: new Set(["remoteCmd", "remoteExec", "execCapture"]), argIndex: 2, what: "command" }, // (ctx, session, command, ...)
];
const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = join(SERVER_ROOT, "..");

/** Every non-test TypeScript file under server/. Tests are excluded because a script written inside
 *  a test is never uploaded to anything. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Send {
  where: string; // repo-relative file:line
  what: "script" | "command";
  /** The exported const or function the call sends, or null when the shell is written inline. */
  symbol: string | null;
  source: string; // the argument as written, for a message somebody can act on
  inlineLines: number; // how many lines an inline literal spans; 0 when the call names a symbol
}

/** Every call in the tree that sends shell to a host, with the symbol its shell argument names. An
 *  argument that is neither an identifier nor a call of one is written inline: it resolves to null
 *  and carries its own line count, which is what the rules below are held against. */
function sends(): Send[] {
  const found: Send[] = [];
  for (const file of sourceFiles(SERVER_ROOT)) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const sender = SENDERS.find((s) => s.names.has(node.expression.getText(sf)));
        if (sender) {
          const arg = node.arguments[sender.argIndex];
          const symbol = arg === undefined
            ? null
            : ts.isIdentifier(arg)
              ? arg.text
              : ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)
                ? arg.expression.text
                : null;
          const written = arg === undefined ? "(no shell argument)" : arg.getText(sf);
          found.push({
            where: `${relative(REPO_ROOT, file).split("\\").join("/")}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
            what: sender.what,
            symbol,
            source: written.replaceAll("\n", "\\n").slice(0, 140),
            inlineLines: symbol === null ? written.split("\n").length : 0,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe("the census: every shell a run sends to a host is in the collection", () => {
  const calls = sends();
  const scripts = calls.filter((c) => c.what === "script");
  const commands = calls.filter((c) => c.what === "command");

  it("finds the call sites at all (a census over nothing would pass by measuring nothing)", () => {
    expect(scripts.length).toBeGreaterThan(10);
    expect(commands.length).toBeGreaterThan(10);
    expect(REMOTE_SCRIPTS.length).toBeGreaterThan(10);
    expect(REMOTE_COMMANDS.length).toBeGreaterThan(0);
  });

  it("every UPLOADED script names its source by a symbol the collection can reach", () => {
    // An uploaded script is a whole file the host runs. There is no size at which writing one inline
    // is safe, so this admits no exceptions: nothing here may be anonymous.
    const anonymous = scripts.filter((c) => c.symbol === null).map((c) => `${c.where}: ${c.source}`);
    expect(
      anonymous,
      "these calls upload a script no name reaches, so nothing can parse it before the host does — " +
        "lift it into an exported const or function and add it to remote-scripts.fixture.ts",
    ).toEqual([]);
  });

  it("every INLINE command is a single line — a second line is where a missing fi hides", () => {
    // A one-line command is one the reader of the call site sees whole, and it cannot carry an
    // unclosed block. The moment one grows a second line it has to become a symbol, so that it can
    // be rendered and handed to bash like everything else.
    const sprawling = commands.filter((c) => c.inlineLines > 1).map((c) => `${c.where}: ${c.source}`);
    expect(
      sprawling,
      "these command lines are written inline across more than one line, so no parser can reach them — " +
        "lift each into an exported const or function and add it to REMOTE_COMMANDS",
    ).toEqual([]);
  });

  it.each([
    ["script", () => scripts, () => REMOTE_SCRIPTS, "REMOTE_SCRIPTS"],
    ["command", () => commands, () => REMOTE_COMMANDS, "REMOTE_COMMANDS"],
  ])("covers exactly the %s symbols the runs send — nothing missing, nothing stale", (_what, sites, collection, name) => {
    const sent = [...new Set(sites().map((c) => c.symbol).filter((s): s is string => s !== null))].sort();
    const collected = [...new Set(collection().map((s) => s.symbol))].sort();
    expect(sent.filter((s) => !collected.includes(s)), `sent by a run and never parsed here — add it to ${name}`).toEqual([]);
    expect(collected.filter((s) => !sent.includes(s)), `parsed here but no run sends it — the entry outlived its call site`).toEqual([]);
  });
});

describe.skipIf(!BASH)("every shell this manager sends to a host, parsed by a real bash", () => {
  if (!BASH) {
    // eslint-disable-next-line no-console -- a skipped parser must be loud: a silent skip reads as a pass
    console.warn(ABSENT("bash"));
  }

  const checked = (text: string): { ok: boolean; report: string } => parse((f) => `bash -n ${f}`, text);

  const ALL = [...REMOTE_SCRIPTS, ...REMOTE_COMMANDS];

  it.each(ALL.map((s) => [s.symbol, s.module, s.text] as const))(
    "parses %s (%s)",
    (_symbol, _module, text) => {
      const { ok, report } = checked(text);
      expect(report).toBe("");
      expect(ok).toBe(true);
    },
  );

  it("says HOW MANY it parsed, so a run that parsed none cannot read as a clean answer", () => {
    // eslint-disable-next-line no-console -- the coverage figure is the point of the check, not noise
    console.info(`bash -n parsed ${REMOTE_SCRIPTS.length} uploaded script(s) and ${REMOTE_COMMANDS.length} composed command line(s)`);
    // Each entry is one distinct symbol carrying real text — so the figure above counts subjects
    // rather than repeats, and an entry whose renderer returned "" cannot pass as parsed.
    expect(ALL.length).toBe(new Set(ALL.map((s) => s.symbol)).size);
    expect(ALL.filter((s) => s.text.trim().length === 0)).toEqual([]);
  });

  // THE PLANTS, one per shape bash -n catches. Each is a real way a shell script written as a
  // TypeScript template literal breaks: the compiler checks the interpolation and never the shell.
  it.each([
    ["a function left open", (s: string) => s.replace("write_drop_in() {", "write_drop_in() { {"), "unexpected end of file"],
    ["an if with no fi", (s: string) => `${s}\nif [ -f /etc/hostname ]; then echo yes\n`, "unexpected end of file"],
    ["a for with no done", (s: string) => `${s}\nfor f in a b c; do echo "$f"\n`, "unexpected end of file"],
    ["a quote closed one character early", (s: string) => `${s}\necho "unterminated\n`, "unexpected EOF while looking for matching"],
    ["a case with no esac", (s: string) => `${s}\ncase x in a) echo a ;;\n`, "unexpected end of file"],
  ])("refuses %s", (_shape, plant, complaint) => {
    const broken = plant(DISABLE_SCRIPT);
    expect(broken, "the plant matched nothing — this case would be measuring today's file").not.toBe(DISABLE_SCRIPT);
    const { ok, report } = checked(broken);
    expect(ok).toBe(false);
    expect(report).toContain(complaint);
  });

  // The innocent case beside them: a script that says nothing but is well formed parses, so a red
  // answer above is the plant and not the pipeline this test drives it through.
  it("parses a script that is merely empty", () => {
    expect(checked("#!/usr/bin/env bash\n").ok).toBe(true);
  });
});
