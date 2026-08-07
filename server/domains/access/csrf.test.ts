import { describe, it, expect } from "vitest";
import { parseConfig } from "../../kernel/config.ts";
import { csrfOk } from "./csrf.ts";

const config = parseConfig({
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://idp.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  CONTROLLER_VERSION: "test",
  DATA_DIR: "/d",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);

describe("csrf same-origin guard", () => {
  it("passes when Sec-Fetch-Site is same-origin", () => {
    expect(csrfOk({ secFetchSite: "same-origin" }, config)).toBe(true);
  });
  it("passes when Origin matches the public origin", () => {
    expect(csrfOk({ origin: "https://m1.example" }, config)).toBe(true);
  });
  it("compares origins, not raw strings (a trailing path does not disable the guard)", () => {
    expect(csrfOk({ origin: "https://m1.example/" }, config)).toBe(true);
  });
  it("rejects a cross-site Origin", () => {
    expect(csrfOk({ origin: "https://evil.example" }, config)).toBe(false);
  });
  it("rejects Sec-Fetch-Site cross-site", () => {
    expect(csrfOk({ secFetchSite: "cross-site" }, config)).toBe(false);
  });
  it("rejects when neither header is present", () => {
    expect(csrfOk({}, config)).toBe(false);
  });
});
