import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SSHD_HELPERS } from "./password-login-probe.ts";
import { REMOTE_COMMANDS, REMOTE_SCRIPTS } from "./remote-scripts.fixture.ts";

// HOW THIS MANAGER REACHES ROOT ON A MACHINE, held to ONE route by reading the source back.
//
// The route is the password of the machine account, handed to a step by its run and put on the
// standard input of a `sudo -S` the step composes (executor/stepkit.ts `raised`). The route this
// repository does NOT take is `sudo -n`, which answers only where the machine carries a standing
// sudoers rule granting that exact command without a password.
//
// WHY THE SECOND ROUTE MAY NOT COME BACK. Nothing here writes such a rule, and the deployment takes
// one off a machine that still carries it (`remove-sudoers`, defs/manager-key.kit.ts) — so a `sudo -n`
// added to a step would be refused by every machine this platform deploys, with the daemon's own
// "interactive authentication is required", which reads on the run screen like a broken service
// rather than like a missing right. The failure is silent in a second way too: a `sudo -n` inside a
// probe that swallows stderr turns a refusal into an absent fact, and the card then shows a reading
// that was never taken.
//
// THIS IS THE INVERSE OF A TABLE OF PERMITTED COMMANDS, and it is the stronger statement: a list of
// what a machine may be asked to grant has to be kept in step with the call sites, while "no call
// site asks for anything" is one assertion that cannot fall behind.

/** Every source file of the server tree, tests and fixtures aside: what this manager ships. A
 *  fixture is excluded because the SCRIPTED MACHINE answers a `sudo -n` with a refusal, which is how
 *  a step reaching for a standing rule is caught while a suite runs rather than months later on
 *  somebody's machine (deploy-slave.first-contact.fixture.ts). Only the server tree is walked: it is
 *  the only tree that opens an SSH session at all. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes(".fixture.")) out.push(path);
  }
  return out;
}

/** Prose is not a call site: `sudo -n` written inside a comment says which route this repository
 *  refuses to take and elevates nothing, so the census reads the code with the comments taken out. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
}

/** Where a text asks a machine for a command it has no password for. Written as a function over the
 *  text rather than over the tree, so the same reading that clears the repository can be shown to
 *  find a planted occurrence — a scan whose only evidence is that it found nothing proves nothing. */
function standingRuleCallSites(text: string): string[] {
  return [...stripComments(text).matchAll(/sudo\s+-n\b[^\n]*/g)].map((m) => m[0].trim());
}

const SERVER_TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("every root command this manager sends is raised with the password its run carries", () => {
  it("asks no machine for a command it holds no password for", () => {
    const files = sourceFilesUnder(SERVER_TREE);
    expect(files.length).toBeGreaterThan(100); // a walk that found nothing would pass by measuring nothing
    const asking: string[] = [];
    for (const file of files) {
      for (const site of standingRuleCallSites(readFileSync(file, "utf8"))) {
        asking.push(`${relative(SERVER_TREE, file)}: ${site}`);
      }
    }
    expect(asking, "these reach root through a standing rule on the machine, which no run kind writes and the deployment removes").toEqual([]);
  });

  it("finds the two shapes that really stood here, so the reading above is a measurement and not a blind spot", () => {
    // The two call sites this repository carried, put back verbatim: the MicroK8s reset a failed
    // deploy's abort runs, and the tailnet probe's helper — which reached for the rule inside a `||`
    // that swallowed the refusal, so the coordinator simply went unreported.
    expect(standingRuleCallSites('await remoteCmd(ctx, session, "sudo -n snap remove --purge microk8s");'))
      .toEqual(["sudo -n snap remove --purge microk8s\");"]);
    expect(standingRuleCallSites('ts() { tailscale "$@" 2>/dev/null || sudo -n tailscale "$@" 2>/dev/null; }'))
      .toEqual(['sudo -n tailscale "$@" 2>/dev/null; }']);
    // …and the sentence a file is allowed to keep: the census reads code, and naming the refused
    // route in prose is how the next reader learns why it is refused.
    expect(standingRuleCallSites("// The route that is NOT taken is `sudo -n`, answered only by a standing rule.")).toEqual([]);
  });

  it("keeps `as_root` an assertion that the shell is root, never a way of becoming it", () => {
    // The one helper this repository ships under that name (password-login-probe.ts). Its call sites
    // read as intent — these lines need root — and the whole script around them is raised as a unit,
    // because one `sudo -S` per thing sent is all one password stretches to. A helper that elevated
    // per line would be a second route to root, and the first line to take it would consume the
    // password every later one then waits for.
    expect(SSHD_HELPERS).toContain("as_root()");
    expect(SSHD_HELPERS).not.toContain("sudo");
    expect(SSHD_HELPERS).toContain('[ "$(id -u)" = 0 ]');
  });

  it("sends NOTHING to a host that reads a Kubernetes Secret", () => {
    // WHY THIS IS A RULE AND NOT A PREFERENCE. Raising a command with the run's password is a route
    // to root and not a boundary: what it sends is contained by what the call sites choose to send,
    // so the shapes no operator would approve are held here. `kubectl get secrets` is the one that
    // cannot be narrowed anywhere else — Kubernetes RBAC has no grant that lists a Secret's name and
    // labels while refusing its value, since the same right serves `-o yaml`. Every shell this
    // manager sends is held to it, derived from the collection rather than from a list, so a
    // `get secrets` added anywhere is red here.
    const shell = [...REMOTE_SCRIPTS, ...REMOTE_COMMANDS];
    expect(shell.length).toBeGreaterThan(10); // a scan over nothing would pass by measuring nothing
    const reads = shell.filter((s) => /kubectl[^\n]*\bget\s+secrets?\b/.test(s.text)).map((s) => `${s.symbol} (${s.module})`);
    expect(reads, "these read Secrets on a host, and no route to root can contain that").toEqual([]);

    // AND THE TWO FACTS THE REPLACED LINE REPORTED ARE STILL REPORTED. ArgoCD registers a repository
    // and a cluster by the label `argocd.argoproj.io/secret-type` on a Secret in its namespace; the
    // diagnostic reads that label off the ExternalSecrets that compose those Secrets, together with
    // the target Secret each names and whether ESO wrote it.
    const diag = REMOTE_SCRIPTS.find((s) => s.symbol === "slaveDiagScript")?.text ?? "";
    expect(diag).not.toBe("");
    expect(diag).toContain("argocd credential registration");
    expect(diag).toContain('labels["argocd\\.argoproj\\.io/secret-type"]'); // the label that registers either one
    expect(diag).toContain(".spec.target.name"); // WHICH Secret it composes, so a miss is actionable
    expect(diag).toMatch(/argocd credential registration[\s\S]*conditions\[\?\(@\.type=="Ready"\)\]\.status/); // and whether it was written
  });
});
