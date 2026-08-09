import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { generateServerKeypair, derivePublicKey } from "./keygen.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";

const { utils } = createRequire(import.meta.url)("ssh2") as typeof import("ssh2");

describe("keygen", () => {
  it("produces an OpenSSH ed25519 keypair with a matching fingerprint", () => {
    const k = generateServerKeypair("hostyourmanager:s5");
    expect(k.publicLine.startsWith("ssh-ed25519 ")).toBe(true);
    expect(k.publicLine).toContain("hostyourmanager:s5");
    expect(k.privateOpenSsh.toString("utf8")).toContain("OPENSSH PRIVATE KEY");
    expect(k.fingerprint.startsWith("SHA256:")).toBe(true);
    expect(k.fingerprint).toBe(fingerprintPublicKey(k.publicLine));
  });

  it("generates a distinct key on each call (per-server, never shared)", () => {
    expect(generateServerKeypair("a").fingerprint).not.toBe(generateServerKeypair("b").fingerprint);
  });

  // ssh2 hands back a pair nothing can read on roughly 1 draw in 256 (it strips the leading zero byte
  // of an ed25519 public key, leaving both halves 31 bytes long where they must be 32). A single draw
  // therefore proves nothing; DRAWS is picked so meeting that case is all but certain, which makes
  // this the guard against the retry loop in keygen.ts being taken back out. Both halves are checked
  // the two ways they are actually used: the private one by ssh2 itself (fake-server hands it to
  // `new Server({hostKeys})`, and the SSH client to `privateKey`), the public one as the
  // authorized_keys line a host is expected to authenticate.
  it("never returns a pair ssh2 cannot read back", () => {
    const DRAWS = 2000;
    const bad: string[] = [];
    for (let i = 0; i < DRAWS; i += 1) {
      const k = generateServerKeypair(`hostyourmanager:s${i}`);
      const parsed = utils.parseKey(k.privateOpenSsh);
      if (parsed instanceof Error) bad.push(`private: ${parsed.message}`);
      // The 32-byte point inside "ssh-ed25519 <base64>": 4-byte length + "ssh-ed25519" + 4-byte length.
      const blob = Buffer.from(k.publicLine.split(" ")[1] as string, "base64");
      const pointLength = blob.readUInt32BE(4 + "ssh-ed25519".length);
      if (pointLength !== 32) bad.push(`public: ${pointLength}-byte key`);
      if (derivePublicKey(k.privateOpenSsh).fingerprint !== k.fingerprint) bad.push("fingerprint: does not round-trip");
    }
    expect(bad, `${bad.length} of ${DRAWS} draws: ${bad.slice(0, 3).join("; ")}`).toEqual([]);
  });
});
