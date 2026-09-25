import { describe, it, expect } from "vitest";
import { readHostKeyFingerprint } from "./preflight.ts";

// The shape of a host-key fingerprint, which is the value a person types when they say a machine
// was rebuilt. It is checked here rather than at either end because both ends check it against this
// one function: the browser, so a typo is answered under the field, and the inventory write, which
// is the boundary that decides what may be pinned on a row.
//
// WHAT MAKES THE RULE LOAD-BEARING is that a pin is compared byte for byte during key exchange. A
// value this function accepted but no sshd can present would replace a refusal that names a real
// machine with one that names nothing, and no later run could tell the operator why.

/** 43 base64 characters is what a 32-byte digest becomes once its padding is stripped, which is what
 *  the SSH adapter builds and what `ssh-keygen -lf` prints. */
const REAL = `SHA256:${"aB9+/".repeat(9).slice(0, 43)}`;

describe("readHostKeyFingerprint", () => {
  it("takes the fingerprint an sshd presents", () => {
    expect(REAL.length).toBe(50);
    expect(readHostKeyFingerprint(REAL)).toBe(REAL);
  });

  it("forgives the whitespace a copied terminal line carries, and nothing else", () => {
    expect(readHostKeyFingerprint(`  ${REAL}\n`)).toBe(REAL);
    expect(readHostKeyFingerprint(`${REAL}\r\n`)).toBe(REAL);
    // Repairing anything further would pin a value the person never typed.
    expect(readHostKeyFingerprint(REAL.replace("SHA256:", "sha256:"))).toBeNull();
    expect(readHostKeyFingerprint(REAL.replace("SHA256:", "MD5:"))).toBeNull();
    expect(readHostKeyFingerprint(`${REAL}=`)).toBeNull();
  });

  it("refuses a digest of the wrong length, in either direction", () => {
    expect(readHostKeyFingerprint(`SHA256:${"a".repeat(42)}`)).toBeNull();
    expect(readHostKeyFingerprint(`SHA256:${"a".repeat(44)}`)).toBeNull();
    expect(readHostKeyFingerprint("SHA256:")).toBeNull();
    expect(readHostKeyFingerprint("")).toBeNull();
  });

  it("refuses the whole line `ssh-keygen -lf` prints, of which the fingerprint is one field", () => {
    expect(readHostKeyFingerprint(`256 ${REAL} root@r1 (ED25519)`)).toBeNull();
    // The bare digest without the algorithm in front of it is not what the adapter compares.
    expect(readHostKeyFingerprint(REAL.slice("SHA256:".length))).toBeNull();
  });
});
