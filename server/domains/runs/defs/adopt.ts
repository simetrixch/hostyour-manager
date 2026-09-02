import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import type { StepCtx, Step, Cleanup, RunDefinition } from "../../../executor/types.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { generateServerKeypair } from "../../../adapters/ssh/keygen.ts";
import { AppError, errValidation, errNotFound, errMissingRunSecret } from "../../../kernel/errors.ts";
import { remoteCmd, remoteExec, remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import { PREFLIGHT_SCRIPT, parsePreflightOutput, makeCheck, formatNicsLine } from "../preflight.ts";
import { hasHardFailure, type PreflightReport } from "../../../../shared/preflight.ts";
import { recordTailnetReading } from "../tailnet-probe.ts";
import { recordAuthorizedKeysReading } from "../operator-keys-probe.ts";
import { disablePasswordLoginStep, purgeBootstrapPasswordStep, restorePasswordLoginCleanup, DROP_IN as SSHD_PASSWORD_DROP_IN } from "./password-login.kit.ts";
import { managerKeyMarker } from "../../../../shared/operator-keys.ts";

// "adopt a server" — the first real Run. Takes a BARE server to READY:
// connect with a one-time password, preflight, install a dedicated key, verify key-only
// login, discard the password, record a baseline, turn the daemon's password door off, destroy the
// stored password, mark ready. First-contact, so mutating: false: the attest-target law
// guards runs on already-attested targets, not the run that establishes identity.
//
// A server leaves this run reachable by KEY ONLY, and reachable by this manager alone: the
// daemon stops taking passwords (disable-password-login) and the bootstrap password sealed for
// one-click adopt is destroyed (purge-bootstrap-password). Both are needed — the first is a setting
// a reinstall or a cloud-init rewrite can reopen, the second is a working credential that outlives
// the machine's configuration. Password login is put back only by a deliberate
// password-login-enable run.
//
// A server adopted as a NON-ROOT account also leaves this run carrying /etc/sudoers.d/90-hostyour,
// and it carries it for as long as this manager administers the machine, because that file is what
// the manager's own `sudo -n` commands stand on afterwards — tailnet-probe.ts, the microk8s reset
// in deploy-slave.kit.ts, and the password-login run kinds, which declare `requiredSecrets: []`
// (password-login.kit.ts passwordLoginPlan) and so hold no password to raise themselves with. What
// the file grants is MANAGER_ELEVATED and nothing else: the commands listed below, each one a call
// site in this repository, and each with its arguments fixed. A machine that already runs every
// command as root without a password from its OWN configuration gets no file at all — there is
// nothing a second grant would add, and nothing this product could take back.

export const AdoptParams = z.object({
  serverId: z.string().startsWith("srv_"),
  // Optional intended cluster FQDN — enables the DNS-wildcard preflight now instead of at
  // provision time. Omitted ⇒ the wildcard check is skipped and the record is only verified later.
  intendedDomain: z.string().regex(/^[a-z0-9.-]+$/).optional(),
});
export type AdoptParams = z.infer<typeof AdoptParams>;

function loadServer(db: Db, id: string): typeof servers.$inferSelect {
  const row = db.select().from(servers).where(eq(servers.id, id)).get();
  if (!row) throw errNotFound(`server ${id} not found`);
  return row;
}

function hostKeyOf(row: typeof servers.$inferSelect): string | undefined {
  return (row.preflightJson as { hostKey?: string } | null)?.hostKey;
}

// Compensating actions. Registered at runtime by the steps that create the resource; the
// executor resolves the persisted __cleanups names against def.cleanups().
// Both run over the KEY session — they only exist after the key is installed, so ctx.ssh() works.
const removeKeyCleanup: Cleanup = {
  name: "remove-installed-key",
  title: "Remove the installed SSH key",
  run: async (ctx: StepCtx) => {
    const server = loadServer(ctx.db, String(ctx.params.serverId));
    const session = await ctx.ssh();
    // Deletes by the marker this run's own key carries and by nothing else. The operator-key run kinds
    // write a marker that starts `hostyour-operator:`, so neither pattern can reach the other's
    // line: this one is `hostyour` followed immediately by a colon.
    await remoteExec(ctx, session, `sed -i '\\#${managerKeyMarker(server.name)}#d' ~/.ssh/authorized_keys`);
  },
};

const removeSudoersCleanup: Cleanup = {
  name: "remove-sudoers",
  title: "Remove the passwordless-sudo drop-in",
  run: async (ctx: StepCtx) => {
    const session = await ctx.ssh();
    await remoteExec(ctx, session, `sudo -n rm -f ${SUDOERS_DROP_IN}`);
  },
};

/** The drop-in configure-sudo writes, and the only file remove-sudoers deletes. */
export const SUDOERS_DROP_IN = "/etc/sudoers.d/90-hostyour";

/** One command this manager runs as root over a machine's SSH session with NO password of its own.
 *  `cmd` is the absolute path sudo compares against — it resolves the command through `secure_path`
 *  and matches the result, so a bare name in a rule matches nothing. `args` is the argument string
 *  the rule fixes: the empty string where the call site composes arguments this rule cannot pin
 *  down, `""` where the command takes none. `at` names the call site the entry exists for. */
export interface ElevatedCommand {
  cmd: string;
  args: string;
  at: string;
}

/** THE WHOLE OF WHAT AN ADOPTED MACHINE GRANTS. Every `sudo -n` and every `as_root` in this
 *  repository is one of these rows, and adopt.sudo.test.ts reads them back out of the source to
 *  fail a change that adds a call site without adding it here — and, from the other side, a row
 *  here that no call site of this repository still needs.
 *
 *  THE LIST HAS ONE SOURCE AND IT IS THIS REPOSITORY. The deployment programs elevate through
 *  ansiwise's own route and never through this file: the installation declares
 *  `elevation: {password_from_caller: true}` and ansiwise raises an `elevated: true` row by running
 *  `sudo --stdin --reset-timestamp --prompt= --` with the password the caller sent beside the
 *  answers (ansiwise-core lib/src/infrastructure/real_shell.dart, RealShell.run). A row added to a
 *  program, or a step added to a plugin, therefore cannot fall out of step with this table —
 *  nothing on that side reads it.
 *
 *  A ROW EARNS ITS PLACE BY OUTLIVING THE ADOPTION. The file stays on the machine for good, so a
 *  command adoption alone runs has no business in it: adoption holds the operator's password while
 *  it works, and a command raised with that password needs no standing rule. What is left is what a
 *  run kind carrying NO password of its own must still reach — `verify-key-login`'s proof that the
 *  file works, the tailnet probe, the password-login run kinds — plus the cleanup that removes the
 *  file, which runs on an abort that may already have discarded the password.
 *
 *  READ THE OTHER WAY ROUND, THAT SENTENCE BINDS THE STEP AND NOT THE TABLE: from the moment
 *  configure-sudo installs this file, the account holds what this file grants and nothing else, so
 *  every root command the run issues after the install must be one of these rows — or one asked
 *  only while the machine still grants every command anyway. THE PASSWORD DOES NOT BUY PAST IT: a
 *  password authenticates the account, a sudoers rule authorizes the command, and the two are not
 *  the same thing. On a machine an earlier adoption left carrying `ALL=(ALL) NOPASSWD:ALL` in this
 *  product's own drop-in, whose account holds no sudoers entry of its own, that blanket is the
 *  whole of the account's way to root: the install takes it away, and a `sudo -S` issued after it
 *  for a command no row names fails on a right nothing on that machine grants — one command short
 *  of finishing, with the armed removal then taking the file too. adopt.sudo.test.ts drives that
 *  machine (`machineSudo: "none"` beside the legacy drop-in) and fails a run that tries it.
 *
 *  WHAT THIS IS NOT IS A CONTAINMENT BOUNDARY, and the operator is told so before approving.
 *  `unpinnedElevated()` reads the rows that leave their arguments open — a `*`, which sudo matches
 *  against the whole argument string and which therefore stands for any run of characters, or no
 *  argument string at all, which permits any arguments — and every one of them is a way to root.
 *  IT RETURNS NOTHING TODAY: every row below fixes its command AND its argument string. That is not
 *  the same as a boundary, and the paragraph below says what is left after it.
 *
 *  THE SSHD DROP-IN IS PINNED, AND WHAT REMAINS IS THE CONTENT ALONE. A write that is a
 *  copier — `install SRC DEST` with a `*` where SRC stands, because mktemp picks that name — is a
 *  copier that reads: the account owns whatever path the pattern allows and can point a symlink from it
 *  at /etc/shadow or a private key, which install follows as root into a destination of mode 0644
 *  that `cat` is granted on. No sudoers form permits that write and refuses that read. So the write
 *  names no source path at all (password-login.kit write_drop_in): `install /dev/null <drop-in>`
 *  creates or resets the file root-owned at 0644 and `tee <drop-in>` fills it from the script's own
 *  stdin, both pinned with no wildcard. The `cat` row that stays reads exactly one path, whose
 *  content this manager writes.
 *  What no rule can narrow is the CONTENT of that drop-in: it sorts before every other sshd file
 *  (password-login.kit DROP_IN) and `systemctl reload ssh` is granted beside it, so
 *  `PermitRootLogin yes` is a root login away. Writing that file with content this manager composes
 *  IS the call site, so it is DISCLOSED — in the summary the operator approves — rather than
 *  claimed to be contained.
 *
 *  What the list takes away is every OTHER command. THE CLUSTER ROW IS GONE — it read
 *  `/snap/bin/microk8s kubectl *`, and every call site that ran kubectl on a machine now raises it
 *  with the elevation password its run carries (executor/stepkit.ts `raised`), which is the route
 *  the three program steps of those same run kinds already take. A machine therefore needs no
 *  standing rule for the cluster at all, and a run that only READS one needs the approval — the
 *  price of having ONE route instead of two.
 *
 *  A ROW MAY NOT CARRY `[`, `?` OR `\`. sudo compares arguments with fnmatch(3), where those are
 *  metacharacters as much as `*` is — `[[:space:]]` in a rule matches ONE space, not that literal
 *  text. adopt.sudo.test.ts fails a row that carries one, because the suite's own matcher models
 *  `*` alone and would otherwise be measuring a file no machine sees. */
export const MANAGER_ELEVATED: ElevatedCommand[] = [
  { cmd: "/usr/bin/true", args: '""', at: "adopt verify-key-login, password-login.kit verifyKeyLoginStep" },
  { cmd: "/usr/bin/timedatectl", args: "set-ntp true", at: "adopt enable-ntp" },
  { cmd: "/usr/bin/rm", args: `-f ${SUDOERS_DROP_IN}`, at: "adopt removeSudoersCleanup" },
  // The tailnet probe's ts() helper falls back to sudo for a client whose socket only root can
  // reach, and it calls the client with three fixed argument strings and no others
  // (tailnet-probe.ts TAILNET_PROBE_SCRIPT). Each is its own rule, so `tailscale up --ssh` — which
  // would open a root door of the account's own — is refused where one unpinned rule permitted it.
  { cmd: "/usr/bin/tailscale", args: "version", at: "tailnet-probe TAILNET_PROBE_SCRIPT" },
  { cmd: "/usr/bin/tailscale", args: "status --json", at: "tailnet-probe TAILNET_PROBE_SCRIPT" },
  // `debug prefs` prints the client's whole preferences block as root, so whether it hands out the
  // node's PRIVATE key decides whether this row may stand. MEASURED against the client version an
  // installation ends up with, 1.98.10 (commit 0ee734d3089846b27bc6ebcddd3d6ee5ec13e04d), the
  // vendor's own release build run as uid 0: the output is 28 fields, and the one that would carry
  // key material is `Config` — Prefs.Persist, renamed in JSON. The daemon zeroes PrivateNodeKey,
  // OldPrivateNodeKey and NetworkLockKey and drops AttestationKey on a COPY before the local API
  // answers, so the field NAMES appear and the values do not (tailscale ipn/ipnlocal/local.go,
  // stripKeysFromPrefs, reached from LocalBackend.Prefs()). The other 27 fields are settings: the
  // control URL, the exit-node and route choices, the hostname, the netfilter mode.
  // It cannot be replaced by the row above it. `status --json` at this version carries 13 fields and
  // none of them is the control URL — measured, and ipn/ipnstate.go's Status struct has no such
  // field at this tag — while the coordinator address is what the probe reads this for.
  { cmd: "/usr/bin/tailscale", args: "debug prefs", at: "tailnet-probe TAILNET_PROBE_SCRIPT" },
  // The reset a deploy-slave abort runs, and the reason it is here rather than raised with the
  // run's password like every other cluster act: a cleanup runs on an abort that may already have
  // discarded that password (executor/executor.ts abortWithCleanup takes them again only where the
  // caller re-supplies them).
  { cmd: "/usr/bin/snap", args: "remove --purge microk8s", at: "deploy-slave.kit microk8sResetSlaveCleanup" },
  { cmd: "/usr/sbin/sshd", args: "-T", at: "password-login-probe SSHD_HELPERS effective()" },
  { cmd: "/usr/sbin/sshd", args: "-t", at: "password-login.kit APPLY" },
  { cmd: "/usr/bin/test", args: "-x /usr/sbin/sshd", at: "password-login-probe SSHD_HELPERS sshd_bin()" },
  { cmd: "/usr/bin/test", args: `-e ${SSHD_PASSWORD_DROP_IN}`, at: "password-login.kit APPLY" },
  { cmd: "/usr/bin/cat", args: SSHD_PASSWORD_DROP_IN, at: "password-login.kit APPLY" },
  { cmd: "/usr/bin/install", args: `-m 0644 -o root -g root /dev/null ${SSHD_PASSWORD_DROP_IN}`, at: "password-login.kit write_drop_in" },
  { cmd: "/usr/bin/tee", args: SSHD_PASSWORD_DROP_IN, at: "password-login.kit write_drop_in" },
  { cmd: "/usr/bin/rm", args: `-f ${SSHD_PASSWORD_DROP_IN}`, at: "password-login.kit put_back" },
  { cmd: "/usr/bin/grep", args: "-rniH -e PasswordAuthentication -e KbdInteractiveAuthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d", at: "password-login.kit INVENTORY" },
  { cmd: "/usr/bin/systemctl", args: "reload ssh", at: "password-login.kit RELOAD" },
  { cmd: "/usr/bin/systemctl", args: "reload sshd", at: "password-login.kit RELOAD" },
  { cmd: "/usr/bin/systemctl", args: "is-active --quiet ssh.socket", at: "password-login.kit RELOAD" },
];

/** The short name a rule is argued about by — the command as a reader of the file says it. */
export function elevatedName(e: ElevatedCommand): string {
  return e.cmd.slice(e.cmd.lastIndexOf("/") + 1);
}

/** The rows that leave their arguments OPEN, derived from the table rather than listed beside it.
 *  Two shapes qualify: a `*`, which sudo matches against the whole argument string and which
 *  therefore stands for any run of characters, and no argument string at all, which permits any
 *  arguments. Every such row is a command whose effect the account chooses, and the operator is
 *  told about each by name before approving. */
export function unpinnedElevated(): ElevatedCommand[] {
  return MANAGER_ELEVATED.filter((e) => e.args === "" || e.args.includes("*"));
}

/** HOW FAR THIS GRANT IS NOT A BOUNDARY, in one sentence read off the table — and the SAME sentence
 *  reaches both records: the header of the file on the machine, and the summary the operator
 *  approves. ONE sentence, because two would drift apart; READ rather than written, because a row
 *  added with a `*` in it, and equally the last such row leaving, has to change what both records
 *  say without anybody rewriting either of them. */
export function openArgumentsSentence(): string {
  const open = unpinnedElevated().map(elevatedName);
  return open.length > 0
    ? `${open.length} of the rules leave their arguments open (${open.join(", ")}), and an account holding them still reaches root.`
    : "Every rule fixes its command AND its arguments, so no rule lets the account decide what runs as root.";
}

/** The file, as it goes onto the machine. `(root)` and not `(ALL)`: every call site above runs as
 *  root and none as anybody else, so the runas half is narrowed with the command half. */
export function sudoersDropIn(sshUser: string): string {
  const specs = MANAGER_ELEVATED.map((e) => (e.args ? `${e.cmd} ${e.args}` : e.cmd));
  return [
    "# Written by hostyour when it adopted this machine.",
    "# Every command below is one the manager runs as root over its own SSH session with no password",
    "# to raise itself with. No OTHER command is granted.",
    `# This is a smaller grant and not a boundary. ${openArgumentsSentence()}`,
    `# It also writes ${SSHD_PASSWORD_DROP_IN}, which sorts before every other sshd file, and reloads the daemon — so it decides that file's content, and a root login is one line of it away.`,
    `${sshUser} ALL=(root) NOPASSWD: ${specs.join(", \\\n    ")}`,
    "",
  ].join("\n");
}

/** Asks the machine whether this account ALREADY runs every command as root without a password.
 *  The exit code is the whole answer, so nothing is parsed console-side: `sudo -l` lists the rules
 *  that apply to the account, `-n` refuses to prompt — a rule set that would ask for a password
 *  exits non-zero here, which is the answer "not granted" — and the pattern matches the one line
 *  that says every command, as every user, without a password. `LC_ALL=C` because `sudo -l` prints
 *  in the machine's own language.
 *
 *  This is the question about the RIGHT, not about any file, which is what makes it the proof
 *  configure-sudo takes after it has written: a right the machine no longer lists is a right the
 *  machine no longer grants, whichever file used to state it. */
export const SUDO_ALREADY_BLANKET =
  "LC_ALL=C sudo -n -l 2>/dev/null | " +
  "grep -qE '^[[:space:]]*\\(ALL([[:space:]]*:[[:space:]]*ALL)?\\)[[:space:]]+NOPASSWD:[[:space:]]*ALL[[:space:]]*$'";

/** And whether the answer above is THIS PRODUCT'S OWN DOING — the blanket line every adoption
 *  before this one left behind. The two questions are not the same question, and reading only the
 *  first is how the leftover cements itself: a re-adoption sees a machine that already grants
 *  everything, writes nothing, and leaves its predecessor's grant standing for good.
 *
 *  ASKED ONLY WHERE THE MACHINE ALREADY GRANTS EVERY COMMAND, which is what lets `sudo -n` reach
 *  root here with no rule for `cat` on the machine and no password. Both call sites stand behind
 *  SUDO_ALREADY_BLANKET, and while that answers yes this account runs any command as root without a
 *  password, `cat` included. Neither of the other two ways to raise it is available: a standing rule
 *  would be a right left on the machine for good in exchange for a question asked twice in one step,
 *  and the operator's password would rest on a right nothing here measures — the account's OWN
 *  sudoers entry, which the machine this question exists for need not have at all.
 *
 *  THE ORDER IS PART OF THE ANSWER. Asked where the machine grants nothing, a refusal and a clean
 *  file produce the same non-zero exit, and the step would read "not granted" off a command that
 *  never ran — a check that cannot go red.
 *
 *  ONLY `cat` IS ELEVATED, and the pattern is matched by a grep that runs as the login user. A
 *  `sudo grep -qE <pattern> <file>` would have to be permitted with a `*` where the pattern is, and
 *  sudo matches the whole argument string — so that `*` also accepts `. /etc/shadow`, and the exit
 *  code becomes an oracle for any root-only file on the machine. `cat` named against one fixed path
 *  carries no wildcard and reads nothing but the file this product wrote. The exit code is still
 *  the whole answer: an unreadable file feeds grep nothing and the pipeline exits non-zero, which
 *  is the answer "not granted". */
export const OUR_DROP_IN_GRANTS_BLANKET =
  `sudo -n cat ${SUDOERS_DROP_IN} 2>/dev/null | ` +
  `grep -qE '^[^#]*ALL[[:space:]]*=[[:space:]]*\\(ALL([[:space:]]*:[[:space:]]*ALL)?\\)[[:space:]]*NOPASSWD:[[:space:]]*ALL[[:space:]]*$'`;

// The baseline probe (step 7). BASE key value lines, parsed console-side.
export const BASELINE_SCRIPT = `#!/usr/bin/env bash
echo "BASE nproc $(nproc 2>/dev/null || echo 0)"
echo "BASE mem_bytes $(awk '/^MemTotal:/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)"
avail=$(df -B1 --output=avail / 2>/dev/null | tail -1 | tr -d ' ')
[ -z "$avail" ] && avail=0
echo "BASE disk_avail_bytes $avail"
ip -o -4 addr show 2>/dev/null | awk '{print "BASE ip_"$2" "$4}'
echo "BASE public_ip $(curl -4 -s --max-time 5 https://api.ipify.org 2>/dev/null || echo unknown)"
`;

function parseKeyValues(stdout: string, tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`^${tag} (\\S+) (.*)$`);
  for (const line of stdout.split("\n")) {
    const m = re.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].trim();
  }
  return out;
}

function requirePassword(ctx: StepCtx): Buffer {
  const pw = ctx.secrets.get("adopt-password");
  if (!pw) throw errMissingRunSecret("adopt-password");
  return pw;
}

function adoptSteps(params: AdoptParams): Step[] {
  const sid = params.serverId;
  return [
    {
      name: "connect-password",
      title: "Connect with the one-time password",
      run: async (ctx) => {
        const server = loadServer(ctx.db, sid);
        // The ADDRESS is not named here: openPasswordSession resolves it from the plan's target
        // (server/executor/transport.ts) and logs the one it actually dials. Naming server.host on
        // this line is wrong whenever the row carries a lanHost, which is where the session goes.
        ctx.log("meta", `Target: server "${server.name}", user ${server.sshUser} — connecting with the one-time password (redacted)`);
        // choreography: bare -> adopting on the first step (onTerminal resets on failure).
        localTx(ctx, (tx) => tx.update(servers).set({ status: "adopting" }).where(eq(servers.id, sid)).run());
        let session;
        try {
          session = await ctx.openPasswordSession(); // records host key TOFU onto the row
        } catch {
          throw errValidation("SSH login failed — check host, user, and password");
        }
        let who = "";
        const r = await session.exec("whoami", {
          signal: ctx.signal,
          onStdout: (l) => {
            who = l.trim();
            ctx.log("stdout", l);
          },
        });
        await remoteExec(ctx, session, "hostname; . /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"");
        if (r.code !== 0 || who !== server.sshUser) {
          throw errValidation("SSH login failed — check host, user, and password");
        }
        ctx.checkpoint({ hostKey: hostKeyOf(loadServer(ctx.db, sid)) ?? null });
      },
    },
    {
      name: "preflight",
      title: "Check the machine (preflight)",
      run: async (ctx) => {
        const server = loadServer(ctx.db, sid);
        const session = await ctx.openPasswordSession();
        const cap = await remoteScriptCapture(ctx, session, "preflight", PREFLIGHT_SCRIPT, { timeoutMs: 60_000 });
        const parsed = parsePreflightOutput(cap.stdout);
        ctx.log("meta", formatNicsLine(parsed));

        // sudo.ok needs the password on a non-root box (the drop-in doesn't exist yet).
        const sudoCheck =
          server.sshUser === "root"
            ? makeCheck("sudo.ok", "pass", "running as root")
            : await (async () => {
                const pw = requirePassword(ctx);
                const sr = await remoteExec(ctx, session, "sudo -S -p '' -- true", {
                  stdin: Buffer.concat([pw, Buffer.from("\n")]),
                });
                return makeCheck("sudo.ok", sr.code === 0 ? "pass" : "fail", sr.code === 0 ? "sudo available" : "user lacks sudo");
              })();

        const hostKey = hostKeyOf(server);
        const report: PreflightReport = {
          checkedAt: Date.now(),
          checks: [...parsed.checks, sudoCheck],
          ...(hostKey ? { hostKey } : {}),
        };
        localTx(ctx, (tx) => tx.update(servers).set({ preflightJson: report }).where(eq(servers.id, sid)).run());
        ctx.checkpoint({ publicIp: parsed.publicIp ?? null, checkCount: report.checks.length });

        if (hasHardFailure(report)) {
          const failed = report.checks.filter((c) => c.severity === "hard" && c.status === "fail");
          throw errValidation(
            `Preflight failed: ${failed.map((c) => `${c.title} — ${c.detail}${c.hint ? ` (${c.hint})` : ""}`).join("; ")}`,
          );
        }
      },
    },
    {
      name: "generate-key",
      title: "Generate a dedicated SSH key for this server",
      run: async (ctx) => {
        const server = loadServer(ctx.db, sid);
        // Idempotent: reuse an existing unrevoked key for this server (re-adopt).
        const existing = await ctx.creds.list({ serverId: sid, kind: "ssh_key" });
        const reuse = existing[existing.length - 1];
        if (reuse) {
          ctx.checkpoint({ credentialId: reuse.id, fingerprint: reuse.fingerprint, reused: true });
          ctx.log("meta", `Reusing existing SSH key ${reuse.fingerprint}`);
          return;
        }
        const key = generateServerKeypair(managerKeyMarker(server.name));
        const ref = await ctx.creds.seal({
          kind: "ssh_key",
          label: `SSH key for ${server.name}`,
          plaintext: key.privateOpenSsh,
          fingerprint: key.fingerprint,
          serverId: sid,
          publicKey: key.publicLine,
        });
        ctx.checkpoint({ credentialId: ref.id, fingerprint: key.fingerprint });
      },
    },
    {
      name: "install-key",
      title: "Install the key on the server",
      run: async (ctx) => {
        const creds = await ctx.creds.list({ serverId: sid, kind: "ssh_key" });
        const pub = creds[creds.length - 1]?.publicKey;
        if (!pub) throw new AppError("INTERNAL", "no generated public key to install");
        const session = await ctx.openPasswordSession();
        await remoteCmd(
          ctx,
          session,
          "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
        );
        await remoteCmd(ctx, session, `grep -qF '${pub}' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys`);
        ctx.registerCleanup(removeKeyCleanup);
      },
    },
    {
      name: "configure-sudo",
      title: "Grant the commands this manager runs as root",
      run: async (ctx) => {
        const server = loadServer(ctx.db, sid);
        if (server.sshUser === "root") {
          // kept in the step list (steps() is pure in params) but a no-op for root.
          ctx.log("meta", "User is root — passwordless sudo already available; nothing to configure.");
          return;
        }
        const session = await ctx.openPasswordSession();
        // TWO QUESTIONS, NOT ONE, and asking only the first is the defect this step exists to avoid.
        // A cloud image commonly grants the first account `ALL=(ALL) NOPASSWD:ALL` from its own
        // configuration, and a machine adopted before carries the blanket line an earlier adoption
        // wrote into our own drop-in. Both answer the first question the same way, and they are
        // opposite cases: the first is a grant this product did not make and cannot take back, the
        // second is one it made and must.
        const already = await remoteExec(ctx, session, SUDO_ALREADY_BLANKET);
        const ours = already.code === 0 ? (await remoteExec(ctx, session, OUR_DROP_IN_GRANTS_BLANKET)).code === 0 : false;
        if (already.code === 0 && !ours) {
          ctx.log("meta", `"${server.sshUser}" already runs every command as root without a password on this machine, from configuration this product did not write — nothing is written, and ${SUDOERS_DROP_IN} is left as this run found it. That grant is not this run's to take back.`);
          ctx.checkpoint({ sudoersWritten: false, blanketFrom: "the machine's own configuration" });
          return;
        }
        const pw = requirePassword(ctx);
        const pwLine = Buffer.concat([pw, Buffer.from("\n")]);
        const content = sudoersDropIn(server.sshUser);
        const tmp = `/tmp/dc-sudoers-${ctx.runId}`;
        ctx.log("meta", ours
          ? `An earlier adoption left "${server.sshUser} ALL=(ALL) NOPASSWD:ALL" in ${SUDOERS_DROP_IN}. This run replaces that file with the ${MANAGER_ELEVATED.length} commands this manager actually runs as root, and the blanket right goes with it.`
          : `Passwordless sudo for "${server.sshUser}": writing ${SUDOERS_DROP_IN} with the ${MANAGER_ELEVATED.length} commands this manager runs as root over its own session, and no others. It STAYS on the machine after this run succeeds — every later run reaches root through it. (Overwrites any existing drop-in of that name; your password is used only for sudo and never written to the file.)`);
        // Write the rules to a user-owned temp file FIRST, with NOTHING but the rules on
        // stdin. NEVER concatenate the sudo password with the file content: if the box
        // already grants passwordless sudo (common on cloud images), `sudo -S` does not
        // consume the password line, so a `tee` would write the PASSWORD into the sudoers
        // file — an invalid rule that fails visudo (the hostyour1 "expected host name" bug).
        await remoteCmd(ctx, session, `cat > ${tmp}`, { stdin: Buffer.from(content) });
        // VALIDATED BEFORE IT IS INSTALLED, and by the parser that will have to read it. A file
        // sudo cannot parse takes sudo down for every account on the machine, and the cleanup that
        // would remove it needs sudo — so a drop-in that only fails validation after it is in place
        // leaves a machine nothing here can repair. `-f` checks the named file and reads nothing
        // else, which is why it needs no elevation of its own.
        await remoteCmd(ctx, session, `/usr/sbin/visudo -cf ${tmp} >/dev/null`);
        // Register the teardown BEFORE the mutation it takes back, so a drop-in that is in place
        // when anything later fails is always removed (a failed install would otherwise leave the
        // file — and any leaked secret in it — on the box).
        ctx.registerCleanup(removeSudoersCleanup);
        try {
          // `install` sets owner/group/mode atomically and does NOT read stdin, so the
          // password (consumed by sudo only when it actually prompts, ignored otherwise)
          // can never reach the file.
          //
          // AND THIS IS THE LAST ROOT COMMAND THIS STEP RAISES WITH THE PASSWORD. It is also the
          // one that replaces the account's rights with MANAGER_ELEVATED, and on a machine whose
          // account holds no sudoers entry of its own — one an earlier adoption left blanket in
          // our own drop-in — the blanket it overwrites was the whole of the way to root the
          // password was riding on. A `sudo -S` issued after this line for a command no row names
          // authenticates and is then refused, so what runs from here on is what the file grants.
          await remoteCmd(ctx, session, `sudo -S -p '' install -m 0440 -o root -g root ${tmp} ${SUDOERS_DROP_IN}`, { stdin: pwLine });
        } finally {
          await remoteExec(ctx, session, `rm -f ${tmp}`);
        }
        // THE PROOF, and it is taken of the RIGHT the machine now lists rather than of the file
        // that was written. Both directions are failures the step must not survive: a drop-in that
        // still says every command means the run granted what it came to take away, and a drop-in
        // that grants nothing usable means the run has left a machine no later run can reach root
        // on.
        //
        // ASKED IN THE ORDER THAT NEEDS NO RIGHT FIRST, because every question from here on is
        // answered by the file just installed and by nothing else. `sudo -n -l` lists the account's
        // own rules and needs no rule of its own; while it says the machine no longer grants every
        // command, no file can be granting it and there is nothing left to read. Only where it
        // still says yes is the drop-in read, and at that moment the account runs any command as
        // root without a password, `cat` included. The other order asks a `cat` no rule permits and
        // reads "not granted" off a command that was refused.
        const blanketAfter = await remoteExec(ctx, session, SUDO_ALREADY_BLANKET);
        if (blanketAfter.code === 0) {
          if ((await remoteExec(ctx, session, OUR_DROP_IN_GRANTS_BLANKET)).code === 0) {
            throw errValidation(
              `${SUDOERS_DROP_IN} still grants "${server.sshUser}" every command as root after this run rewrote it — ` +
              `the blanket right was not taken back, so the adoption stops here rather than reporting a machine it did not hand over.`,
            );
          }
          ctx.log("meta", `"${server.sshUser}" still runs every command as root without a password on this machine, from configuration this product did not write — ${SUDOERS_DROP_IN} no longer grants it, and nothing here can take back what another file states.`);
        }
        // AND SUDO ITSELF IS THE PARSER WHOSE VERDICT THIS TAKES. A drop-in sudo cannot parse takes
        // sudo down for every account on the machine, so this line fails there too — which is why
        // the file is validated as a temp file BEFORE it is installed, where the diagnostic names
        // the offending line and nothing is yet in place to repair. `sudo -n true` is the first row
        // of the table and so the whole of what it can prove here: the rows for microk8s, tailscale
        // and sshd name binaries a bare machine does not have yet, and a rule for a path is not a
        // rule that has been exercised (#12).
        const usable = await remoteExec(ctx, session, "sudo -n true");
        if (usable.code !== 0) {
          throw errValidation(
            `${SUDOERS_DROP_IN} was installed but "${server.sshUser}" cannot run even the first of its commands as root without a password — ` +
            `either sudo will not read the file, or the rule it read does not grant what it says. ` +
            `Every later run on this machine reaches root that way, so the adoption stops here.`,
          );
        }
        ctx.checkpoint({ sudoersWritten: true, granted: MANAGER_ELEVATED.length, blanketTakenBack: ours, blanketElsewhere: blanketAfter.code === 0 });
      },
    },
    {
      name: "verify-key-login",
      title: "Verify key-only login",
      run: async (ctx) => {
        const session = await ctx.ssh(); // a fresh key-auth session (pins the recorded host key)
        await remoteCmd(ctx, session, "echo key-ok");
        await remoteCmd(ctx, session, "sudo -n true");
      },
    },
    {
      name: "enable-ntp",
      title: "Enable NTP time sync",
      run: async (ctx) => {
        // The preflight only WARNs on an unsynced clock; fix it here so the server
        // has correct time before anything TLS/cert/token-sensitive is provisioned
        // (clock skew breaks Let's Encrypt, JWT validation, and k8s cert rotation).
        // Best-effort over the key session's passwordless sudo: a box without
        // timedatectl (non-systemd) must not fail the adopt.
        const session = await ctx.ssh();
        const r = await remoteExec(ctx, session, "sudo -n timedatectl set-ntp true");
        ctx.log(
          "meta",
          r.code === 0
            ? "NTP time sync enabled."
            : "Could not enable NTP time sync (non-fatal) — run 'sudo timedatectl set-ntp true' on the box.",
        );
      },
    },
    {
      name: "discard-password",
      title: "Discard the one-time password",
      run: async (ctx) => {
        ctx.closePasswordSession();
        // The IN-MEMORY copy only. The one sealed for one-click adopt is destroyed by
        // purge-bootstrap-password at the end of the run, beside the step that shuts the daemon's
        // door: both are irreversible, and neither may happen while a step that can still fail
        // stands between them and a row this run would reset to `bare`.
        ctx.secrets.wipe("adopt-password");
        const creds = await ctx.creds.list({ serverId: sid, kind: "ssh_key" });
        const fp = creds[creds.length - 1]?.fingerprint ?? "";
        ctx.log("meta", `Key login verified — the one-time password is discarded. Key fingerprint: ${fp}`);
      },
    },
    {
      name: "baseline",
      title: "Record the machine baseline",
      run: async (ctx) => {
        const session = await ctx.ssh();
        const cap = await remoteScriptCapture(ctx, session, "baseline", BASELINE_SCRIPT, { timeoutMs: 30_000 });
        const baseline = parseKeyValues(cap.stdout, "BASE");
        const server = loadServer(ctx.db, sid);
        const pf = (server.preflightJson as Record<string, unknown> | null) ?? {};
        localTx(ctx, (tx) => tx.update(servers).set({ preflightJson: { ...pf, baseline } }).where(eq(servers.id, sid)).run());
        // The FIRST tailnet reading: a machine no hostyour-cloud code has run on yet, so it normally
        // has no client at all — the client arrives with the base install, and deploy-slave reads
        // the host again once it has joined. Recording it here is what gives a server that is not
        // deployed (and therefore carries no cluster row) a membership to show.
        const tailnetState = await recordTailnetReading(ctx, session, sid);
        // The FIRST authorized-keys reading, taken here because this is the first moment it is worth
        // anything: the manager's own key is on the box, so the reading can tell that line apart
        // from every other. Cloud images ship with the provisioning key of whoever ordered the
        // machine still in this file, and that key is a working way in that no run kind here can
        // remove — a server that finished adopting must not have to wait for someone to press a
        // button before that becomes visible.
        const authorizedKeys = await recordAuthorizedKeysReading(ctx, session, sid);
        ctx.checkpoint({ baseline, tailnetState, authorizedKeysState: authorizedKeys?.state ?? null });
      },
    },
    // The two irreversible steps, LAST and in this order, and never before verify-key-login: shutting
    // the password door is the change that can make a machine unreachable, so the door that stays
    // open is proven open first, and destroying the sealed password takes away the only other way in.
    //
    // Their PLACE at the end is what keeps a failed adoption recoverable. onTerminal resets the row
    // from `adopting` back to `bare`, and a `bare` row offers one-click adopt and refuses the
    // password-login run kinds — which is correct only while the machine is still as it was found. Every
    // step that can fail on the host now runs before these two, so a run that resets the row leaves
    // the daemon still taking the password the row still has.
    //
    // disable-password-login reads the daemon on both sides of the change and writes each reading to
    // the row, so the card shows what the adoption left behind. Its compensation
    // (restore-password-login) is registered by the step at runtime and, being registered LAST, runs
    // FIRST on an abort — password login is back before remove-sudoers takes away the sudo the
    // restore itself needs and before remove-installed-key takes away the key.
    disablePasswordLoginStep(sid),
    purgeBootstrapPasswordStep(sid),
    {
      name: "register",
      title: "Mark the server ready",
      run: async (ctx) => {
        const server = loadServer(ctx.db, sid);
        localTx(ctx, (tx) => tx.update(servers).set({ status: "ready", adoptedAt: new Date() }).where(eq(servers.id, sid)).run());
        ctx.log("meta", `Server ${server.name} is ready to be provisioned.`);
      },
    },
  ];
}

/** What the operator's password is spent on, which is not one thing on a machine adopted as a
 *  non-root account: the preflight proves sudo with it and configure-sudo installs the drop-in with
 *  it, where one is needed. As root neither happens — the preflight's sudo.ok passes on "running as
 *  root" and configure-sudo is a no-op — and the key is the only use left. */
function passwordUses(sshUser: string): string {
  return sshUser === "root"
    ? "The password you enter is used once to install an SSH key"
    : "The password you enter proves sudo in the preflight and installs an SSH key. Where this machine does not already grant passwordless sudo, it also installs the drop-in that grants it";
}

/** The standing right a non-root adoption leaves on the machine, in the ONE record the operator
 *  reads before approving. Plan.warnings is not that record: the executor's read path projects no
 *  `warnings` onto RunView (server/executor/read.ts toRunView) and RunView has no such member
 *  (shared/api-types.ts), so a warning string is frozen into plan_json and rendered on no screen;
 *  the summary is what the approve card shows (web/src/pages/RunDetail.tsx renders run.summary).
 *
 *  It says what the grant is NOT as plainly as what it is: `openArgumentsSentence()` names every
 *  command whose arguments the file leaves open, so a row added with one cannot be left out of what
 *  the operator is shown and the last such row leaving cannot leave the card claiming one is there.
 *  The sshd drop-in's CONTENT is spelled out AFTER that sentence and never inside it, because it is
 *  true whichever way the sentence reads — an operator told "every rule is pinned" would otherwise
 *  read a containment boundary into a grant that is not one. */
function sudoGrant(sshUser: string): string {
  if (sshUser === "root") return "";
  return (
    ` Unless "${sshUser}" already runs every command as root without a password from this machine's own ` +
    `configuration, this run writes ${SUDOERS_DROP_IN}, granting that account ${MANAGER_ELEVATED.length} NAMED commands ` +
    `as root without a password — the ones this manager runs over its own session — and LEAVES IT THERE: the ` +
    `password-login run kinds and the microk8s reset a failed slave install runs reach root on this machine that way ` +
    `and carry no password of their own. ${openArgumentsSentence()} ` +
    `Beyond that, the account can write ${SSHD_PASSWORD_DROP_IN} — beside the granted "systemctl reload ssh" — so it chooses the content of the sshd drop-in that sorts before every other, and "PermitRootLogin yes" is a root login away. ` +
    `The write takes no file name from that account, so it cannot copy a file of the machine's into a readable place; ` +
    `the content is the whole of what it decides. So this is a smaller grant and not a boundary. ` +
    `A machine an earlier adoption left carrying "${sshUser} ALL=(ALL) NOPASSWD:ALL" has that line replaced by this run.`
  );
}

export const adoptDef: RunDefinition<AdoptParams> = {
  kind: "cluster-adopt",
  paramsSchema: AdoptParams,
  mutating: false, // first-contact; the attest-target law is for known targets
  plan: async (params, { db }) => {
    const server = loadServer(db, params.serverId);
    const stepDefs = adoptSteps(params);
    const warnings: string[] = [];
    if (!params.intendedDomain) warnings.push("DNS wildcard check will be skipped — no domain chosen yet.");
    // The address the run will actually dial. adopt declares no targets of its own, so the executor
    // derives one and it carries no transport — which resolves to the LAN address when the row has
    // one, exactly as the session does.
    const dialled = resolveTransport(server, "default");
    return {
      kind: "cluster-adopt",
      targetKind: "server",
      targetId: params.serverId,
      summary:
        `Adopt server "${server.name}" (${dialled.host}:${server.sshPort}, user ${server.sshUser}): ` +
        `${stepDefs.length} steps, ~2 min. ${passwordUses(server.sshUser)}; it is never stored, ` +
        `and any copy kept for one-click adopt is destroyed. The server takes key logins only afterwards.` +
        sudoGrant(server.sshUser),
      steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
      warnings,
      requiredSecrets: ["adopt-password"],
    };
  },
  steps: (params) => adoptSteps(params),
  cleanups: () => [removeKeyCleanup, removeSudoersCleanup, restorePasswordLoginCleanup],
  onTerminal: (status, { db, params }) => {
    if (status === "succeeded") return; // the register step already set ready
    // Reset adopting -> bare (only if still adopting; never clobber a ready/other server).
    db.update(servers)
      .set({ status: "bare" })
      .where(and(eq(servers.id, String(params.serverId)), eq(servers.status, "adopting")))
      .run();
  },
};
