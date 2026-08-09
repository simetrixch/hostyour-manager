// server/domains/onboarding/secret-mint.ts
// Builds a consumer's Vault secret entry at seed time: every manifest `generate` key is MINTED here
// (the operator is never asked), required non-generate keys come from the operator, and every minted
// value is VERIFIED (length / key size / PEM shape / private↔public match) before it is written — a
// weak or corrupt mint fails the run rather than shipping to Vault. Split out of onboard.run.ts so the
// crypto stays a small, unit-tested unit.
import { randomBytes, randomUUID, generateKeyPairSync, createPublicKey } from "node:crypto";
import { errValidation, errMissingRunSecret } from "../../kernel/errors.ts";
import type { ConsumerSecretSpec } from "../../../shared/consumer.ts";

/** The single-value mint kinds (hex/uuid). Keypair kinds (rsa2048*) are minted in
 *  buildConsumerSecretData, which owns the shared keypair context.
 *  EXPORTED for the tenant crypto mint (tenant-crypto-mint.ts), which needs the same kinds for the
 *  same values: a tenant's bootstrap token and TOTP key are the hex32 a consumer's manifest declares,
 *  and minting them a second way would be two CSPRNG call sites for one kind of secret. */
export function mintSecretValue(kind: "hex32" | "hex16" | "uuid"): string {
  switch (kind) {
    case "hex32":
      return randomBytes(32).toString("hex");
    case "hex16":
      return randomBytes(16).toString("hex");
    case "uuid":
      return randomUUID();
  }
}

/** The instance-superuser password for a per-consumer PostgreSQL.
 *  NOT a manifest `secrets[]` value — the consumer never declares it — so it is neither a mint kind nor
 *  part of buildConsumerSecretData; it is minted service-side (iff `services` claims postgresql) and
 *  written to its OWN Vault leaf, create-only, by the seed-postgres-superuser step. 32 random bytes as
 *  hex (64 chars, [0-9a-f]): 256 bits of entropy in a form that needs no escaping inside a DATABASE_URL,
 *  a `POSTGRES_PASSWORD`, or an `ALTER ROLE ... PASSWORD` — the same CSPRNG the hex32 mint kind uses. */
export function mintPostgresSuperuserPassword(): string {
  return randomBytes(32).toString("hex");
}

/** The root password of a per-consumer MongoDB instance. Same shape and the same reasoning as the
 *  PostgreSQL superuser password above — 32 random bytes as hex, which needs no escaping inside a
 *  MONGODB_URI, a `MONGO_INITDB_ROOT_PASSWORD` or a mongosh `-p` argument. Not a manifest secret: the
 *  consumer never declares it, the mongo image creates the root user from it at first init, and the
 *  service-provisioner authenticates as it to mint the consumer's own users. */
export function mintMongodbRootPassword(): string {
  return randomBytes(32).toString("hex");
}

/** The keyfile a MongoDB REPLICA SET authenticates its own members with (--keyFile). MongoDB accepts
 *  6 to 1024 characters from the base64 alphabet and nothing else, so this is base64 TEXT and not
 *  hex: 756 random bytes is what the upstream documentation's `openssl rand -base64 756` produces,
 *  and 1024 base64 characters is the ceiling the server enforces.
 *
 *  Minted for BOTH modes although only a replica set mounts it. The Vault leaf is create-only, so an
 *  entry written without it could never gain it, and a unit re-onboarded from `standalone` to
 *  `replicaset` would come up with no keyfile to mount and refuse to start. */
export function mintMongodbKeyfile(): string {
  return randomBytes(756).toString("base64");
}

/** A fresh RSA-2048 keypair as PEM — PKCS#8 private + SPKI public, exactly the encodings a JWT signer
 *  (AUTH_JWT_PRIVATE_KEY) and its JWKS (AUTH_JWT_PUBLIC_KEY) expect. SELF-VERIFIED: the public is
 *  re-derived from the private and must equal the emitted public, so a corrupt pair can never reach
 *  Vault — it would otherwise only surface as a JWKS failure at the consumer's boot.
 *  EXPORTED for the tenant crypto mint (tenant-crypto-mint.ts): a tenant IdP signs with the same
 *  algorithm and its members verify against the same JWKS shape, and the self-verification is
 *  precisely what must not exist in two versions. */
export function generateRsaKeypair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const derived = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (derived !== publicKey) {
    throw new Error("generated RSA keypair failed self-verification (public != derived from private)");
  }
  return { privatePem: privateKey, publicPem: publicKey };
}

/** Fail-closed complexity floor for a minted value: a mint bug that yields an empty/short/non-PEM
 *  value must never be seeded as a "secret". The floor is each kind's own guarantee. */
function assertMintComplexity(key: string, kind: string, value: string): void {
  const floor =
    kind === "hex32" ? 64 : kind === "hex16" ? 32 : kind === "uuid" ? 36 : kind.startsWith("rsa2048") ? 256 : kind === "deploy-git-credentials" ? 24 : 1;
  if (value.length < floor) {
    throw new Error(`minted secret ${key} (${kind}) is too weak: ${value.length} chars < required ${floor}`);
  }
  if (kind.startsWith("rsa2048") && !value.includes("-----BEGIN")) {
    throw new Error(`minted secret ${key} (${kind}) is not a PEM block`);
  }
  if (kind === "deploy-git-credentials" && !(value.startsWith("https://") && value.includes("@github.com"))) {
    throw new Error(`derived secret ${key} (${kind}) is not a valid https://…@github.com git-credentials line`);
  }
}

export interface MintedSecretData {
  /** key -> value, ready for ONE Vault put. */
  data: Record<string, string>;
  /** Value-FREE summary of what was platform-generated (for the run log; never a secret value). */
  minted: string[];
}

/** Assemble the consumer's secret entry (contract v1.3). `generate` keys are minted + verified
 *  here; required non-generate keys come from `getProvided` (the operator's approve-time input); an
 *  unsupplied optional is skipped. `deploy-git-credentials` is DERIVED from the consumer's own repo
 *  PAT (`repoPat`, opened + zeroed by the seed-secrets step) so a consumer that writes to a GitOps
 *  repo reuses its ONE PAT instead of the operator supplying a second credential. Fail-closed: a
 *  missing required operator secret, an rsa2048-public whose pairWith names no rsa2048 key, or a
 *  deploy-git-credentials key with no repo PAT available, rejects the run. */
export function buildConsumerSecretData(
  specs: readonly ConsumerSecretSpec[],
  getProvided: (key: string) => string | undefined,
  repoPat?: string,
): MintedSecretData {
  // Pre-pass: generate every declared RSA keypair ONCE, keyed by its private-key name, so the paired
  // public half resolves regardless of declaration order and always matches its private half.
  const keypairs = new Map<string, { privatePem: string; publicPem: string }>();
  for (const spec of specs) {
    if (spec.generate === "rsa2048") keypairs.set(spec.key, generateRsaKeypair());
  }
  const data: Record<string, string> = {};
  const minted: string[] = [];
  for (const spec of specs) {
    if (spec.generate) {
      let value: string;
      if (spec.generate === "rsa2048") {
        value = keypairs.get(spec.key)!.privatePem; // guaranteed by the pre-pass above
        minted.push(`${spec.key}=RSA-2048 private/PKCS#8`);
      } else if (spec.generate === "rsa2048-public") {
        const pair = spec.pairWith ? keypairs.get(spec.pairWith) : undefined;
        if (!pair) {
          throw errValidation(
            `secret "${spec.key}" is generate:"rsa2048-public" but pairWith ${JSON.stringify(spec.pairWith ?? null)} names no generate:"rsa2048" key in the manifest`,
          );
        }
        value = pair.publicPem;
        minted.push(`${spec.key}=RSA-2048 public/SPKI (paired with ${spec.pairWith})`);
      } else if (spec.generate === "deploy-git-credentials") {
        // DERIVED, not random: the git-credentials-store line the consumer writes verbatim
        // (git credential.helper "store") to push to a GitOps repo. Built from the consumer's OWN
        // repo PAT (the one PAT per consumer, owner rule) so no second operator credential is asked.
        // Username "oauth2" is the GitHub PAT-over-HTTPS convention the platform's Tekton clone uses.
        // The PAT is opened + zeroed by the seed-secrets step and handed in as `repoPat`.
        const pat = (repoPat ?? "").trim();
        if (!pat) {
          throw errValidation(
            `secret "${spec.key}" is generate:"deploy-git-credentials" but the consumer repo PAT was not available to derive it from`,
          );
        }
        value = `https://oauth2:${pat}@github.com`;
        minted.push(`${spec.key}=git-credentials (derived from the consumer repo PAT)`);
      } else {
        value = mintSecretValue(spec.generate); // hex32 | hex16 | uuid
        minted.push(`${spec.key}=${spec.generate}`);
      }
      assertMintComplexity(spec.key, spec.generate, value); // fail closed on a weak/corrupt mint
      data[spec.key] = value;
      continue;
    }
    const v = getProvided(spec.key);
    if (v === undefined) {
      if (spec.required) throw errMissingRunSecret(`consumer-secret:${spec.key}`);
      continue; // optional and unsupplied — nothing to seed for this key
    }
    data[spec.key] = v;
  }
  return { data, minted };
}

/** {@link buildConsumerSecretData} plus the one derivation that needs an external credential: a
 *  generate:"deploy-git-credentials" key is built from the consumer's sealed repo PAT, opened via
 *  `openRepoPat` and ZEROED right after (the raw PAT never lingers). The PAT is opened ONLY
 *  when such a key is declared, so an ordinary consumer never opens it. Kept here with the mint logic
 *  so the onboard Run's seed step stays a thin caller. */
export async function buildConsumerSecretDataWithDerivations(
  specs: readonly ConsumerSecretSpec[],
  getProvided: (key: string) => string | undefined,
  openRepoPat: () => Promise<Buffer>,
): Promise<MintedSecretData> {
  const buf = specs.some((s) => s.generate === "deploy-git-credentials") ? await openRepoPat() : undefined;
  try {
    return buildConsumerSecretData(specs, getProvided, buf?.toString("utf8"));
  } finally {
    buf?.fill(0);
  }
}
