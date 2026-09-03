// How a machine's recorded IDENTITY is worded on its card, and when the card offers the one act that
// replaces it. A pure module beside passwordLoginState.ts and tailnetState.ts, for the reason those
// are: vitest runs with environment "node" and includes no .tsx, so wording left inside the page
// cannot be tested — and wording is the whole substance here.
//
// The identity is TWO numbers: the sshd host key this manager pinned for the machine, and the
// /etc/machine-id it recorded beside it. Every session is refused unless the machine presents the
// pinned key, and the refusal comes during key exchange, before a credential is offered — so a
// machine that answers with a different one is reachable by nothing. A machine that presents the
// pinned key and reports a different /etc/machine-id opens the door and is refused one step later,
// by the attestation every mutating run takes.
//
// TWO THINGS PRODUCE EITHER REFUSAL AND NOTHING HERE CAN TELL THEM APART: the operator rebuilt the
// machine, or somebody else is answering at its address. So the card states what is pinned and
// offers a place to say which of the two it is, and the saying is a fingerprint read off the machine
// rather than a confirmation — a machine that does not present the stated key is refused again,
// which is what keeps the second case refused while the first proceeds.
//
// A REBUILD REPLACES BOTH NUMBERS AND ORDINARY ADMINISTRATION REPLACES ONE. Cloning a virtual
// machine or removing /etc/machine-id regenerates that number while the host keys stand, so the
// number a person reads off such a machine is the one already pinned — and stating it is how they
// say so. That statement forgets the recorded machine-id and moves no pin, which admits no machine
// the pin would not admit already: whoever answers the address still presents the pinned key or gets
// no session at all. It is the one half of the act this manager's OWN machine gets, because its pin
// comes from a deployment configuration read again on every boot and its machine-id comes from
// nowhere but this manager's own record.
//
// The card's own field is the act. No sentence below tells the operator to do anything, the same
// rule the readings beside it are written under.
import type { ServerView } from "../../shared/api-types.ts";
import { isMasterRole } from "../../shared/enums.ts";
import { readHostKeyFingerprint } from "../../shared/preflight.ts";

/** The command that prints the fingerprint, named wherever a person is asked for one so the value
 *  always comes off the machine rather than out of a run log. */
export const HOST_KEY_COMMAND = "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub";

export interface MachineIdentityBlock {
  /** What this manager has pinned, or null where it has recorded nothing yet. */
  pinned: string | null;
  /** One sentence under the card: which identity is recorded, and what it decides. */
  line: string;
  /** Whether the card offers the statement — that is, whether either number is there to be replaced.
   *  False on a row with nothing pinned, because a machine-id is only ever recorded over a session
   *  and opening one records the host key first, so such a row holds neither number. False on this
   *  manager's own machine while no machine-id is recorded for it: its pin comes from a deployment
   *  configuration read again on every boot (server/boot/seed-master.ts), so the machine-id is the
   *  only number a statement could move there. */
  offer: boolean;
}

/** The one place the recorded identity becomes words. Total over the three shapes a row can be in:
 *  the master, a machine nothing has reached, and a machine this manager has pinned. */
export function machineIdentityBlock(server: ServerView): MachineIdentityBlock {
  const pinned = server.hostKeyPinned;
  if (isMasterRole(server.role)) {
    return {
      pinned,
      line: pinned
        ? `Host key ${pinned} is pinned for this manager's own machine, from the deployment configuration that is read again on every boot` +
          (server.machineIdRecorded
            ? ", and an /etc/machine-id is recorded beside it, which every run that attests this machine holds it to."
            : ", and no /etc/machine-id is recorded beside it.")
        : "No host key is pinned for this manager's own machine, and it opens no session to itself until its deployment configuration states one.",
      offer: pinned !== null && server.machineIdRecorded,
    };
  }
  if (!pinned) {
    return {
      pinned,
      line: "No host key is recorded for this machine. The first run to reach it records the key it presents, and every later session is refused unless the machine presents that same key.",
      offer: false,
    };
  }
  return {
    pinned,
    line: `Host key ${pinned} is recorded for this machine, and every session is refused unless the machine presents it.` +
      (server.machineIdRecorded
        ? " An /etc/machine-id is recorded beside it, which every run that attests this machine holds it to."
        : ""),
    offer: true,
  };
}

/** What the form says above the field, in the words of the machine it is about. It names the whole
 *  effect of the number the person is about to state, and the effect differs by machine: on this
 *  manager's own machine only the recorded /etc/machine-id can be forgotten, and elsewhere a
 *  fingerprint that differs from the pin replaces it while one that matches says the sshd did not
 *  change and forgets the machine-id alone. */
export function machineIdentityStatement(server: ServerView, pinned: string): string {
  const read = `Read the fingerprint on ${server.name} itself, with \`${HOST_KEY_COMMAND}\`, and state it below.`;
  const answers = "Nothing here reaches the machine: it presents the key stated below, or the next run refuses it again and names both numbers.";
  if (isMasterRole(server.role)) {
    return (
      `${read} It has to be ${pinned}, which this manager's deployment configuration pins and this card cannot move, ` +
      `and stating it forgets the /etc/machine-id recorded beside it, so the next run records the rebuilt machine's own. ${answers}`
    );
  }
  const forgets = server.machineIdRecorded
    ? "and the /etc/machine-id recorded beside it is forgotten, so the next run records the rebuilt machine's own"
    : "and no /etc/machine-id is recorded beside it for the next run to disagree with";
  return (
    `${read} Where it differs from ${pinned} it is pinned in its place ${forgets}. ` +
    `Where it is ${pinned} itself, the machine's sshd did not change and the recorded /etc/machine-id is dropped alone. ${answers}`
  );
}

/** WHAT THE BUTTON THAT SENDS THE STATEMENT SAYS IT WILL DO, which is not one sentence: the same
 *  field performs two acts and the number decides which. A person about to press it has to read the
 *  act they are performing, and a label that named the pin on a statement that moves no pin would be
 *  the wrong one on this manager's own machine every time. */
export function machineIdentitySubmitLabel(typed: string, pinned: string): string {
  return readHostKeyFingerprint(typed) === pinned ? "Forget the recorded machine-id" : "Pin the stated host key";
}

/** WHY WHAT WAS TYPED CANNOT BE STATED, or null where it can. The same questions the inventory write
 *  asks (server/domains/inventory/machine-identity.ts), asked here so a person reads the answer under
 *  the field instead of as a red banner after a round trip. The write asks them again, because a
 *  browser is not a boundary. */
export function machineIdentityRefusal(typed: string, server: ServerView, pinned: string): string | null {
  const stated = readHostKeyFingerprint(typed);
  if (!stated) {
    return `A host key fingerprint is SHA256: followed by 43 characters — the field \`${HOST_KEY_COMMAND}\` prints between the key size and the comment.`;
  }
  if (stated !== pinned && isMasterRole(server.role)) {
    return (
      "This manager's own machine is pinned from its deployment configuration, which is read again on every boot, so a " +
      "number stated here would not survive one — state the new fingerprint there. What this card can still do is forget " +
      `the recorded /etc/machine-id, which is what stating ${pinned} does.`
    );
  }
  if (stated === pinned && !server.machineIdRecorded) {
    return "That is already the pinned key and no /etc/machine-id is recorded beside it, so neither number this manager holds is what refuses the connection — the run's own line names what does.";
  }
  return null;
}
