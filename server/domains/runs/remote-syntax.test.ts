import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { sudoersDropIn } from "./defs/adopt.ts";
import { DISABLE_SCRIPT, ENABLE_SCRIPT } from "./defs/password-login.kit.ts";

// WHAT THIS MANAGER SHIPS TO A MACHINE, READ BY THE PROGRAMS THAT WILL READ IT THERE.
//
// Two artifacts leave this repository as TEXT and are parsed for the first time on somebody's
// machine: the sudoers drop-in the adoption installs, and the bash scripts the password-login run
// kinds upload. Everything this repository knows about either one is a model of the real parser —
// the sudoers matcher in adopt.fixture.ts models fnmatch(3), and nothing at all models bash — so a
// file that no real parser has ever read is a file whose first reader is the customer.
//
// What each failure costs is what makes this worth its runtime. A sudoers file sudo refuses is
// refused WHOLE: the account loses every rule in it at once, and the adoption that installed it has
// already taken the machine's previous grant away. A bash script with a syntax error runs nothing
// and reports an exit code from a host, so the operator reads a run that failed on the machine and
// starts looking at the machine.
//
// HOW MUCH IS COVERED: the drop-in as it is rendered, and the two password-login scripts. Every
// other script this repository uploads — the preflight, the baseline, the tailnet probe, the
// deploy-slave remote scripts — is still parsed for the first time on the host.

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

const VISUDO = reachable("visudo");
const BASH = reachable("bash");
const ABSENT = (tool: string): string =>
  `no ${tool} this suite can reach — install it, or on Windows install a WSL distribution that carries it; ` +
  `until then nothing in this repository has ever parsed what it ships`;

describe.skipIf(!VISUDO)("the sudoers drop-in, parsed by a real sudo", () => {
  if (!VISUDO) {
    // eslint-disable-next-line no-console -- a skipped parser must be loud: a silent skip reads as a pass
    console.warn(ABSENT("visudo"));
  }

  const checked = (text: string): { ok: boolean; report: string } => parse((f) => `visudo -c -f ${f}`, text);

  it("parses the file the adoption installs", () => {
    const { ok, report } = checked(sudoersDropIn("digi1"));
    expect(report).toBe("");
    expect(ok).toBe(true);
  });

  it("parses it for a user name that is not a shell word", () => {
    // The account name comes off the server row and is whatever the operator typed, so the rendered
    // file is not one file — it is one per adopted machine.
    const { ok, report } = checked(sudoersDropIn("ubuntu-2"));
    expect(report).toBe("");
    expect(ok).toBe(true);
  });

  // THE PLANT, and it is the shape this file could really take: a line continuation that stops
  // continuing. `sudoersDropIn` joins the rules with ", \\\n    ", and a join that lost its
  // backslash leaves every rule after the first standing as a sudoers line of its own.
  it("refuses a drop-in whose rules run past the end of the line", () => {
    const broken = sudoersDropIn("digi1").replace(", \\\n", ",\n");
    expect(broken, "the plant matched nothing — this case would be measuring today's file").not.toBe(sudoersDropIn("digi1"));
    const { ok, report } = checked(broken);
    expect(ok).toBe(false);
    expect(report).toContain("syntax error");
  });

  // The other half: a real parser has to reject a rule that is simply not a rule, or "parsed OK"
  // would mean nothing about the file above.
  it("refuses a rule whose command is not a fully-qualified path", () => {
    const { ok } = checked("digi1 ALL=(root) NOPASSWD: true\n");
    expect(ok).toBe(false);
  });
});

describe.skipIf(!BASH)("the scripts the password-login run kinds upload, parsed by a real bash", () => {
  if (!BASH) {
    // eslint-disable-next-line no-console -- a skipped parser must be loud: a silent skip reads as a pass
    console.warn(ABSENT("bash"));
  }

  const checked = (text: string): { ok: boolean; report: string } => parse((f) => `bash -n ${f}`, text);

  it.each([["cluster-password-login-disable", DISABLE_SCRIPT], ["cluster-password-login-enable", ENABLE_SCRIPT]])(
    "parses the script %s ships",
    (_kind, script) => {
      const { ok, report } = checked(script);
      expect(report).toBe("");
      expect(ok).toBe(true);
    },
  );

  // THE PLANT: one unbalanced brace, which is what a hand-edited shell function in a template
  // literal actually breaks as. bash reads the whole file before running any of it, so this is the
  // error that costs a run and reports it from the host.
  it("refuses a script whose function is left open", () => {
    const { ok, report } = checked(DISABLE_SCRIPT.replace("write_drop_in() {", "write_drop_in() { {"));
    expect(ok).toBe(false);
    expect(report).toContain("unexpected end of file");
  });

  // The innocent case beside it: a script that says nothing but is well formed parses, so a red
  // answer above is the brace and not the pipeline this test drives it through.
  it("parses a script that is merely empty", () => {
    expect(checked("#!/usr/bin/env bash\n").ok).toBe(true);
  });
});
