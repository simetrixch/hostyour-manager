import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { REMOTE_COMMANDS, REMOTE_SCRIPTS } from "./remote-scripts.fixture.ts";
import {
  MACHINE_STATE, MANAGER_HANDS_OVER, PLATFORM_STATE_ROOTS,
} from "./defs/machine-state.ts";

// THE CHECK THAT HOLDS THE OWNERSHIP RULE, and it is written to go red on a place NOBODY HAS MADE
// YET.
//
// defs/machine-state.ts states in one sentence which account owns what this platform leaves on a
// machine. Such places get repaired one at a time and each repair only uncovers the next: a check
// that listed the known ones would be another copy of the same list and
// would say nothing at all about the next place. So neither half below knows a list. One holds a
// NEIGHBOURHOOD — a literal under a directory this platform makes its state in comes from the
// registry or the tree is red — and the other holds the SURFACE, so a path this manager sends to a
// machine that the registry cannot answer is red wherever it was written.
//
// HOW MUCH IS COVERED, and what it cannot reach is named rather than counted:
//
//   THE DECLARATION HALF reads every shipped module under server/ with the TypeScript compiler and
//   looks at string literals only, so a path in a COMMENT is not a finding — a comment explains, it
//   does not reach a machine. It refuses a literal under [PLATFORM_STATE_ROOTS] or under a registry
//   path anywhere but the registry itself. What it does NOT reach is a place under a root nobody has
//   named yet, and that is what the second half is for.
//
//   THE SURFACE HALF reads every script this manager uploads and every command line it composes
//   under a name (remote-scripts.fixture.ts, whose SET is held complete by remote-syntax.test.ts's
//   own census). Every absolute path in them has to be answered: the registry, the machine's own
//   operating system, or one of the two files this platform writes into a directory the machine
//   already has. What it does NOT reach is a command written INLINE at a call site —
//   remote-syntax.test.ts holds every one of those to a single line, so it is a line the reader of
//   the call site sees whole — nor an argument list the placement composes for `machine.run`. The one
//   of those that carried absolute paths was `installServiceArgv`, named here by hand until
//   simetrixch/ansiwise-cli#14 deleted the program it invoked. Those argument lists ARE read now, by
//   the second census in remote-syntax.test.ts, but only for the program word in them: that census
//   asks which binary a word invokes and never which paths a command carries, so a path written into
//   an argument list is still answered by nobody.
//
//   NEITHER HALF ASKS A MACHINE. What is proven here is that no path reaches a machine from this
//   repository without an ownership answer. Whether the account can actually write each of them ON A
//   MACHINE is read there, by the handover this manager runs before the first program and by the
//   `hand_directory_to_account` rows of the programs after it.
//
// TESTS, FIXTURES AND THE PORTS' FAKES ARE OUT OF THE DECLARATION HALF, and that is not an exemption
// from the rule but a property of what they are: they model what the MACHINE and the real engine
// answer, and a model that composed its answer out of our own constants would agree with us by
// construction instead of by measurement (deploy-slave.placement.fixture.ts states the same rule
// about the two executables). A test names a path because it is asserting about that path.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_ROOT = "server";
const REGISTRY = "server/domains/runs/defs/machine-state.ts";

/** The top-level directories of a UNIX filesystem, so an absolute path is recognised by what a
 *  machine's root actually holds rather than by a list of the ones this platform happens to use.
 *  Writing them out is stating an outside standard: the Filesystem Hierarchy Standard fixes these
 *  names and nobody here can rename one. */
const FHS_TOP = [
  "bin", "boot", "dev", "etc", "home", "lib", "lib64", "media", "mnt", "opt",
  "proc", "root", "run", "sbin", "srv", "sys", "tmp", "usr", "var",
];

/** An absolute path as it stands in a script: it starts where nothing that could make it part of a
 *  URL or of another path stands in front of it, and its first segment is a directory of the
 *  machine's root. */
const ABSOLUTE_PATH = new RegExp(String.raw`(?<![A-Za-z0-9:/._-])/(?:${FHS_TOP.join("|")})(?:/[A-Za-z0-9._-]+)*`, "g");

/** Paths of the machine's OWN operating system: this manager reads them, asks them a question or
 *  executes them, and creates none of them. They are outside the ownership rule because this
 *  platform did not put them there. */
const MACHINE_OWN = [
  "/usr/bin/env",
  "/usr/sbin/sshd",
  "/etc/ssh/sshd_config",
  "/etc/ssh/sshd_config.d",
  "/dev/null",
  "/dev/tcp",
];

/** The two files this platform WRITES into a configuration directory the machine already has, and
 *  the one class of thing it puts on a machine that the ownership rule deliberately does not cover:
 *  sudo and sshd each refuse a file they do not own, so the owner is decided by the daemon that
 *  READS the file and handing either to the operating account would take it out of service.
 *  defs/machine-state.ts names both in its header for the same reason they are named here — an
 *  omission nobody can see reads as a rule that covers everything. */
const DAEMON_OWNED = [
  "/etc/sudoers.d/90-hostyour",
  "/etc/ssh/sshd_config.d/00-hostyour-passwords.conf",
];

/** The directory each port keeps its shipped fake in (CLAUDE.md, Ports and adapters). */
const FAKES = "/testing/";

/** Every shipped module under server/: no test, no fixture, no port fake, and not the registry. */
function shippedModules(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.includes("fixture")) continue;
      const path = relative(ROOT, full).replaceAll("\\", "/");
      if (path === REGISTRY || path.includes(FAKES)) continue;
      out.push({ path, text: readFileSync(full, "utf8") });
    }
  };
  walk(join(ROOT, SOURCE_ROOT));
  return out;
}

/** Every string a module writes down — plain strings and every piece of a template literal — with
 *  the line it stands on. Comments are not literals, which is exactly what keeps an explanation that
 *  NAMES a path from reading as a place that reaches a machine. */
function literals(path: string, text: string): { line: number; value: string }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: { line: number; value: string }[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ) {
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        value: (node as ts.LiteralLikeNode).text,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/** Is `path` the machine state at `entry`, or something standing inside it? */
const inside = (path: string, entry: string): boolean => path === entry || path.startsWith(`${entry}/`);

/** Every absolute path this manager sends to a machine, keyed by what sends it. */
function surfacePaths(): { symbol: string; path: string }[] {
  const rendered = [...REMOTE_SCRIPTS, ...REMOTE_COMMANDS];
  return rendered.flatMap((r) =>
    [...new Set(r.text.match(ABSOLUTE_PATH) ?? [])].map((path) => ({ symbol: r.symbol, path })));
}

describe("the ownership rule: one sentence, and nothing reaches a machine without an answer from it", () => {
  it("reads every shipped module under server/, so a clean answer means the tree was looked at", () => {
    const modules = shippedModules();
    expect(modules.length).toBeGreaterThan(150);
    expect(modules.some((m) => m.path === "server/domains/runs/defs/place-ansiwise.ts")).toBe(true);
    // The registry is the one module held out, and holding it out only works while it is there.
    expect(modules.some((m) => m.path === REGISTRY)).toBe(false);
    expect(readFileSync(join(ROOT, REGISTRY), "utf8")).toContain("belongs to the account the manager reaches it as");
  });

  it("still finds the paths it is looking for, so a clean answer is a refusal and not a blind scan", () => {
    // The innocent case for the declaration half: the registry's own literals are exactly what the
    // pattern below refuses everywhere else, and a scanner that had stopped seeing them would report
    // the tree clean while every module said what it liked.
    const registry = literals(REGISTRY, readFileSync(join(ROOT, REGISTRY), "utf8"));
    for (const root of PLATFORM_STATE_ROOTS) {
      expect(registry.some((l) => l.value.startsWith(root)), root).toBe(true);
    }
    for (const entry of MACHINE_STATE) {
      expect(registry.some((l) => entry.path.startsWith(l.value)), entry.path).toBe(true);
    }
  });

  it("lets no module but the registry write a path where this platform keeps a machine's state", () => {
    const offenders = shippedModules().flatMap((m) =>
      literals(m.path, m.text)
        .filter((l) =>
          PLATFORM_STATE_ROOTS.some((root) => l.value.startsWith(root))
          || MACHINE_STATE.some((e) => inside(l.value, e.path)))
        .map((l) => `${m.path}:${l.line} ${l.value}`));
    expect(
      offenders,
      "a machine's platform state is declared in " + REGISTRY + ", which states which account owns it — "
      + `import the path from there instead of writing it: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("answers every absolute path this manager sends to a machine", () => {
    const unanswered = surfacePaths()
      .filter(({ path }) =>
        !MACHINE_STATE.some((e) => inside(path, e.path))
        && !MACHINE_OWN.includes(path)
        && !DAEMON_OWNED.includes(path))
      .map(({ symbol, path }) => `${symbol} sends ${path}`);
    expect(
      unanswered,
      "every path this manager puts on a machine names the account that owns it — add it to MACHINE_STATE in "
      + `${REGISTRY}, or say here that the machine already had it: ${unanswered.join(", ")}`,
    ).toEqual([]);
  });

  it("still finds every path the two allowances name — an allowance nothing uses covers a future one", () => {
    // The second innocent case. A path allowed here that no script sends any more is an entry that
    // would silently answer for the next thing written under that name, so it is a failure of its
    // own rather than harmless tidiness.
    const sent = new Set(surfacePaths().map((s) => s.path));
    for (const path of [...MACHINE_OWN, ...DAEMON_OWNED]) {
      expect(sent.has(path), `${path} is allowed here and nothing sends it any more`).toBe(true);
    }
  });

  it("hands over what only this manager can hand over, and every one of it belongs to the account", () => {
    // The bootstrap slice is derived from the registry rather than written twice, so what this holds
    // is the derivation: it is not empty (a filter that matched nothing would hand over nothing while
    // the step still reported success), and nothing root keeps can end up in it.
    expect(MANAGER_HANDS_OVER.length).toBeGreaterThan(0);
    for (const entry of MANAGER_HANDS_OVER) {
      expect(entry.owner, entry.path).toBe("operator");
      expect(MACHINE_STATE).toContain(entry);
    }
    // A parent stands before what is inside it, which is what lets the handover run straight through
    // without creating a child under a parent it has not corrected yet.
    const order = MACHINE_STATE.map((e) => e.path);
    for (const [i, path] of order.entries()) {
      const parent = order.findIndex((other) => other !== path && inside(path, other));
      expect(parent === -1 || parent < i, `${path} stands before the directory it is inside`).toBe(true);
    }
  });
});
