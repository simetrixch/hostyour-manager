import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../../executor/types.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { AuthFailedError, HostKeyMismatchError, type SshSession } from "../../../adapters/ssh/port.ts";
import { generateServerKeypair } from "../../../adapters/ssh/keygen.ts";
import { AppError, errValidation } from "../../../kernel/errors.ts";
import { execCapture, localTx, remoteCmd, remoteExec, remoteScriptCapture, requirePassword } from "../../../executor/stepkit.ts";
import { managerKeyMarker } from "../../../../shared/operator-keys.ts";
import { recordAuthorizedKeysReading } from "../operator-keys-probe.ts";
import { loadServer } from "./deploy-slave.kit.ts";

// FIRST CONTACT: the door this manager reaches a machine through, and the steps that make its own
// key the way in. Every one of them is written MEASURE-THEN-ACT, so the same list run twice against
// the same machine writes on the first pass and states in a full sentence what it found on the
// second. That is what lets a run that died half way be finished by running it again instead of by
// somebody undoing it first.
//
// THE ONE PLACE THE OPERATOR'S PASSWORD IS OFFERED TO A MACHINE. openDoor decides that, and it
// decides it from three facts that must never be confused: whether this manager holds a key for the
// machine, whether the machine took it, and whether the machine is the one whose host key is
// recorded on the row. The adapter is what keeps them apart — a refused credential arrives as
// AuthFailedError, a changed host key as HostKeyMismatchError, and a transport that reached no
// verdict at all as neither (adapters/ssh/port.ts).
//
// AND A COMPENSATION IS ARMED ONLY WHERE THIS RUN WROTE THE THING IT WOULD TAKE BACK. Measure-then-act
// decides the arming as well as the write, because the two are one decision: a step that read its
// work already done wrote nothing, and a compensation armed there would take away what an EARLIER
// run put on the machine. Two facts settle it and neither can stand for the other — the composing
// definition says whether an abort of this run may take the key line off at all, and the step's own
// measurement says whether there is a line of this run's to take off.

/** The drop-in that grants a machine account a standing set of passwordless-root commands, and the
 *  only file `remove-sudoers` deletes. Every root command in this kit is raised with the password the
 *  run carries, so nothing here rests on it. */
export const SUDOERS_DROP_IN = "/etc/sudoers.d/90-hostyour";

/** WHAT the first-contact steps act on. The server is the run's ownsHost target, so `ctx.ssh()` and
 *  `ctx.openPasswordSession()` with no server named both reach it. */
export interface FirstContactInput {
  serverId: string;
  /** The run secret holding the password of the machine account — the run kind that asks the
   *  operator for it is what knows its name. The same password raises every root command below, so a
   *  machine needs no standing rule for any of them. */
  secretName: string;
}

/**
 * THE DOOR. Which credential this manager offers a machine, decided once and read by every step that
 * needs a session before the key is proven.
 *
 * Three outcomes, and each of them is a different fact about the machine:
 *   - a credential stands and the machine takes it — the KEY door, which is every run after the
 *     first, and no password is offered at all;
 *   - no credential stands — first contact, and the machine account's password is the only way in;
 *   - a credential stands and the machine REFUSES it — a host that carries no line of this manager's,
 *     which is what a reinstall or a restored home directory leaves behind, so the password opens it
 *     and install-key puts the key back.
 *
 * A CHANGED HOST KEY IS NONE OF THE THREE and is refused with both fingerprints named. The machine
 * answering the address presented a key this manager did not record for it, so neither a key nor a
 * password may be offered to it, and the refusal has to say which two numbers disagree for a person
 * to have anything to judge. BOTH ARE EVIDENCE AND NEITHER IS AN INSTRUCTION: the number that ends
 * the refusal is read off the machine's own console, because a number copied out of a run log says
 * only what answered at the address, which is the thing in question
 * (domains/inventory/machine-identity.ts).
 *
 * EVERY OTHER FAILURE IS RE-THROWN UNCHANGED. A socket that never connected, a name that does not
 * resolve, a handshake that timed out: none of them says anything about which credentials the
 * machine takes, and falling back on one would offer the operator's password to a host whose key
 * door was never proven. That is what AuthFailedError exists to make possible — the fallback fires
 * on the machine's own refusal and on nothing else.
 */
export async function openDoor(ctx: StepCtx, secretName: string): Promise<SshSession> {
  const sid = String(ctx.params.serverId);
  const server = loadServer(ctx.db, sid);
  // excludeRotated, because this is the same question ctx.ssh() answers when it picks a key: a
  // rotated-out credential is one the machine has already stopped taking, and counting it would send
  // the door down the key path to be refused.
  const held = await ctx.creds.list({ serverId: sid, kind: "ssh_key", excludeRotated: true });
  if (held.length === 0) {
    ctx.log("meta", `This manager holds no key for ${server.name}, so the machine account's password opens the session.`);
    return ctx.openPasswordSession(secretName);
  }
  try {
    const session = await ctx.ssh();
    ctx.log("meta", `${server.name} takes this manager's own key, so no password is offered to it.`);
    return session;
  } catch (err) {
    if (err instanceof HostKeyMismatchError) {
      throw errValidation(
        `refusing every credential to ${server.name}: this manager has ${err.expected} pinned as the machine's host key and the machine at this address presented ${err.found}. ` +
        `Until the two agree nothing is offered to it — not the key, and not the password. ` +
        `A rebuilt machine presents a key this manager never recorded, and so does a different machine answering at the address; ` +
        `the two read the same here and only somebody at the machine can tell them apart. ` +
        `Read the fingerprint off ${server.name} itself and state it on this server's card under Servers, and the next run opens the door on it.`,
        { serverId: sid, expected: err.expected, got: err.found },
      );
    }
    if (!(err instanceof AuthFailedError)) throw err;
    // THE FALLBACK'S PRECONDITION, stated rather than assumed. A refusal only means "this machine
    // carries no line of ours" while the machine is known to be the right one. Where the row pins a
    // host key, ctx.ssh() put it into the connection and the refusal arrived AFTER key exchange had
    // accepted it, so the machine is proven by the time it says no. Where the row pins none, there
    // is nothing to contradict either, and the password session records what the machine presents.
    // The line says which of the two this is, because they are not equally strong.
    const pinned = (server.preflightJson as { hostKey?: string } | null)?.hostKey;
    ctx.log("meta", pinned
      ? `${server.name} presented the host key recorded for it and then refused this manager's key, so it carries no line of ours and the password opens the session again.`
      : `${server.name} refused this manager's key, and no host key is recorded for it to be measured against, so the password opens the session and the key it presents is recorded.`);
    return ctx.openPasswordSession(secretName);
  }
}

/**
 * Prove the machine account reaches root with the password this run carries, and prove it BEFORE
 * anything is written. Every deployment program raises its own commands with that same password, so
 * a password that does not reach root turns into a failure twenty minutes into an install; here it
 * costs one command.
 *
 * `/usr/bin/id -u` is the question and its answer is one character. The absolute path is what sudo
 * itself compares — it resolves a command through `secure_path` before matching — and no other call
 * site in this repository names that binary, so a machine that answers this answers it because the
 * account reaches root and not because some other rule happened to permit the command.
 *
 * THE STEP WRITES NOTHING ON EITHER PATH, which is why it can stand first.
 */
export function proveElevationStep(input: FirstContactInput): Step {
  return {
    name: "prove-elevation",
    title: "Prove the machine account reaches root",
    run: async (ctx) => {
      const server = loadServer(ctx.db, input.serverId);
      const session = await openDoor(ctx, input.secretName);
      const own = await execCapture(ctx, session, "id -u");
      if (own.code === 0 && own.out.trim() === "0") {
        ctx.log("meta", `The account this manager logs in to ${server.name} as is root itself, so there is nothing to raise and this step writes nothing.`);
        ctx.checkpoint({ loginIsRoot: true });
        return;
      }
      const raised = await execCapture(ctx, session, "-- /usr/bin/id -u", { elevation: requirePassword(ctx, input.secretName) });
      const uid = raised.out.trim();
      if (raised.code !== 0 || uid !== "0") {
        throw errValidation(
          `"${server.sshUser}" does not reach root on ${server.name} with the password this run carries: sudo answered exit ${raised.code}` +
          `${uid ? ` and uid ${uid}` : " and no uid at all"}. Every program this run drives raises its own commands with that password, so the run stops here rather than part way through an install.`,
        );
      }
      ctx.log("meta", `"${server.sshUser}" reaches root on ${server.name} with the password this run carries; the step measured it and wrote nothing.`);
      ctx.checkpoint({ loginIsRoot: false });
    },
  };
}

/**
 * Hold a dedicated key for this machine — one key per machine, never a key shared across machines.
 *
 * The measurement is a CREDENTIAL and not a status: an unrotated `ssh_key` for this server is
 * exactly what `ctx.ssh()` opens a session with, so a run that finds one has nothing to generate and
 * says so. A rotated-out credential does not count, for the same reason it does not count in the
 * door above.
 */
export function generateKeyStep(input: FirstContactInput): Step {
  return {
    name: "generate-key",
    title: "Hold a dedicated SSH key for this machine",
    run: async (ctx) => {
      const server = loadServer(ctx.db, input.serverId);
      const held = await ctx.creds.list({ serverId: input.serverId, kind: "ssh_key", excludeRotated: true });
      const reuse = held[held.length - 1];
      if (reuse) {
        ctx.log("meta", `This manager already holds an unrotated key for ${server.name} (${reuse.fingerprint}), which is the one every session to it authenticates with, so no key is generated.`);
        ctx.checkpoint({ credentialId: reuse.id, fingerprint: reuse.fingerprint, generated: false });
        return;
      }
      const key = generateServerKeypair(managerKeyMarker(server.name));
      const ref = await ctx.creds.seal({
        kind: "ssh_key",
        label: `SSH key for ${server.name}`,
        plaintext: key.privateOpenSsh,
        fingerprint: key.fingerprint,
        serverId: input.serverId,
        publicKey: key.publicLine,
      });
      ctx.log("meta", `Generated a key for ${server.name} alone: ${key.fingerprint}.`);
      ctx.checkpoint({ credentialId: ref.id, fingerprint: key.fingerprint, generated: true });
    },
  };
}

/**
 * Put that key into the machine account's `~/.ssh/authorized_keys`, and then read the whole file
 * back.
 *
 * TWO MEASUREMENTS, EACH DECIDING ONE WRITE. Whether the file exists at all decides the directory
 * and the file being created with the modes sshd insists on; whether the key line already stands in
 * it decides the append. A host that already carries the line is left byte for byte as it was found,
 * its modes included — they are the machine's and this step has no reading that says they are wrong.
 *
 * THE READING IS TAKEN HERE because this is the first moment it is worth anything: this manager's
 * own key is on the host, so the reading can tell that line from every other. A cloud image ships
 * with the provisioning key of whoever ordered the machine still in this file, and that key is a
 * working way in no run kind here can remove — a machine must not have to wait for somebody to press
 * a button before that is visible.
 *
 * NOTHING UNDOES THIS STEP, on any run kind that composes it. The key line is what every session
 * after it is opened with — ctx.ssh() authenticates with the sealed ssh_key credential and with
 * nothing else — and the same lists shut the daemon's password door and destroy the sealed bootstrap
 * password. So a compensation that took the line off again would leave a machine nothing can reach,
 * on exactly the run that failed and most needs to be reached. What an aborted install leaves behind
 * is a machine reachable by this manager and by nobody else, which is the state its retry and every
 * later run kind need anyway.
 */
export function installKeyStep(input: FirstContactInput): Step {
  return {
    name: "install-key",
    title: "Install this manager's key on the machine",
    run: async (ctx) => {
      const server = loadServer(ctx.db, input.serverId);
      const held = await ctx.creds.list({ serverId: input.serverId, kind: "ssh_key", excludeRotated: true });
      const pub = held[held.length - 1]?.publicKey;
      if (!pub) throw new AppError("INTERNAL", `no unrotated ssh_key credential for ${server.name} to install — generate-key runs before this step`);
      const session = await openDoor(ctx, input.secretName);
      const file = await remoteExec(ctx, session, "test -f ~/.ssh/authorized_keys");
      if (file.code === 0) {
        ctx.log("meta", `${server.name} already keeps a ~/.ssh/authorized_keys, so its modes are left as the machine has them.`);
      } else {
        await remoteCmd(ctx, session, "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys");
        ctx.log("meta", `${server.name} kept no ~/.ssh/authorized_keys, so the directory and the file are created with the modes sshd requires.`);
      }
      const present = await remoteExec(ctx, session, `grep -qF '${pub}' ~/.ssh/authorized_keys`);
      if (present.code === 0) {
        ctx.log("meta", `The key this manager holds for ${server.name} already stands in ~/.ssh/authorized_keys, so nothing is appended.`);
      } else {
        await remoteCmd(ctx, session, `echo '${pub}' >> ~/.ssh/authorized_keys`);
        ctx.log("meta", `Appended this manager's key to ~/.ssh/authorized_keys on ${server.name}.`);
      }
      const reading = await recordAuthorizedKeysReading(ctx, session, input.serverId);
      ctx.checkpoint({ appended: present.code !== 0, authorizedKeysState: reading?.state ?? null });
    },
  };
}

/**
 * Prove the key door is open, over a session that could have been opened no other way. `ctx.ssh()`
 * authenticates with the sealed `ssh_key` credential and with nothing else, so reaching one command
 * over it IS the proof — there is no assertion to make about the answer beyond its exit code.
 *
 * IT IS ALSO WHAT STAMPS THE ROW, and the stamp is written by the step that took the measurement
 * rather than by one further down the list: the column carries the moment this manager last proved
 * it can log in to the machine with its own key, which is a reading and not a state somebody chose.
 */
export function verifyKeyLoginStep(input: FirstContactInput): Step {
  return {
    name: "verify-key-login",
    title: "Verify key-only login",
    run: async (ctx) => {
      const server = loadServer(ctx.db, input.serverId);
      const session = await ctx.ssh();
      await remoteCmd(ctx, session, "echo key-ok");
      const at = new Date();
      localTx(ctx, (tx) => tx.update(servers).set({ adoptedAt: at }).where(eq(servers.id, input.serverId)).run());
      ctx.log("meta", `${server.name} answers a login that offers this manager's key and no password.`);
      ctx.checkpoint({ keyVerifiedAt: at.getTime() });
    },
  };
}

/**
 * Have the machine keep its clock synchronised, because everything provisioned after this is
 * time-sensitive: a certificate authority refuses a request from a host whose clock has drifted, a
 * token is rejected outside its window, and a cluster rotates its own certificates on a schedule.
 *
 * MEASURED FIRST, and the measurement needs no root — `timedatectl show` reads what the daemon
 * resolved and any account may ask. Only the change is raised, and it is raised with the password
 * this run carries rather than with a standing rule.
 *
 * A machine without `timedatectl` is a machine this step cannot measure, and it is reported as
 * exactly that rather than as a clock that is fine or a step that failed: the deployment does not
 * stand on it, and an unmeasured clock is not a broken one.
 *
 * THE STEP TURNS THE SETTING ON; IT DOES NOT JUDGE THE CLOCK. What it reads is `NTP`, which says
 * whether the machine is meant to synchronise, and a machine that has no time service installed
 * refuses to turn it on for a reason the installation itself may remove. Whether the clock is
 * ACTUALLY right is a different reading — `NTPSynchronized`, which the preflight takes and grades —
 * so a refusal here is said plainly and left to that grading rather than failing a run on a
 * measurement this step never took.
 */
export function enableNtpStep(input: FirstContactInput): Step {
  return {
    name: "enable-ntp",
    title: "Keep the machine's clock synchronised",
    run: async (ctx) => {
      const server = loadServer(ctx.db, input.serverId);
      const session = await openDoor(ctx, input.secretName);
      const measured = await execCapture(ctx, session, "timedatectl show -p NTP --value");
      if (measured.code !== 0) {
        ctx.log("meta", `${server.name} answers no timedatectl, so whether it synchronises its clock cannot be measured here and nothing is written. Its clock is the machine's own business.`);
        ctx.checkpoint({ ntp: "unmeasured" });
        return;
      }
      if (measured.out.trim() === "yes") {
        ctx.log("meta", `${server.name} already synchronises its clock, so nothing is written.`);
        ctx.checkpoint({ ntp: "already-on" });
        return;
      }
      const r = await remoteExec(ctx, session, "timedatectl set-ntp true", { elevation: requirePassword(ctx, input.secretName) });
      if (r.code !== 0) {
        ctx.log("meta", `${server.name} is not set to synchronise its clock and timedatectl refused to turn it on (exit ${r.code}), so the setting is left as the machine has it; the preflight reads whether the clock is actually in step and grades that.`);
        ctx.checkpoint({ ntp: "refused" });
        return;
      }
      ctx.log("meta", `${server.name} was not set to synchronise its clock and now is.`);
      ctx.checkpoint({ ntp: "turned-on" });
    },
  };
}

/** Raised WHOLE, because one `sudo -S` consumes the password and every later one inside the same
 *  send reads an input already at end of file (executor/stepkit.ts). It measures, removes, and
 *  measures again, and every path prints one line the console reads its answer off — a file that
 *  survives its own removal is a failure and must not be reported as a clean machine. */
export function removeSudoersScript(path: string): string {
  return `#!/usr/bin/env bash
if [ ! -e "${path}" ]; then echo "SUDOERS absent"; exit 0; fi
rm -f "${path}"
if [ -e "${path}" ]; then echo "SUDOERS stands"; exit 1; fi
echo "SUDOERS removed"
`;
}

/**
 * Take the standing passwordless-root grant off the machine.
 *
 * WHY IT CAN GO, and the CONDITION on any list this step is put in: every root command in this kit
 * is raised with the password the run carries, so nothing here rests on the file — and a run kind
 * that composes this step must hold that password for every root command IT sends too, or the step
 * takes away the rule the rest of that run stands on. The condition is met across the whole server
 * tree, and held there by a source census rather than by reading (domains/runs/elevation.test.ts).
 *
 * SO NOTHING HERE WRITES THE FILE, and this step is the only code that names it: what it takes off a
 * machine is what an OLDER build of this manager left standing. A file granting rights nobody uses
 * is a right left behind on somebody's machine, which is why removing it is a step of the deployment
 * and not a note in a release.
 *
 * THE MEASUREMENT IS RAISED TOO, and that is not a detail. `/etc/sudoers.d` is readable by root
 * alone, so a `test -e` run as the login account fails on a machine that carries the file and on one
 * that does not, and a step reading its answer would report "nothing to remove" off a command that
 * was refused. Root asks the question, and the answer arrives as a word rather than as an exit code.
 */
export function removeSudoersStep(input: FirstContactInput): Step {
  return {
    name: "remove-sudoers",
    title: "Remove the standing passwordless-root grant",
    run: async (ctx) => {
      const server = loadServer(ctx.db, input.serverId);
      const session = await openDoor(ctx, input.secretName);
      const cap = await remoteScriptCapture(ctx, session, "remove-sudoers", removeSudoersScript(SUDOERS_DROP_IN), {
        elevation: requirePassword(ctx, input.secretName),
      });
      const verdict = /^SUDOERS (\S+)$/m.exec(cap.stdout)?.[1];
      if (verdict === "absent") {
        ctx.log("meta", `${server.name} carries no ${SUDOERS_DROP_IN}, so there is nothing to take back and nothing was written.`);
        ctx.checkpoint({ sudoersDropIn: "absent" });
        return;
      }
      if (verdict === "removed") {
        ctx.log("meta", `${SUDOERS_DROP_IN} is gone from ${server.name}, which now grants this manager no standing right; every root command these steps send is raised with the password this run carries.`);
        ctx.checkpoint({ sudoersDropIn: "removed" });
        return;
      }
      throw errValidation(
        `${SUDOERS_DROP_IN} could not be taken off ${server.name} (exit ${cap.result.code}${verdict ? `, "${verdict}"` : ", no verdict"}) — ` +
        `the machine would keep a standing passwordless-root grant that nothing here writes and no command of this run reaches root through.`,
      );
    },
  };
}
