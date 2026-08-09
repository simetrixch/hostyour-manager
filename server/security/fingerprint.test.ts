import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { fingerprintPublicKey, fingerprintSecret } from "./fingerprint.ts";

describe("fingerprint", () => {
  it("fingerprintSecret matches a known sha256 vector", () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(fingerprintSecret(Buffer.from("hello"))).toBe("sha256:2cf24dba5fb0a30e");
  });

  it("fingerprintPublicKey = SHA256:<base64-no-pad(sha256(decoded blob))>", () => {
    const b64 = "AAAAC3NzaC1lZDI1NTE5AAAAICZzZXhhbXBsZXNleGFtcGxlc2V4YW1wbGVzZXho";
    const line = `ssh-ed25519 ${b64} test@m1`;
    const expected = "SHA256:" + createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64").replace(/=+$/, "");
    expect(fingerprintPublicKey(line)).toBe(expected);
    expect(fingerprintPublicKey(line)).not.toContain("=");
    // fingerprints the DECODED blob, not the base64 text
    expect(fingerprintPublicKey(line)).not.toBe(fingerprintSecret(Buffer.from(b64)));
  });

  it("rejects a line that is not an OpenSSH public key", () => {
    expect(() => fingerprintPublicKey("not-a-key")).toThrow();
  });
});
