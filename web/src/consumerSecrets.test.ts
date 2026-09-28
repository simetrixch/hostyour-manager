import { describe, it, expect } from "vitest";
import type { ConsumerSecretKeyView } from "../../shared/api-types-onboard.ts";
import { approveSecrets, changesSecrets, secretStateLabel, toggleMint } from "./consumerSecrets.ts";

// What the Secrets dialog of a consumer says about each key and hands on (#317).

const key = (over: Partial<ConsumerSecretKeyView>): ConsumerSecretKeyView => ({ key: "K", state: "unknown", ...over });

describe("the consumer Secrets dialog", () => {
  it("says what the book knows of a value: a date, never set, or unknown", () => {
    expect(secretStateLabel(key({ state: "set", writtenAt: Date.UTC(2026, 8, 24, 12) }))).toBe("set 2026-09-24");
    expect(secretStateLabel(key({ state: "never" }))).toBe("never set");
    expect(secretStateLabel(key({ state: "unknown" }))).toBe("unknown");
  });

  it("ticks and unticks the two halves of a keypair together", () => {
    const keys = [key({ key: "PRIV", kind: "rsa2048", pairWith: "PUB" }), key({ key: "PUB", kind: "rsa2048-public", pairWith: "PRIV" }), key({ key: "API", kind: "hex32" })];
    expect(toggleMint(keys, [], "PRIV", true).sort()).toEqual(["PRIV", "PUB"]);
    expect(toggleMint(keys, ["API", "PRIV", "PUB"], "PUB", false)).toEqual(["API"]);
    expect(toggleMint(keys, [], "API", true)).toEqual(["API"]);
  });

  it("hands on only the typed values, under the keys the approve form asks them by", () => {
    expect(approveSecrets({ POST_OIDC_CLIENT_SECRET: "s3cret", SMTP_URL: "" })).toEqual({ "consumer-secret:POST_OIDC_CLIENT_SECRET": "s3cret" });
    expect(changesSecrets({ SMTP_URL: "" }, [])).toBe(false);
    expect(changesSecrets({ SMTP_URL: "x" }, [])).toBe(true);
    expect(changesSecrets({}, ["API"])).toBe(true);
  });
});
