import { createHash } from "node:crypto";

// Public, non-secret identifiers. Pure Node crypto — never ssh2 (that
// lives only in adapters/). keygen (which needs ssh2.utils) lands in adapters/ssh (E).

/**
 * OpenSSH SHA256 fingerprint of a public-key line ("ssh-ed25519 <base64blob> comment").
 * Identical to `ssh-keygen -lf`, so the operator can cross-check it on the server.
 */
export function fingerprintPublicKey(opensshLine: string): string {
  const b64 = opensshLine.trim().split(/\s+/)[1];
  if (!b64) throw new Error("not an OpenSSH public key line");
  const blob = Buffer.from(b64, "base64");
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/** Correlatable, non-revealing fingerprint for PATs / opaque secrets (audit correlation only). */
export function fingerprintSecret(plaintext: Buffer): string {
  return `sha256:${createHash("sha256").update(plaintext).digest("hex").slice(0, 16)}`;
}
