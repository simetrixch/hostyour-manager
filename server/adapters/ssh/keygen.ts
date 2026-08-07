// ssh2 is CommonJS. Node's raw ESM loader (the e2e harness + `npm start` run `node --import
// tsx`) cannot see its `utils` named export (cjs-module-lexer misses it), and a default import
// resolves DIFFERENTLY between the ESM loader and vitest (that regressed the ssh2-session test
// on CI). createRequire returns the exact `module.exports` in BOTH — the original in-process
// behavior — so the generated-key roundtrip never varies. (ssh2-session.ts's `{ Client }` is
// lexer-visible, so it needs no such treatment.)
import { createRequire } from "node:module";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";

const { utils } = createRequire(import.meta.url)("ssh2") as typeof import("ssh2");

export interface GeneratedKey {
  privateOpenSsh: Buffer; // OpenSSH-format private key; ssh2 accepts it directly as privateKey
  publicLine: string; // "ssh-ed25519 AAAA… <comment>"
  fingerprint: string; // SHA256:… (== ssh-keygen -lf)
}

/** How many draws a caller gets before generateServerKeypair gives up. Each one independently has
 *  about a 1-in-256 chance of coming out unusable (see below), so eight is far past the point where
 *  a run of bad luck is the explanation and something has really changed in ssh2. */
const MAX_KEYPAIR_DRAWS = 8;

/**
 * Per-server ed25519 keypair (least privilege: never a key shared across servers).
 * ssh2.utils.generateKeyPairSync gives OpenSSH-format keys; this is the only place
 * ssh2 is used outside the session — it lives in adapters/ (dep-cruiser boundary).
 *
 * EVERY DRAW IS PARSED BACK before it is returned, because ssh2's OpenSSH encoder produces a pair
 * nothing can read whenever the public key's first byte happens to be 0x00: it strips leading zero
 * bytes from the key blob — right for an integer, wrong for a fixed-width 32-byte ed25519 point — and
 * writes a length of 31 into both the private and the public half. Measured at ~0.4% of draws, and
 * both halves are always spoiled together, so parsing the private half decides the pair. Nothing
 * downstream can recover from a bad one: adopt seals it as the server's ONLY ssh_key credential,
 * appends the broken public line to the host's authorized_keys, and its reuse-on-retry branch then
 * finds that same credential on every later attempt — so the server can never be adopted again until
 * someone deletes the credential row by hand. Here a bad draw costs one more draw.
 */
export function generateServerKeypair(comment: string): GeneratedKey {
  let lastError = "";
  for (let draw = 0; draw < MAX_KEYPAIR_DRAWS; draw += 1) {
    const pair = utils.generateKeyPairSync("ed25519", { comment });
    const privateOpenSsh = Buffer.from(pair.private, "utf8");
    const parsed = utils.parseKey(privateOpenSsh); // the same parse derivePublicKey below does
    if (parsed instanceof Error) {
      lastError = parsed.message;
      continue;
    }
    const publicLine = pair.public.trim();
    return { privateOpenSsh, publicLine, fingerprint: fingerprintPublicKey(publicLine) };
  }
  throw new Error(`ssh2 produced ${MAX_KEYPAIR_DRAWS} unreadable ed25519 keypairs in a row (${lastError}) — refusing to seal a key nothing can parse`);
}

/**
 * Derive the public line + SHA256 fingerprint from an EXISTING OpenSSH private key (no
 * passphrase). Used by boot/seed-master.ts, which only receives the master's private key
 * (materialized by ESO from Vault) and must seal it as an ssh_key credential with the same
 * fingerprint idiom generateServerKeypair produces. ssh2 lives only in adapters/, so this
 * parsing stays here (the dep-cruiser boundary).
 */
export function derivePublicKey(privateOpenSsh: Buffer): { publicLine: string; fingerprint: string } {
  const parsed = utils.parseKey(privateOpenSsh);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) throw new Error("could not parse the master private key (empty parse result)");
  const b64 = key.getPublicSSH().toString("base64");
  const publicLine = `${key.type} ${b64}${key.comment ? ` ${key.comment}` : ""}`;
  return { publicLine, fingerprint: fingerprintPublicKey(publicLine) };
}
