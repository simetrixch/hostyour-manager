import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { parseConfig, type Config } from "../../kernel/config.ts";
import { EncryptJWT } from "jose";
import { SessionCodec, loadOrCreateKey } from "./session.ts";
import { revokeJti, bootEpochMs, __setBootEpochForTest } from "./revocation.ts";

const config = parseConfig({
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://idp.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test",
  DATA_DIR: "/d",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const ORIGINAL_BOOT_EPOCH = bootEpochMs();

describe("SessionCodec — sealed JWE session", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function codec(cfg: Config = config): SessionCodec {
    const dir = mkdtempSync(join(tmpdir(), "mgr-ses-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return new SessionCodec(db.db, cfg);
  }
  afterEach(() => {
    __setBootEpochForTest(ORIGINAL_BOOT_EPOCH);
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("mints and verifies a session round-trip", async () => {
    const c = codec();
    const token = await c.mint({ sub: "op_1", email: "a@x", groups: ["admins"], via: "oidc" });
    const v = await c.verify(token);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") {
      expect(v.session.sub).toBe("op_1");
      expect(v.session.email).toBe("a@x");
      expect(v.session.groups).toEqual(["admins"]);
      expect(v.session.via).toBe("oidc");
    }
  });

  // `via` decides one thing outside this file — reset/api.ts refuses "emergency" and admits
  // everything else — so a word this decoder does not know must land on the refused side. Forged
  // with the codec's own key, because a token holding an unknown `via` is exactly what a session
  // sealed by a future mint and read by today's decoder would be.
  it("an unknown `via` reads back as 'emergency', never as the privileged 'oidc'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-via-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const c = new SessionCodec(db.db, config);
    const now = Math.floor(Date.now() / 1000);
    const forged = await new EncryptJWT({ groups: ["admins"], via: "socket", be: bootEpochMs(), aa: now })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setSubject("op_1")
      .setJti("j")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .encrypt(loadOrCreateKey(db.db, "session.key"));
    const v = await c.verify(forged);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.session.via).toBe("emergency");
  });

  it("rejects a tampered cookie", async () => {
    const c = codec();
    const token = await c.mint({ sub: "op_1", groups: ["admins"], via: "oidc" });
    expect((await c.verify(`${token.slice(0, -3)}AAA`)).kind).toBe("invalid");
  });

  it("rejects a revoked jti", async () => {
    const c = codec();
    const token = await c.mint({ sub: "op_1", groups: ["admins"], via: "oidc" });
    const v = await c.verify(token);
    if (v.kind !== "ok") throw new Error("expected ok");
    revokeJti(v.session.jti);
    expect((await c.verify(token)).kind).toBe("invalid");
  });

  it("fail-closes any session minted before the current process bootEpoch (restart)", async () => {
    const c = codec();
    const token = await c.mint({ sub: "op_1", groups: ["admins"], via: "oidc" });
    __setBootEpochForTest(ORIGINAL_BOOT_EPOCH + 5_000); // simulate a restart
    expect((await c.verify(token)).kind).toBe("invalid");
  });

  it("rejects a session past its idle window", async () => {
    const c = codec({ ...config, session: { idleSeconds: 1, absoluteSeconds: 43200 } });
    const token = await c.mint({ sub: "op_1", groups: ["admins"], via: "oidc" });
    await new Promise((r) => setTimeout(r, 1100));
    expect((await c.verify(token)).kind).toBe("invalid");
  });

  // The two refresh tests fake ONLY Date (vi.setSystemTime): both lifetime checks read the wall
  // clock, and a real sleep under full-suite CPU contention overshoots any margin that would keep
  // the test fast.
  it("refresh() restarts the idle window — idle measures inactivity, not time since login", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
    try {
      const c = codec({ ...config, session: { idleSeconds: 30, absoluteSeconds: 43200 } });
      const token = await c.mint({ sub: "op_1", groups: ["admins"], via: "oidc" });
      vi.setSystemTime(1_700_000_020_000); // 20s after login — inside the idle window
      const v = await c.verify(token);
      if (v.kind !== "ok") throw new Error("expected ok before the idle window closed");
      const refreshed = await c.refresh(v.session);
      vi.setSystemTime(1_700_000_040_000); // 40s after login, 20s after the last activity
      const again = await c.verify(refreshed);
      expect(again.kind).toBe("ok");
      if (again.kind === "ok") expect(again.session.jti).toBe(v.session.jti); // revocation still reaches it
      expect((await c.verify(token)).kind).toBe("invalid"); // no activity on the original since login
    } finally {
      vi.useRealTimers();
    }
  });

  it("refresh() never slides past the absolute lifetime — exp stays anchored at first mint", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
    try {
      const c = codec({ ...config, session: { idleSeconds: 3600, absoluteSeconds: 600 } });
      const token = await c.mint({ sub: "op_1", groups: ["admins"], via: "oidc" });
      vi.setSystemTime(1_700_000_300_000); // 5min in — refresh with plenty of absolute lifetime left
      const v = await c.verify(token);
      if (v.kind !== "ok") throw new Error("expected ok inside the absolute lifetime");
      const refreshed = await c.refresh(v.session);
      vi.setSystemTime(1_700_000_601_000); // 10min 1s after LOGIN — past authAt + absoluteSeconds
      // Fresh activity cannot save it: the refreshed cookie carries the ORIGINAL authAt-anchored exp.
      expect((await c.verify(refreshed)).kind).toBe("invalid");
    } finally {
      vi.useRealTimers();
    }
  });
});
