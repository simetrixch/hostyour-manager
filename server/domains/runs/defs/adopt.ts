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
import { disablePasswordLoginStep, purgeBootstrapPasswordStep, restorePasswordLoginCleanup } from "./password-login.kit.ts";
import { controllerKeyMarker } from "../../../../shared/operator-keys.ts";

// "adopt a server" — the first real Run. Takes a BARE server to READY:
// connect with a one-time password, preflight, install a dedicated key, verify key-only
// login, discard the password, record a baseline, turn the daemon's password door off, destroy the
// stored password, mark ready. First-contact, so mutating: false: the attest-target law
// guards runs on already-attested targets, not the run that establishes identity.
//
// A server leaves this run reachable by KEY ONLY, and reachable by this controller alone: the
// daemon stops taking passwords (disable-password-login) and the bootstrap password sealed for
// one-click adopt is destroyed (purge-bootstrap-password). Both are needed — the first is a setting
// a reinstall or a cloud-init rewrite can reopen, the second is a working credential that outlives
// the machine's configuration. Password login is put back only by a deliberate
// password-login-enable run.

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
    await remoteExec(ctx, session, `sed -i '\\#${controllerKeyMarker(server.name)}#d' ~/.ssh/authorized_keys`);
  },
};

const removeSudoersCleanup: Cleanup = {
  name: "remove-sudoers",
  title: "Remove the passwordless-sudo drop-in",
  run: async (ctx: StepCtx) => {
    const session = await ctx.ssh();
    await remoteExec(ctx, session, "sudo -n rm -f /etc/sudoers.d/90-hostyour");
  },
};

// The baseline probe (step 7). BASE key value lines, parsed console-side.
const BASELINE_SCRIPT = `#!/usr/bin/env bash
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
        // (server/executor/transport.ts) and logs the one it actually dials. This line used to name
        // server.host while the session went to lanHost whenever the row carried one.
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
        const key = generateServerKeypair(controllerKeyMarker(server.name));
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
      title: "Enable passwordless sudo for the console",
      run: async (ctx) => {
        const server = loadServer(ctx.db, sid);
        if (server.sshUser === "root") {
          // kept in the step list (steps() is pure in params) but a no-op for root.
          ctx.log("meta", "User is root — passwordless sudo already available; nothing to configure.");
          return;
        }
        const session = await ctx.openPasswordSession();
        const pw = requirePassword(ctx);
        const pwLine = Buffer.concat([pw, Buffer.from("\n")]);
        const sudoersLine = `${server.sshUser} ALL=(ALL) NOPASSWD:ALL\n`;
        const tmp = `/tmp/dc-sudoers-${ctx.runId}`;
        ctx.log("meta", `Passwordless sudo for "${server.sshUser}": writing /etc/sudoers.d/90-hostyour = ${sudoersLine.trim()} (overwrites any existing drop-in; your password is used only for sudo and never written to the file)`);
        // Write the rule to a user-owned temp file FIRST, with NOTHING but the rule on
        // stdin. NEVER concatenate the sudo password with the file content: if the box
        // already grants passwordless sudo (common on cloud images), `sudo -S` does not
        // consume the password line, so a `tee` would write the PASSWORD into the sudoers
        // file — an invalid rule that fails visudo (the hostyour1 "expected host name" bug).
        await remoteCmd(ctx, session, `cat > ${tmp}`, { stdin: Buffer.from(sudoersLine) });
        // Register the teardown BEFORE the fallible visudo check so a bad drop-in is
        // always cleaned up (previously a failed visudo left the file — and any leaked
        // secret in it — on the box).
        ctx.registerCleanup(removeSudoersCleanup);
        try {
          // `install` sets owner/group/mode atomically and does NOT read stdin, so the
          // password (consumed by sudo only when it actually prompts, ignored otherwise)
          // can never reach the file.
          await remoteCmd(ctx, session, `sudo -S -p '' install -m 0440 -o root -g root ${tmp} /etc/sudoers.d/90-hostyour`, { stdin: pwLine });
          await remoteCmd(ctx, session, "sudo -n visudo -c >/dev/null");
        } finally {
          await remoteExec(ctx, session, `rm -f ${tmp}`);
        }
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
        // anything: the controller's own key is on the box, so the reading can tell that line apart
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

export const adoptDef: RunDefinition<AdoptParams> = {
  kind: "adopt",
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
      kind: "adopt",
      targetKind: "server",
      targetId: params.serverId,
      summary:
        `Adopt server "${server.name}" (${dialled.host}:${server.sshPort}, user ${server.sshUser}): ` +
        `${stepDefs.length} steps, ~2 min. The password you enter is used once to install an SSH key; it is never stored, ` +
        `and any copy kept for one-click adopt is destroyed. The server takes key logins only afterwards.`,
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
