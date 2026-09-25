import { describe, it, expect, afterEach } from "vitest";
import { registerSecret, unregisterScope, redact } from "./redact.ts";

describe("redact — the secret-free persistence chokepoint", () => {
  afterEach(() => unregisterScope("t"));

  it("masks a registered secret everywhere it appears", () => {
    registerSecret("t", Buffer.from("hunter2!"));
    expect(redact("logged in with hunter2! twice: hunter2!")).toBe("logged in with ••• twice: •••");
  });

  it("a malicious step logging the registered password yields •••", () => {
    registerSecret("t", Buffer.from("s3cr3t-pw"));
    expect(redact("echo password is s3cr3t-pw")).not.toContain("s3cr3t-pw");
  });

  it("masks PEM private key blocks and github tokens by pattern", () => {
    expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETBYTES\n-----END OPENSSH PRIVATE KEY-----")).not.toContain("SECRETBYTES");
    expect(redact("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("stops masking after unregisterScope", () => {
    registerSecret("t", Buffer.from("temporary-value"));
    unregisterScope("t");
    expect(redact("temporary-value")).toBe("temporary-value");
  });
});
