import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Load (or create on first boot) the 32-byte credential-store data key. Kept in the data dir
 * as `credstore.key`, mode 0600 (root/service-user only) — the whole point is that it is NOT
 * in the SQLite DB, so a DB dump alone leaks nothing. Enables the store's "keyfile" keystore
 * mode (AES-256-GCM at rest). Losing the file makes existing sealed credentials unreadable —
 * back it up with the DB (platform architecture docs: backups).
 */
export function loadOrCreateDataKey(dataDir: string): Buffer {
  const path = join(dataDir, "credstore.key");
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error(`${path} must be 32 bytes, got ${key.length}`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}
