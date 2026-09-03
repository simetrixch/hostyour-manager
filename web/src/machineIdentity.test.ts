import { describe, it, expect } from "vitest";
import type { ServerView } from "../../shared/api-types.ts";
import { machineIdentityBlock, machineIdentityRefusal, machineIdentityStatement, machineIdentitySubmitLabel } from "./machineIdentity.ts";

// The card is where a person finds out which machine this manager holds a row to, and it is the one
// place they can say that machine was rebuilt. Both are wording, so both are measured here.
//
// The rule the whole block is written under: the act is offered as a FIELD, never as a
// confirmation. A manager cannot tell a rebuilt machine from another one answering at its address,
// so what moves the pin has to be a number read off the machine — and the sentences have to say
// that the machine still gets to disagree.

const PINNED = `SHA256:${"aB9+/".repeat(9).slice(0, 43)}`;
const PRESENTED = `SHA256:${"Zy8-".replace("-", "/").repeat(11).slice(0, 43)}`;

function server(over: Partial<ServerView> = {}): ServerView {
  return {
    id: "srv_1", name: "s1", host: "203.0.113.7", lanHost: null, tailnetHost: null, sshPort: 22, sshUser: "root",
    role: "slave", status: "ready", cluster: null, tailnetState: "unknown", tailnet: { kind: "none" },
    passwordLoginState: "unknown", passwordLogin: { kind: "none" },
    authorizedKeysState: "unknown", authorizedKeys: { kind: "none" },
    hostKeyPinned: PINNED, machineIdRecorded: true, createdAt: 0, adoptedAt: null, hasPassword: false, hasKey: true,
    ...over,
  };
}

describe("machineIdentityBlock — what the card says this manager holds the machine to", () => {
  it("names the pinned key and what it decides, and offers the statement", () => {
    const block = machineIdentityBlock(server());
    expect(block.pinned).toBe(PINNED);
    expect(block.line).toContain(PINNED);
    expect(block.line).toMatch(/refused unless the machine presents it/);
    expect(block.offer).toBe(true);
  });

  it("offers nothing on a machine with nothing pinned, and says what the first run does instead", () => {
    const block = machineIdentityBlock(server({ hostKeyPinned: null }));
    expect(block.offer).toBe(false);
    expect(block.line).toMatch(/first run to reach it records the key it presents/);
  });

  it("offers the master the one number a statement can move there: the recorded machine-id", () => {
    // A fingerprint stated on the card would not survive a boot — seed-master reads the configured
    // value again every time — but the machine-id is recorded by this manager alone and configured
    // nowhere, so the card is the only route back for a control host that was re-imaged. Both master
    // roles answer the same, because both carry the master part.
    for (const role of ["master", "master+slave"] as const) {
      const block = machineIdentityBlock(server({ role }));
      expect(block.offer).toBe(true);
      expect(block.line).toMatch(/deployment configuration/);
      expect(block.line).toMatch(/machine-id is recorded beside it/);
    }
    // With no machine-id recorded there is nothing left for a statement to move, so nothing is offered.
    expect(machineIdentityBlock(server({ role: "master", machineIdRecorded: false })).offer).toBe(false);
    expect(machineIdentityBlock(server({ role: "master", hostKeyPinned: null })).line)
      .toMatch(/opens no session to itself/);
    expect(machineIdentityBlock(server({ role: "master", hostKeyPinned: null })).offer).toBe(false);
  });

  it("says whether a machine-id is recorded, because that is the number the pin cannot refuse", () => {
    // A machine presenting the pinned key and reporting a different /etc/machine-id opens the door
    // and is refused one step later, so the card has to name the second number too.
    expect(machineIdentityBlock(server()).line).toMatch(/machine-id is recorded beside it/);
    expect(machineIdentityBlock(server({ machineIdRecorded: false })).line).not.toMatch(/machine-id/);
  });
});

describe("machineIdentityStatement — what a person is told before they state a number", () => {
  it("names the machine, the command that prints the number, and everything the statement does", () => {
    const text = machineIdentityStatement(server(), PINNED);
    expect(text).toContain("s1");
    expect(text).toContain("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
    expect(text).toContain(PINNED);
    // The machine-id goes with the host key, and a person about to state one has to know that.
    expect(text).toMatch(/machine-id/);
    // And the statement is not a promise that anything will work: the machine still has to match it.
    expect(text).toMatch(/Nothing here reaches the machine/);
  });
});

describe("machineIdentityRefusal — the answers the write gives, given under the field", () => {
  it("passes a fingerprint the machine could present", () => {
    expect(machineIdentityRefusal(PRESENTED, server(), PINNED)).toBeNull();
    expect(machineIdentityRefusal(`  ${PRESENTED}\n`, server(), PINNED)).toBeNull();
  });

  it("refuses a value no machine can present, and names the command that prints one", () => {
    for (const typed of ["SHA256:short", `256 ${PRESENTED} root@s1 (ED25519)`, PRESENTED.slice(7)]) {
      expect(machineIdentityRefusal(typed, server(), PINNED)).toContain("ssh-keygen -lf");
    }
  });

  it("takes the key already pinned where a machine-id is recorded — that statement drops the id", () => {
    // The machine's sshd did not change and its /etc/machine-id did: the person read the pinned
    // number off the machine, which is what says so, and the run that attests it is what refuses now.
    expect(machineIdentityRefusal(PINNED, server(), PINNED)).toBeNull();
  });

  it("refuses the key already pinned where no machine-id is recorded — neither number is in the way", () => {
    expect(machineIdentityRefusal(PINNED, server({ machineIdRecorded: false }), PINNED))
      .toMatch(/no \/etc\/machine-id is recorded beside it/);
  });

  it("refuses a NEW fingerprint on this manager's own machine, and names where it is stated instead", () => {
    for (const role of ["master", "master+slave"] as const) {
      const said = machineIdentityRefusal(PRESENTED, server({ role }), PINNED);
      expect(said).toMatch(/deployment configuration/);
      // And the half that is open there is named, so the refusal is not a dead end.
      expect(said).toContain(PINNED);
    }
    // The open half passes on the same machine.
    expect(machineIdentityRefusal(PINNED, server({ role: "master" }), PINNED)).toBeNull();
  });
});

describe("machineIdentitySubmitLabel — the button says which of the two acts it performs", () => {
  it("names the pin where the number differs, and the machine-id where it does not", () => {
    expect(machineIdentitySubmitLabel(PRESENTED, PINNED)).toBe("Pin the stated host key");
    expect(machineIdentitySubmitLabel(PINNED, PINNED)).toBe("Forget the recorded machine-id");
    expect(machineIdentitySubmitLabel(`  ${PINNED}\n`, PINNED)).toBe("Forget the recorded machine-id");
  });
});
