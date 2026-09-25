import { describe, it, expect } from "vitest";
import { createPublicKey } from "node:crypto";
import { buildConsumerSecretData, mintPostgresSuperuserPassword } from "./secret-mint.ts";
import type { ConsumerSecretSpec } from "../../../shared/consumer.ts";

describe("mintPostgresSuperuserPassword (per-consumer postgres superuser)", () => {
  it("mints 64 hex chars (32 random bytes = 256 bits) — no escaping hazard for a DATABASE_URL / ALTER ROLE", () => {
    const pw = mintPostgresSuperuserPassword();
    expect(pw).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is a fresh CSPRNG value each call (never a constant)", () => {
    const a = mintPostgresSuperuserPassword();
    const b = mintPostgresSuperuserPassword();
    expect(a).not.toBe(b);
  });
});

const spec = (over: Partial<ConsumerSecretSpec> & { key: string }): ConsumerSecretSpec => ({
  required: true,
  ...over,
});

describe("buildConsumerSecretData — deploy-git-credentials (repo-PAT derived)", () => {
  it("derives the https://oauth2:<pat>@github.com line from the consumer's repo PAT", () => {
    const { data, minted } = buildConsumerSecretData(
      [spec({ key: "PLANE_BACKEND_DEPLOY_GIT_CREDENTIALS", generate: "deploy-git-credentials" })],
      () => undefined,
      "ghp_examplePAT1234567890",
    );
    expect(data["PLANE_BACKEND_DEPLOY_GIT_CREDENTIALS"]).toBe(
      "https://oauth2:ghp_examplePAT1234567890@github.com",
    );
    // The run log summary is value-FREE — the PAT must never leak into `minted`.
    const summary = minted.join(" ");
    expect(summary).toContain("PLANE_BACKEND_DEPLOY_GIT_CREDENTIALS=git-credentials");
    expect(summary).not.toContain("ghp_");
  });

  it("fails closed when no repo PAT is available to derive from", () => {
    expect(() =>
      buildConsumerSecretData(
        [spec({ key: "DEPLOY", generate: "deploy-git-credentials" })],
        () => undefined,
        undefined,
      ),
    ).toThrow(/repo PAT was not available/);
  });

  it("fails closed on an empty / whitespace repo PAT", () => {
    expect(() =>
      buildConsumerSecretData([spec({ key: "DEPLOY", generate: "deploy-git-credentials" })], () => undefined, "   "),
    ).toThrow(/repo PAT was not available/);
  });

  it("leaves ordinary generate/operator keys untouched when no repo PAT is passed", () => {
    const { data } = buildConsumerSecretData(
      [spec({ key: "SESSION_SECRET", generate: "hex32" }), spec({ key: "SUPPLIED" })],
      (k) => (k === "SUPPLIED" ? "operator-value" : undefined),
    );
    expect(data["SESSION_SECRET"]).toHaveLength(64);
    expect(data["SUPPLIED"]).toBe("operator-value");
  });
});

describe("buildConsumerSecretData — the public halves of the minted key pairs", () => {
  it("hands back the SPKI public half of every rsa2048 key, matching the private half it put into data", () => {
    const specs: ConsumerSecretSpec[] = [
      { key: "MAIL_DKIM_PRIVATE_KEY", required: true, generate: "rsa2048" },
      { key: "TOKEN", required: true, generate: "hex32" },
    ];
    const { data, publicKeys } = buildConsumerSecretData(specs, () => undefined);
    expect(Object.keys(publicKeys)).toEqual(["MAIL_DKIM_PRIVATE_KEY"]);
    expect(publicKeys["MAIL_DKIM_PRIVATE_KEY"]).toBe(createPublicKey(data["MAIL_DKIM_PRIVATE_KEY"]!).export({ type: "spki", format: "pem" }).toString());
  });
});
