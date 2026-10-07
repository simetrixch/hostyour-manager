import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "#core/server/db/client.ts";
import { createLogger } from "#core/server/kernel/logger.ts";
import { parseConfig } from "#core/server/kernel/config.ts";
import { REQUIRED_ENV } from "#core/server/kernel/config.fixture.ts";
import { CredentialStore } from "#core/server/security/store.ts";
import { dropUnitCallKey, findUnitCallKey, keepUnitCallKey } from "./unit-call-key.ts";

const logger = createLogger(
  parseConfig({
    ...REQUIRED_ENV,
    PUBLIC_URL: "https://m1.example",
    OIDC_ISSUER: "https://idp.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    MANAGER_VERSION: "test",
    DATA_DIR: "/data",
    ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);
const use = { purpose: "unit-call-key.test" };
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function freshStore(): CredentialStore {
  const dir = mkdtempSync(join(tmpdir(), "mgr-unit-call-key-"));
  dirs.push(dir);
  const handle = openDb(join(dir, "manager.db"));
  closers.push(() => handle.sqlite.close());
  return new CredentialStore({ db: handle.db, logger });
}
const opened = async (store: CredentialStore, unit: string, stage: "test" | "prod") => {
  const ref = await findUnitCallKey(store, unit, stage);
  return ref ? (await store.open(ref.id, use)).toString("utf8") : null;
};

describe("the key a unit's stage accepts from the Manager", () => {
  it("is kept under that stage and opens to the value written into the stage's entry", async () => {
    const store = freshStore();
    await keepUnitCallKey(store, { unit: "digita-post", stage: "test", key: "POST_MANAGER_KEY", value: "a".repeat(64) });
    expect(await opened(store, "digita-post", "test")).toBe("a".repeat(64));
    expect(await findUnitCallKey(store, "digita-post", "prod")).toBeNull();
  });

  it("a new mint rotates the standing key, so only the newest value is found", async () => {
    const store = freshStore();
    await keepUnitCallKey(store, { unit: "digita-post", stage: "test", key: "POST_MANAGER_KEY", value: "a".repeat(64) });
    await keepUnitCallKey(store, { unit: "digita-post", stage: "test", key: "POST_MANAGER_KEY", value: "b".repeat(64) });
    expect(await opened(store, "digita-post", "test")).toBe("b".repeat(64));
    expect(await store.list({ purpose: "unit-call-key", excludeRotated: true })).toHaveLength(1);
  });

  it("dropping one stage's key removes its rotated rows too and leaves the other stage's", async () => {
    const store = freshStore();
    await keepUnitCallKey(store, { unit: "digita-post", stage: "test", key: "POST_MANAGER_KEY", value: "a".repeat(64) });
    await keepUnitCallKey(store, { unit: "digita-post", stage: "test", key: "POST_MANAGER_KEY", value: "b".repeat(64) });
    await keepUnitCallKey(store, { unit: "digita-post", stage: "prod", key: "POST_MANAGER_KEY", value: "c".repeat(64) });
    expect(await dropUnitCallKey(store, "digita-post", "test")).toBe(2);
    expect(await findUnitCallKey(store, "digita-post", "test")).toBeNull();
    expect(await opened(store, "digita-post", "prod")).toBe("c".repeat(64));
  });
});
