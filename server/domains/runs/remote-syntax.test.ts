import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DISABLE_SCRIPT } from "./defs/password-login.kit.ts";
import { REMOTE_COMMANDS, REMOTE_SCRIPTS } from "./remote-scripts.fixture.ts";
import {
  findUnknownProgram, ANSIWISE_REST_TOOL, ANSIWISE_SESSION_PROGRAM, ANSIWISE_TOOL,
  BOOTSTRAP_HOME, PATH_HOME, EXECUTABLE_MODE,
} from "./defs/place-ansiwise.ts";

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

// ── THE SECOND READER: the engine, and the words this manager composes for it ─────────────────────
//
// `bash` is not the only program that reads what this repository ships. A command line naming one of
// the engine's binaries is read by THAT binary, which answers a word it does not carry with exit 64
// and a sentence — on the machine, three systems away from the line that composed it.
//
// WHY THIS CENSUS DOES NOT WALK SENDERS. The one above does, and that is right for bash: a script is
// shell BECAUSE something uploaded it as shell. A program word is wrong wherever it is written,
// whoever sends it, so this reads WORD LISTS out of the shipped source and asks nothing about how
// they travel. That matters because the senders are not two families but five — `remoteScript` and
// `remoteScriptCapture`; `remoteCmd`, `remoteExec` and `execCapture`; `PlacementMachine.run`'s
// argument lists; raw `session.exec` at nine call sites that bypass stepkit entirely; and the
// installation's own ANSIWISE_SERVE_COMMAND — and SENDERS above reaches only the first two, because
// it matches an identifier call and the rest are property-access calls or configuration. The word
// that went unnoticed (`install-service`, simetrixch/ansiwise-cli#14) stood in the third of those.
//
// WHAT A WORD LIST IS: an ARRAY whose elements are text is one list, in its own order; any other
// piece of text is its own contents split on whitespace. So `[`${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`,
// "install-service"]` and `` `cd /srv/x && ~/ansiwise-rest install-service` `` are the same finding,
// which is what lets this be one rule over both routes rather than two rules over two shapes.
//
// AND A TEMPLATE IS READ AS THE TEXT IT WILL BE. `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}` is what the
// deleted invocation actually looked like — nobody writes an executable's path as a bare literal —
// so a census reading templates as their source text would have missed the one defect it exists for.
// It was measured missing it before this stood here. Every `const NAME = "…"` in the shipped source
// is collected first and substituted in, which is a rule over this repository's own declarations and
// not a list of the names that matter. A substitution nothing declares becomes a word no rule can
// match, which is the honest reading: what stands there is decided at runtime.
//
// WHAT IT CANNOT REACH is text this repository never spells — a binary named from a value that
// arrives from outside the process. Nothing composes one today, and that is stated where the
// predicate is (defs/place-ansiwise.ts findUnknownProgram).

/** One word list as this repository wrote it, with where a reader finds it. */
interface WordList {
  where: string; // repo-relative file:line
  words: string[];
  source: string;
}

/** What a substitution nothing declares resolves to: a character no command line carries, so the
 *  word it stands in can match neither an executable nor a program name. */
const UNRESOLVED = "\u0000";

/** Every `const NAME = "…"` the shipped source declares. One map for the whole tree rather than one
 *  per file, because a word is composed out of constants imported from wherever they are declared. */
function constants(files: readonly string[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer !== undefined && ts.isStringLiteralLike(node.initializer)) {
        known.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return known;
}

/** The text [node] will BE, or undefined where it is not text at all. */
function textOf(node: ts.Node, sf: ts.SourceFile, known: Map<string, string>): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return undefined;
  return node.head.text + node.templateSpans
    .map((span) => (known.get(span.expression.getText(sf)) ?? UNRESOLVED) + span.literal.text)
    .join("");
}

/** Every word list in the shipped source under server/. Tests and fixtures are out, for the reason
 *  they are out of the census above and out of machine-state.test.ts's declaration half: they model
 *  what a MACHINE answers, and a model composed out of our own constants would agree with us by
 *  construction. */
function wordLists(): WordList[] {
  // A FIXTURE IS OUT, and it is the same exemption machine-state.test.ts states for its own halves:
  // a fixture models what a MACHINE or the real engine ANSWERS, so it spells the engine's refusals
  // on purpose — `ansiwise-rest has no program called "…"` is a sentence there and not a command.
  const files = sourceFiles(SERVER_ROOT).filter((f) => !f.endsWith(".fixture.ts"));
  const known = constants(files);
  const found: WordList[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    const at = (node: ts.Node): string =>
      `${relative(REPO_ROOT, file).split("\\").join("/")}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
      const elements = ts.isArrayLiteralExpression(node)
        ? node.elements.map((e) => textOf(e, sf, known))
        : undefined;
      if (elements !== undefined && elements.length > 1 && elements.every((w) => w !== undefined)) {
        found.push({ where: at(node), words: elements as string[], source: node.getText(sf).replaceAll("\n", " ") });
      } else {
        const text = textOf(node, sf, known);
        if (text !== undefined) {
          found.push({ where: at(node), words: text.split(/\s+/).filter((w) => w.length > 0), source: text.replaceAll("\n", " ") });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe("the second census: no word this manager composes names a program the engine does not carry", () => {
  const lists = wordLists();

  it("finds word lists at all (a census over nothing would pass by measuring nothing)", () => {
    expect(lists.length).toBeGreaterThan(100);
    // The engine's own names have to be among them, or this is reading a tree it does not recognise.
    expect(lists.some((l) => l.words.includes(ANSIWISE_REST_TOOL))).toBe(true);
  });

  it("every engine invocation in the shipped source names a program that binary has", () => {
    const wrong = lists
      .map((l) => ({ l, bad: findUnknownProgram(l.words) }))
      .filter((x) => x.bad !== undefined)
      .map((x) => `${x.l.where}: ${x.bad?.tool} has no program called "${x.bad?.word}" (it serves: ${x.bad?.serves.join(", ")}) — ${x.l.source}`);
    expect(
      wrong,
      "these compose a command naming a program the engine does not carry, so a machine answers them with exit 64 — " +
        "the engine's set is read off the binary itself (engine-programs.ansiwise.test.ts)",
    ).toEqual([]);
  });

  // THE PLANT, in the exact shape the deleted one had: the argument list place-ansiwise composed for
  // the resident door, which reached a machine and every check here stayed green.
  it("refuses a planted invocation of a program the engine does not carry, naming the word", () => {
    const planted = [`${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`, "install-service", "--listen", "127.0.0.1:9953"];
    expect(findUnknownProgram(planted)).toEqual({
      tool: ANSIWISE_REST_TOOL,
      word: "install-service",
      serves: [ANSIWISE_SESSION_PROGRAM],
    });
    // The same word inside a command LINE, because that is the other shape it reaches a machine in.
    expect(findUnknownProgram(`cd /srv/x && ${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL} install-service --answers -`.split(" "))?.word)
      .toBe("install-service");
  });

  // The innocent cases beside it, so a green answer above is the source and not a predicate that
  // finds nothing. Each of these is a real list this repository sends today.
  it.each([
    ["the version reading, whose word is an option", [`${PATH_HOME}${ANSIWISE_REST_TOOL}`, "--version"]],
    ["the raised copy, whose next word is a path", ["sudo", "-S", "install", "-m", EXECUTABLE_MODE.toString(8), `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`, `${PATH_HOME}${ANSIWISE_REST_TOOL}`]],
    ["the serve command an installation configures", ["cd", "/srv/ansiwise-catalog", "&&", `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`, ANSIWISE_SESSION_PROGRAM, "--programs", "ansiwise/programs"]],
    ["the deployment tool, whose programs are the machine's catalogue and not this repository's to know", [ANSIWISE_TOOL, "deploy-cluster", "--mode", "test"]],
  ])("reads past %s", (_what, words) => {
    expect(findUnknownProgram(words)).toBeUndefined();
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
