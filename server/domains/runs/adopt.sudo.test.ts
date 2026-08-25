import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { adoptDef, elevatedName, MANAGER_ELEVATED, SUDOERS_DROP_IN, sudoersDropIn, unpinnedElevated, type ElevatedCommand } from "./defs/adopt.ts";
import { DROP_IN as SSHD_DROP_IN } from "./defs/password-login.kit.ts";
import { TAILNET_PROBE_SCRIPT } from "./tailnet-probe.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import { servers } from "../../db/schema/inventory.ts";
import {
  adoptWorkbench, fakeFactory, sudoersPermits,
  BLANKET_LINE, LEGACY_BLANKET_DROP_IN, HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, PASSWORD, type FakeHost,
} from "./adopt.fixture.ts";

/** Every source file of the server tree, tests and fixtures aside: what the census reads to find
 *  the commands this manager elevates. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes(".fixture.")) out.push(path);
  }
  return out;
}

/** Prose is not a call site: `sudo -n` written inside a comment describes the mechanism and
 *  elevates nothing, so the census reads the code with the comments taken out. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
}

// ---------------------------------------------------------------------------------------------
// The passwordless-sudo grant (configure-sudo): what an adopted machine ends up granting, what it
// stops granting, and what the operator is told before approving. Every assertion here is about the
// MACHINE'S state — the file it carries and the commands it will run as root — and never about the
// command line the run happened to compose to get there.
// ---------------------------------------------------------------------------------------------
describe("adopt run — what the adoption leaves the machine granting", () => {
  const bench = adoptWorkbench();
  afterEach(() => bench.dispose());
  const make = bench.make;

  function configureSudoCheckpoint(db: DbHandle, runId: string): { data?: { sudoersWritten?: boolean }; __cleanups?: string[] } {
    return JSON.parse(stepColumn(db, runId, "configure-sudo", "checkpoint_json") ?? "{}") as
      { data?: { sudoersWritten?: boolean }; __cleanups?: string[] };
  }

  it("grants the NAMED commands on a non-root account and never the blanket right, arms the removal, and says in the log that it STAYS", async () => {
    // The ordinary first adoption: a cloud-image account in the machine's own sudo group, which is
    // what the operator's password buys `install` on a machine carrying no drop-in yet.
    const host: FakeHost = { commands: [], machineSudo: "password" };
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, undefined, host), "digi1");
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    // THE MACHINE'S OWN STATE, not the command line that produced it: the file the run left carries
    // every command the manager elevates and no line granting all of them.
    expect(host.dropIn).not.toBeNull();
    expect(host.dropIn).not.toMatch(BLANKET_LINE);
    for (const e of MANAGER_ELEVATED) expect(host.dropIn).toContain(e.cmd);
    expect(configureSudoCheckpoint(db, runId)).toMatchObject({ data: { sudoersWritten: true }, __cleanups: ["remove-sudoers"] });
    // The run log names the lifetime, because nothing else on any screen does: remove-sudoers is a
    // Cleanup and cleanups run only on abortWithCleanup (server/executor/executor.ts:309).
    const meta = readEvents(db.db, runId).filter((e) => e.stream === "meta").map((e) => e.text).join("\n");
    expect(meta).toContain("STAYS on the machine after this run succeeds");
  });

  it("takes back the blanket right an EARLIER adoption left — the machine stops granting it, and keeps the commands the manager needs", async () => {
    // THE PLANTED STATE: a machine adopted before this change, carrying the one line every adoption
    // used to write. `sudo -l` on it says every command, as every user, without a password — and
    // that is the standing route to root #19 is about.
    //
    // AND `machineSudo: "none"`, WHICH IS THE HARD HALF: the account holds no sudoers entry of its
    // own, so that blanket line is its whole way to root and the file this run installs is the
    // whole of what it holds afterwards. The operator's password buys `install` off the blanket and
    // nothing after it — a root command this run ships once the file is in place is answered by the
    // file or refused.
    const host: FakeHost = { commands: [], machineSudo: "none", dropIn: LEGACY_BLANKET_DROP_IN };
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, undefined, host), "digi1");
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    // The RIGHT is gone, measured the way the run measures it: the machine no longer lists a rule
    // saying every command. What replaced it still reaches root for the commands the manager runs,
    // which is why taking the blanket line away does not strand the machine.
    expect(host.dropIn).not.toMatch(BLANKET_LINE);
    expect(sudoersPermits(host.dropIn ?? null, "true")).toBe(true);
    expect(sudoersPermits(host.dropIn ?? null, "timedatectl set-ntp true")).toBe(true);
    expect(sudoersPermits(host.dropIn ?? null, "cat /etc/shadow")).toBe(false);
    expect(sudoersPermits(host.dropIn ?? null, "bash -c id")).toBe(false);
    expect(configureSudoCheckpoint(db, runId).data).toMatchObject({ sudoersWritten: true, blanketTakenBack: true });

    const meta = readEvents(db.db, runId).filter((e) => e.stream === "meta").map((e) => e.text).join("\n");
    expect(meta).toContain("An earlier adoption left");
  });

  /** What sudo is asked to AUTHORIZE in one command line this run shipped: sudo's own options come
   *  off the front, and the redirection and the pipeline the exit code is read through come off the
   *  back — none of those is the command a rule has to name. `null` where the line asks sudo about
   *  ITSELF (`sudo -l` lists the account's own rules and needs no rule of its own) and where the
   *  line elevates nothing at all. */
  function sudoAsks(command: string): string | null {
    const at = command.indexOf("sudo ");
    if (at < 0) return null;
    const asked = (command.slice(at + "sudo ".length)
      .replace(/^(?:-n |-S |-p '' |-- )+/, "")
      .split(" | ")[0] ?? "")
      .replace(/\s*\d?>\s*\/dev\/null/g, "")
      .trim();
    return asked === "" || asked.startsWith("-") ? null : asked;
  }

  it("runs no root command after the install that the file it installed does not permit", async () => {
    // THE MACHINE WHOSE ONLY WAY TO ROOT IS THE FILE THIS RUN REPLACES: an earlier adoption's
    // blanket line in this product's own drop-in, and `machineSudo: "none"` beside it. On this
    // machine "permitted by the installed file" and "able to run at all" are the same statement —
    // which is what makes the rule below measurable instead of argued, and it is the machine #19
    // exists to repair.
    //
    // A PASSWORD IS NOT A RIGHT. A `sudo -S` shipped after the install authenticates the account
    // and is then refused for any command no row of MANAGER_ELEVATED names, so a step that raises
    // one there fails ONE COMMAND SHORT of finishing — after `install` has already taken the
    // blanket away, and with the armed remove-sudoers then taking the drop-in too, which leaves the
    // account with no sudo at all and the machine worse than the run found it.
    //
    // HOW MUCH THIS COVERS: every command line the run shipped over the session after the install,
    // and no more. A command INSIDE an uploaded script — the tailnet probe's `sudo -n tailscale`,
    // the password-login helpers' `as_root` — is run by `bash` on the host and never reaches this
    // fake's exec, so those are held by the census above ("grants exactly the commands this
    // repository elevates") and not here.
    const host: FakeHost = { commands: [], machineSudo: "none", dropIn: LEGACY_BLANKET_DROP_IN };
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, undefined, host), "digi1");
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);
    // The step's own error FIRST, because it names the command sudo turned away — a bare status
    // assertion would go red saying only that something did.
    expect(stepColumn(db, runId, "configure-sudo", "error") ?? "").toBe("");
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    const shipped = host.commands ?? [];
    const installedAt = shipped.findIndex((c) => c.includes("install -m 0440"));
    expect(installedAt).toBeGreaterThan(-1);
    const elevated = shipped.slice(installedAt + 1).map(sudoAsks).filter((c): c is string => c !== null);
    // WHAT WAS ACTUALLY MEASURED, because a clean answer over an EMPTY set would mean nobody was
    // looking. On the green path these are three: `sudo -n true` twice — this step's own proof and
    // verify-key-login — and `sudo -n timedatectl set-ntp true` from enable-ntp. The floor is
    // asserted rather than the exact list, which a change of step order would break for no reason.
    expect(elevated.length).toBeGreaterThanOrEqual(3);
    expect(elevated).toContain("true");
    const file = sudoersDropIn("digi1");
    expect(elevated.filter((c) => !sudoersPermits(file, c))).toEqual([]);
  });

  it("writes NOTHING where the MACHINE'S OWN configuration grants every command — and arms no removal for a grant it did not make", async () => {
    // The cloud-image case: `ALL=(ALL) NOPASSWD:ALL` from a file this product did not write, which
    // it therefore cannot take back. Writing a drop-in beside it would add a grant that changes
    // nothing and that no successful run removes. This is the INNOCENT machine — it never carried
    // this product's grant, and the run must leave it exactly as it found it.
    const host: FakeHost = { commands: [], machineSudo: "nopasswd" };
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, undefined, host), "digi1");
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    expect(host.dropIn ?? null).toBeNull();
    expect(host.commands).not.toContainEqual(expect.stringContaining("install -m 0440 -o root -g root"));
    expect(host.commands).not.toContainEqual(expect.stringContaining("visudo -c"));
    expect(host.commands).not.toContainEqual(expect.stringContaining(`rm -f ${SUDOERS_DROP_IN}`));
    const checkpoint = configureSudoCheckpoint(db, runId);
    expect(checkpoint.data?.sudoersWritten).toBe(false);
    expect(checkpoint.__cleanups ?? []).not.toContain("remove-sudoers");
    expect(adoptDef.cleanups?.({ serverId }).map((c) => c.name)).toContain("remove-sudoers"); // still offered, simply not armed
  });

  it("stops the adoption rather than hand over a machine whose drop-in still grants everything", async () => {
    // The fail-closed half of the same proof. A drop-in that came back blanket — a rewrite that did
    // not take, a rule the parser read differently than this code meant it — is the exact state the
    // run exists to remove, so reporting the machine ready would be the software claiming an
    // outcome it did not reach.
    const host: FakeHost = { commands: [], machineSudo: "password", installLeavesBlanket: true };
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, undefined, host), "digi1");
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "configure-sudo")?.status).toBe("failed");
    expect(db.db.select().from(servers).where(eq(servers.id, serverId)).get()?.status).toBe("bare");
  });

  it("grants exactly the commands this repository elevates — no more, and none missing", () => {
    // The list is only as good as its agreement with the code, so the agreement is measured rather
    // than trusted. Every `sudo -n` and every `as_root` in the server tree is read back out of the
    // source and has to be a row of the table; a call site added without a row fails here, which is
    // what keeps the drop-in from falling behind the manager it exists for.
    const granted = new Set(MANAGER_ELEVATED.map((e) => e.cmd.slice(e.cmd.lastIndexOf("/") + 1)));
    const missing: string[] = [];
    for (const file of sourceFilesUnder(join(dirname(fileURLToPath(import.meta.url)), "..", ".."))) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/(?:sudo -n|as_root)\s+(\S+)/g)) {
        // The token as the shell would see it: the surrounding TypeScript — a closing quote, a
        // semicolon, the end of a template literal — is not part of the command.
        const token = m[1] ?? "";
        const name = token.includes("sshd_bin")
          ? "sshd" // as_root "$(sshd_bin)": the helper resolves it to /usr/sbin/sshd
          : token.replace(/^["'`]+/, "").replace(/["'`;)].*$/, "");
        if (name === "" || name.startsWith("-")) continue; // sudo's own options: `-n -l`
        if (name === "$@") continue;                       // the as_root helper's own body
        if (!granted.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
    // …and the table names a call site for every row, so a row nothing elevates any more is visible
    // as a row whose call site has gone.
    for (const e of MANAGER_ELEVATED) expect(e.at).not.toBe("");
    expect(sudoersDropIn("digi1")).not.toMatch(BLANKET_LINE);
  });

  it("asks the machine before writing, and asks it in a form whose EXIT CODE is the answer", async () => {
    const commands: string[] = [];
    const { executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, PROBE_NO_CLIENT, undefined, { commands, machineSudo: "password" }), "digi1");
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const asked = commands.find((c) => c.startsWith("LC_ALL=C sudo -n -l"));
    expect(asked).toBeDefined();
    // -n so a rule set that would PROMPT answers "not granted" instead of hanging; LC_ALL=C because
    // `sudo -l` prints in the machine's own language; the pattern is the blanket line and no other.
    expect(asked).toContain("grep -qE");
    expect(asked).toContain("NOPASSWD:[[:space:]]*ALL");
    expect(commands.indexOf(asked ?? "")).toBeLessThan(commands.findIndex((c) => c.includes("install -m 0440")));
  });

  it("the plan an operator approves names the standing grant and every use of the password — and neither on a root adoption", async () => {
    // Plan.warnings reaches no screen (server/executor/read.ts toRunView projects none, and RunView
    // has no such member), so the summary is the only record the approve card shows.
    const nonRoot = make(fakeFactory(), "digi1");
    const { plan } = await nonRoot.executor.plan("cluster-adopt", { serverId: nonRoot.serverId });
    expect(plan.summary).toContain(`${MANAGER_ELEVATED.length} NAMED commands`);
    expect(plan.summary).toContain("/etc/sudoers.d/90-hostyour");
    expect(plan.summary).toContain("LEAVES IT THERE");
    // What the grant is NOT, in the same breath: EVERY command whose arguments the file leaves open
    // still reaches root, and a summary saying only "named, not every" would sell the operator a
    // boundary this list does not draw. The names come off unpinnedElevated(), so a row added with
    // a `*` in it cannot be left out of what the approve card shows.
    expect(plan.summary).toContain("smaller grant and not a boundary");
    for (const name of unpinnedElevated().map(elevatedName)) expect(plan.summary).toContain(name);
    expect(plan.summary).toContain(SSHD_DROP_IN);
    expect(plan.summary).toContain("systemctl reload ssh");
    // The READ that the granted `install` and `cat` compose into, named where the operator decides.
    // Without this the card describes a write and the account can also read /etc/shadow, which is
    // the software telling the person something smaller than what it is about to do.
    expect(plan.summary).toContain("/etc/shadow");
    expect(plan.summary).toContain('"digi1 ALL=(ALL) NOPASSWD:ALL" has that line replaced by this run');
    expect(plan.summary).toContain("proves sudo in the preflight and installs an SSH key");
    // CONDITIONAL, because configure-sudo writes nothing where the machine already grants blanket
    // passwordless sudo (adopt.ts:260-263) — a summary asserting the install unconditionally would
    // tell the operator the password did something it did not.
    expect(plan.summary).toContain("Where this machine does not already grant passwordless sudo");

    const asRoot = make();
    const rootPlan = (await asRoot.executor.plan("cluster-adopt", { serverId: asRoot.serverId })).plan;
    expect(rootPlan.summary).toContain("The password you enter is used once to install an SSH key");
    expect(rootPlan.summary).not.toContain("NOPASSWD");
  });

});

// ---------------------------------------------------------------------------------------------
// The drop-in asked the question a MACHINE asks it: given this file, may "digi1" run this command
// as root without a password? sudo matches the CONCATENATED argument string, so a rule is only as
// narrow as what that string can be made to say — which is why the cases below are command lines
// and not rules. Two sets: the escalations an account holding the file would ship to get back what
// the file exists to take away, and the lines this repository's own scripts really ship.
// ---------------------------------------------------------------------------------------------
describe("the drop-in as a machine reads it", () => {
  const file = sudoersDropIn("digi1");

  /** The escalations, each the whole of a route to root and not a partial one. Every one of the
   *  first three was answered `true` by the real generated file before this change. */
  const REFUSED: [string, string][] = [
    ["writes a sudoers file of the account's own authorship: install's `-t DIR` makes DIR the target and every remaining operand a source, so a `*` that swallows it is NOPASSWD:ALL back in one command",
      `/usr/bin/install -m 0644 -o root -g root -t /etc/sudoers.d /tmp/evil ${SSHD_DROP_IN}`],
    ["reads a root-only file: grep's `-f FILE` takes its PATTERNS from FILE and prints what matches, so a `*` standing before the file operands is a read of /etc/shadow",
      "/usr/bin/grep -rniE -f /etc/shadow x /etc/ssh/sshd_config /etc/ssh/sshd_config.d"],
    ["reads a root-only file one answer at a time: `-q` returns an exit code and nothing else, and a `*` before the file operands lets the account name /etc/shadow beside the drop-in and ask about it a regex at a time",
      "/usr/bin/grep -qE . /etc/shadow /etc/sudoers.d/90-hostyour"],
    ["opens a root door of its own: a `tailscale` rule that names no arguments permits every subcommand, and `tailscale up --ssh` puts a login server on the machine that answers to the account's own tailnet identity",
      "/usr/bin/tailscale up --ssh"],
    ["the innocent case, refused before this change as well: a command no rule names at all",
      "/usr/bin/cat /etc/shadow"],
    ["the second innocent case: a shell",
      "/usr/bin/bash -c id"],
  ];

  /** The command lines this repository's scripts really ship, one per row of the table. Written out
   *  from the call sites rather than composed from MANAGER_ELEVATED, which would only prove the
   *  table matches itself. */
  const GENUINE: string[] = [
    "true",                                                             // adopt configure-sudo, verify-key-login
    "timedatectl set-ntp true",                                         // adopt enable-ntp
    `rm -f ${SUDOERS_DROP_IN}`,                                         // adopt removeSudoersCleanup
    "tailscale version",                                                // tailnet-probe TAILNET_PROBE_SCRIPT
    "tailscale status --json",                                          // tailnet-probe TAILNET_PROBE_SCRIPT
    "tailscale debug prefs",                                            // tailnet-probe TAILNET_PROBE_SCRIPT
    "snap remove --purge microk8s",                                     // deploy-slave.kit purgeMicrok8sStep
    "microk8s kubectl -n argocd get application x -o jsonpath={.status.sync.status}", // deploy-slave
    "/usr/sbin/sshd -T",                                                // password-login-probe effective()
    "/usr/sbin/sshd -t",                                                // password-login.kit APPLY
    "test -x /usr/sbin/sshd",                                           // password-login-probe sshd_bin()
    `test -e ${SSHD_DROP_IN}`,                                          // password-login.kit APPLY
    `cat ${SSHD_DROP_IN}`,                                              // password-login.kit APPLY
    `install -m 0644 -o root -g root -- /tmp/tmp.7Kq2Xf ${SSHD_DROP_IN}`, // password-login.kit APPLY, put_back
    `rm -f ${SSHD_DROP_IN}`,                                            // password-login.kit put_back
    "grep -rniH -e PasswordAuthentication -e KbdInteractiveAuthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d", // INVENTORY
    "systemctl reload ssh",                                             // password-login.kit RELOAD
    "systemctl reload sshd",                                            // password-login.kit RELOAD
    "systemctl is-active --quiet ssh.socket",                           // password-login.kit RELOAD
  ];

  /** The file with ONE rule in it, which is what tells "some rule permits this" from "THIS rule
   *  permits it" — a row nothing calls any more would otherwise hide behind its neighbours. */
  function fileWithOnly(e: ElevatedCommand): string {
    return `digi1 ALL=(root) NOPASSWD: ${e.args ? `${e.cmd} ${e.args}` : e.cmd}\n`;
  }

  it.each(REFUSED)("refuses the command that %s", (_why, command) => {
    expect(sudoersPermits(file, command)).toBe(false);
  });

  it.each(GENUINE)("still permits the call site: %s", (command) => {
    expect(sudoersPermits(file, command)).toBe(true);
  });

  it("has a call site for every rule, and a rule for every call site", () => {
    const unused = MANAGER_ELEVATED.filter((e) => !GENUINE.some((c) => sudoersPermits(fileWithOnly(e), c)));
    expect(unused.map((e) => `${e.cmd} ${e.args}`)).toEqual([]);
    expect(GENUINE.filter((c) => !sudoersPermits(file, c))).toEqual([]);
  });

  it("carries no fnmatch metacharacter this suite does not model", () => {
    // sudo compares arguments with fnmatch(3): `[`, `?` and `\` are metacharacters there as much as
    // `*` is, so `[[:space:]]` in a rule matches ONE whitespace character and not that literal text.
    // sudoersPermits models `*` alone, so a row carrying one of the others would be measured here as
    // a file no machine ever sees.
    for (const e of MANAGER_ELEVATED) expect(e.args).not.toMatch(/[[\]?\\]/);
  });

  it("says in the file itself, and in the plan the operator approves, which rules still reach root", () => {
    // THE COUNT COMES OFF THE TABLE. A row added with an open argument changes both records without
    // anybody rewriting a sentence, which is the only version of this that cannot go stale.
    const open = unpinnedElevated().map(elevatedName);
    expect(open).toEqual(["microk8s", "install"]);
    expect(file).toContain(`${open.length} of the rules below leave their arguments`);
    for (const name of open) expect(file).toContain(name);
  });

  // -------------------------------------------------------------------------------------------
  // THE PROBE PLANTED WITH THE SHAPE THAT WAS THERE. A refusal proves nothing unless the same
  // assertion goes red on the file this change replaced, so every rule this repository closed is put
  // back the way it was and every escalation above is expected to be permitted again.
  // -------------------------------------------------------------------------------------------
  /** One plant, and it must TAKE. A `replace` whose pattern has drifted leaves the file untouched,
   *  and every case below then measures TODAY'S rules while reading as a proof about yesterday's —
   *  a probe that passes by looking at the wrong thing. Loud at module load, because a plant that
   *  quietly did nothing is exactly what nobody notices. */
  function plant(text: string, from: string | RegExp, to: string): string {
    const out = text.replace(from, to);
    if (out === text) throw new Error(`the plant "${from}" matched nothing — the probe would measure today's rules`);
    return out;
  }

  // Each shape is the one that really stood in this file, restored one at a time. The last two are
  // rules this change removed outright rather than narrowed: the elevated `grep -qE *` that read
  // the drop-in an exit code at a time, and the bare `tailscale` that named no arguments.
  const OLD_SHAPES = [
    (f: string): string => plant(f, "-m 0644 -o root -g root -- *", "-m 0644 -o root -g root *"),
    (f: string): string => plant(f, "/usr/bin/grep -rniH -e PasswordAuthentication -e KbdInteractiveAuthentication", "/usr/bin/grep -rniE *"),
    (f: string): string => plant(f, "NOPASSWD: ", `NOPASSWD: /usr/bin/grep -qE * ${SUDOERS_DROP_IN}, `),
    // Every pinned tailscale rule back to the shape that named no arguments. Written to be
    // INDEPENDENT OF HOW MANY there are: a plant coupled to today's three would take this whole
    // file down at module load the day a reading is added or dropped, which is a probe that stops
    // measuring instead of an assertion that fails.
    (f: string): string => plant(f, /\/usr\/bin\/tailscale [^,\n\\]*/g, "/usr/bin/tailscale"),
  ].reduce((f, step) => step(f), file);

  it.each(REFUSED.slice(0, 4))("permitted, on the shape that was there, the command that %s", (_why, command) => {
    expect(sudoersPermits(OLD_SHAPES, command)).toBe(true);
  });

  it("refuses the innocent cases on the old shape too, so a red probe is the wildcard and not the plant", () => {
    for (const [, command] of REFUSED.slice(4)) expect(sudoersPermits(OLD_SHAPES, command)).toBe(false);
  });

  it("permits every tailscale reading the probe really takes and no other, the argument strings read OUT of the probe", () => {
    // The other half of the tailscale plant: closing `tailscale up --ssh` may not close the probe.
    //
    // THE STRINGS COME OFF THE CALL SITE, because the census cannot see this one. It reads BINARY
    // NAMES (`(?:sudo -n|as_root)\s+(\S+)`), and `tailscale` is granted — so a FOURTH reading added
    // to the probe passes it while the machine refuses the command, and `ts()`'s
    // `|| sudo -n tailscale "$@" 2>/dev/null` swallows that refusal into a fact the probe simply
    // does not report. A pinned rule is only as good as something deriving what it has to permit.
    const asks = [...TAILNET_PROBE_SCRIPT.matchAll(/\bts ([^)\n|$"]+)/g)].map((m) => (m[1] ?? "").trim());
    expect(asks).not.toEqual([]); // a derivation that found nothing would permit everything by asking nothing
    expect(asks.filter((args) => !sudoersPermits(file, `tailscale ${args}`))).toEqual([]);
    expect(sudoersPermits(file, "tailscale up --ssh")).toBe(false);
    expect(sudoersPermits(file, "tailscale status")).toBe(false);
  });

  it("permits the two things no rule can take away: the CONTENT of the sshd drop-in, and a read of any file through it", () => {
    // With `--` the account can no longer make install write anywhere else. This is what stays: it
    // chooses the bytes of the drop-in that sorts before every other sshd file, and
    // `systemctl reload ssh` is granted beside it, so `PermitRootLogin yes` is a root login away.
    // That is why "install" is named to the operator alongside microk8s.
    expect(sudoersPermits(file, `install -m 0644 -o root -g root -- /tmp/evil ${SSHD_DROP_IN}`)).toBe(true);
    expect(sudoersPermits(file, "systemctl reload ssh")).toBe(true);
    // AND THE READ THAT COMES WITH THE WRITE, asserted because it is the half the prose used to
    // leave out: install's SOURCE is the account's to name, the destination is mode 0644, and `cat`
    // of that destination is a row of its own. Pinning the source would not help — the account owns
    // that path and a symlink from it is followed as root. So it is disclosed instead, and the
    // summary test above asserts the operator is told.
    expect(sudoersPermits(file, `install -m 0644 -o root -g root -- /etc/shadow ${SSHD_DROP_IN}`)).toBe(true);
    expect(sudoersPermits(file, `cat ${SSHD_DROP_IN}`)).toBe(true);
  });
});
