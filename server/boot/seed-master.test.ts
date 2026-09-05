import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig, type Config } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { servers, clusters } from "../db/schema/inventory.ts";
import { generateServerKeypair } from "../adapters/ssh/keygen.ts";
import { seedMaster, stopMasterReconcile } from "./seed-master.ts";

const BASE_ENV = {
  PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  MANAGER_VERSION: "test",
  // MASTER_STAGE is REQUIRED whenever MASTER_FQDN is set (config.ts refine); default it here so the
  // many MASTER_FQDN tests below stay terse. Ignored when MASTER_FQDN is unset (the no-op case).
  MASTER_STAGE: "prod",
} as const;

const logger = createLogger(parseConfig(BASE_ENV as unknown as NodeJS.ProcessEnv));

// A host-key pin (SHA256:…) — REQUIRED for the key to seal: seed-master refuses to seal an
// unpinned master key (the boot-time env-vs-volume race guard).
const FP = "SHA256:AAAABBBBCCCCDDDDEEEEFFFF00112233445566778899aa";

describe("boot/seed-master — master self-registration", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    // ORDER IS LOAD-BEARING: (1) stopMasterReconcile BEFORE useRealTimers — reversed, the fake
    // timer would be discarded while the module-level single-flight guard stays set, silently
    // blocking the next test's reconcile; (2) both BEFORE closing the DB handles, so no armed
    // tick can fire against a closed handle. An attempt already mid-await is not cancelled —
    // fine today (the test-mode store is sync-in-promise, fake-timer runs are fully drained),
    // but a future Vault-mode test with real I/O would need to await quiescence here.
    stopMasterReconcile();
    vi.useRealTimers();
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(): { db: DbHandle; store: CredentialStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-seed-"));
    dirs.push(dir);
    const h = openDb(join(dir, "c.db"));
    handles.push(h);
    return { db: h, store: new CredentialStore({ db: h.db, logger }), dir };
  }

  function cfg(extra: Record<string, string>): Config {
    return parseConfig({ ...BASE_ENV, ...extra } as unknown as NodeJS.ProcessEnv);
  }

  it("no-op when MASTER_FQDN is unset (dev/tests): no master row, no key", async () => {
    const { db, store } = setup();
    await seedMaster(db.db, store, cfg({}), logger);
    expect(db.db.select().from(servers).all()).toEqual([]);
    expect(await store.list({ kind: "ssh_key" })).toEqual([]);
  });

  it("seeds the role=master row from MASTER_* + seals the self-SSH key", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);

    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com",
      MASTER_SSH_USER: "m1",
      MASTER_LAN_HOST: "10.1.1.4",
      MASTER_SSH_KEY_FILE: keyFile,
      MASTER_SSH_HOST_KEY_FP: FP,
    }), logger);

    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect(row).toMatchObject({
      name: "m1", host: "m1.example.com", lanHost: "10.1.1.4",
      sshUser: "m1", sshPort: 22, role: "master", status: "healthy",
    });

    const keys = await store.list({ serverId: row!.id, kind: "ssh_key" });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.fingerprint).toBe(key.fingerprint); // derived == generated
    expect(keys[0]?.label).toBe("master SSH key (self)");
  });

  it("is idempotent — a second run inserts no duplicate row and no duplicate key", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);
    const config = cfg({ MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP });

    await seedMaster(db.db, store, config, logger);
    await seedMaster(db.db, store, config, logger);

    expect(db.db.select().from(servers).where(eq(servers.role, "master")).all()).toHaveLength(1);
    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1);
  });

  it("finds an existing master+slave row instead of inserting a second master", async () => {
    // The control host may equally carry the union role, and then the row this seed reconciles is
    // that one. Keying on the literal "master" alone would miss it, try to INSERT, and die on
    // servers_one_master_uq — leaving a live master+slave without its pinned host key and self-SSH key.
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);
    db.db.insert(servers).values({
      id: "srv_existing", name: "m1", host: "m1.example.com", sshUser: "m1",
      role: "master+slave", status: "healthy",
    }).run();

    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP,
    }), logger);

    const rows = db.db.select().from(servers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "srv_existing", role: "master+slave" });
    expect((rows[0]?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(FP);
    expect(await store.list({ serverId: "srv_existing", kind: "ssh_key" })).toHaveLength(1);
  });

  it("seeds the master self-cluster row (status active, slaveId NULL, stage from config)", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);

    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_STAGE: "test",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP,
    }), logger);

    const srv = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    const cls = db.db.select().from(clusters).where(eq(clusters.serverId, srv!.id)).get();
    expect(cls).toMatchObject({
      serverId: srv!.id, domain: "m1.example.com", status: "active",
      stage: "test", planeState: "absent",
    });
    expect(cls?.slaveId).toBeNull(); // the master carries no slave ordinal
  });

  it("seeds the row with no key file at all — the degrade path still writes the self-cluster", async () => {
    const { db, store } = setup();
    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_STAGE: "prod",
    }), logger);
    const cls = db.db.select().from(clusters).get();
    expect(cls).toMatchObject({ stage: "prod", status: "active" });
  });

  it("is idempotent — a second run inserts no duplicate self-cluster row and reconciles drift", async () => {
    const { db, store } = setup();
    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_STAGE: "test",
    }), logger);
    // A later boot with a changed stage reconciles the SAME row (no duplicate).
    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_STAGE: "prod",
    }), logger);

    const rows = db.db.select().from(clusters).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "prod", domain: "m1.example.com", status: "active" });
  });

  it("degrades gracefully when the key file is absent: row seeded, no key, re-seals on a later boot", async () => {
    const { db, store, dir } = setup();
    const keyFile = join(dir, "not-yet-there");
    const config = cfg({ MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP });

    // First boot: ESO secret not materialized yet — row exists, no key, boot survives.
    await seedMaster(db.db, store, config, logger);
    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect(row?.host).toBe("m1.example.com");
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(0);

    // Later boot: the file is now present — the key seals without a duplicate row.
    const key = generateServerKeypair("m1-master");
    writeFileSync(keyFile, key.privateOpenSsh);
    await seedMaster(db.db, store, config, logger);
    expect(db.db.select().from(servers).where(eq(servers.role, "master")).all()).toHaveLength(1);
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1);
  });

  it("REFUSES to seal an unpinned master key (key file present, no host-key fp)", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);
    // Key file present but MASTER_SSH_HOST_KEY_FP omitted (the env-vs-volume race).
    const config = cfg({ MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_SSH_KEY_FILE: keyFile });

    await seedMaster(db.db, store, config, logger);

    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect(row?.host).toBe("m1.example.com"); // row still seeded
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBeUndefined(); // no pin
    // The invariant: no pin ⇒ NO sealed key (never an unpinned, MITM-able master key).
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(0);

    // Once the pin env arrives on a later boot, the key seals (pin + key together).
    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP,
    }), logger);
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1);
  });

  it("pins the host-key fingerprint on the master row (same shape a deployment writes)", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);
    const fp = "SHA256:AAAABBBBCCCCDDDDEEEEFFFF00112233445566778899aa";

    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: fp,
    }), logger);

    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    // getSsh/context.ts reads preflightJson.hostKey and pins it as hostKeyFingerprint.
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(fp);

    // A later boot with a CHANGED fingerprint updates the pin (host key rotated).
    const fp2 = "SHA256:ZZZZ9999YYYY8888XXXX777700112233445566778899bb";
    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: fp2,
    }), logger);
    const row2 = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((row2?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(fp2);
  });

  it("rotates the sealed credential in place when the mounted key changes", async () => {
    const { db, store, dir } = setup();
    const keyFile = join(dir, "master-ssh-key");
    const config = cfg({ MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1", MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP });

    const key1 = generateServerKeypair("m1-master");
    writeFileSync(keyFile, key1.privateOpenSsh);
    await seedMaster(db.db, store, config, logger);
    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((await store.list({ serverId: row!.id, kind: "ssh_key" })).at(-1)?.fingerprint).toBe(key1.fingerprint);

    // The host key was FORCE-rotated → the mounted file now holds a DIFFERENT private key.
    const key2 = generateServerKeypair("m1-master");
    expect(key2.fingerprint).not.toBe(key1.fingerprint);
    writeFileSync(keyFile, key2.privateOpenSsh);
    await seedMaster(db.db, store, config, logger);

    // ctx.ssh(master) uses the NEWEST ssh_key credential — it must now be key2.
    const after = await store.list({ serverId: row!.id, kind: "ssh_key" });
    expect(after.at(-1)?.fingerprint).toBe(key2.fingerprint);

    // A re-run with the same (key2) file is a no-op — no further credential rows.
    const count = after.length;
    await seedMaster(db.db, store, config, logger);
    expect((await store.list({ serverId: row!.id, kind: "ssh_key" })).length).toBe(count);
  });

  it("degrades (no crash, no master row) when a stray server already holds the name", async () => {
    const { db, store } = setup();
    // A leftover slave named "m1" (== the derived master name) blocks the insert.
    db.sqlite
      .prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES ('srv_stray','m1','9.9.9.9','root','slave','ready')")
      .run();
    await seedMaster(db.db, store, cfg({ MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1" }), logger);
    // No master row created; the stray row is untouched; boot did not throw.
    expect(db.db.select().from(servers).where(eq(servers.role, "master")).all()).toEqual([]);
    expect(db.db.select().from(servers).where(eq(servers.role, "slave")).all()).toHaveLength(1);
  });

  it("reconciles config drift onto the existing master row", async () => {
    const { db, store } = setup();
    await seedMaster(db.db, store, cfg({ MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1" }), logger);
    // Operator moved the control host to a new FQDN/user; a later boot reconciles it.
    await seedMaster(db.db, store, cfg({ MASTER_FQDN: "m2.example.com", MASTER_SSH_USER: "ubuntu" }), logger);
    const rows = db.db.select().from(servers).where(eq(servers.role, "master")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: "m2.example.com", sshUser: "ubuntu", name: "m1" });
  });

  it("MASTER_FQDN without MASTER_SSH_USER is a config error", () => {
    expect(() => cfg({ MASTER_FQDN: "m1.example.com" })).toThrow(/MASTER_SSH_USER/);
  });

  it("SELF-HEALS with no restart: fp+key files materialize late → the background reconcile pins + seals", async () => {
    vi.useFakeTimers();
    const { db, store, dir } = setup();
    const keyFile = join(dir, "ssh-private-key");
    const fpFile = join(dir, "host-key-fp");
    const config = cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP_FILE: fpFile,
    });

    // Boot: the ESO secret is not materialized — NEITHER file exists. Row seeded, nothing sealed.
    await seedMaster(db.db, store, config, logger);
    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBeUndefined();
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(0);

    // ESO materializes the secret while the "pod" keeps running (kubelet refreshes the volume).
    const key = generateServerKeypair("m1-master");
    writeFileSync(keyFile, key.privateOpenSsh);
    writeFileSync(fpFile, `${FP}\n`); // secret writers often append a trailing newline

    await vi.advanceTimersByTimeAsync(20_000); // ONE reconcile tick — no restart, no re-boot

    const after = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((after?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(FP); // pinned, TRIMMED
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1); // sealed

    // Converged ⇒ the timer stopped itself: more time changes nothing (no dup, no rotation).
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1);
  });

  it("the background reconcile is BOUNDED: it gives up after the window; a later boot still heals", async () => {
    vi.useFakeTimers();
    const { db, store, dir } = setup();
    const keyFile = join(dir, "never-arrives-key");
    const fpFile = join(dir, "never-arrives-fp");
    const config = cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP_FILE: fpFile,
    });
    await seedMaster(db.db, store, config, logger);

    await vi.advanceTimersByTimeAsync(21 * 60_000); // past RECONCILE_MAX_MS — the timer must be dead

    // Material arrives AFTER the window: the dead timer must NOT seal anything…
    const key = generateServerKeypair("m1-master");
    writeFileSync(keyFile, key.privateOpenSsh);
    writeFileSync(fpFile, FP);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(0);

    // …but the documented recovery (a pod restart ⇒ another seedMaster) still works.
    await seedMaster(db.db, store, config, logger);
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1);
  });

  it("the fp FILE (fresh) wins over the fp env (static)", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);
    const fpFile = join(dir, "host-key-fp");
    const FRESH = "SHA256:FRESHfromFILE0011223344556677889900aabbccddee";
    writeFileSync(fpFile, `${FRESH}\n`);

    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP, MASTER_SSH_HOST_KEY_FP_FILE: fpFile,
    }), logger);

    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(FRESH);
  });

  it("falls back to the fp ENV when the fp file is configured but not present", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);

    await seedMaster(db.db, store, cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP,
      MASTER_SSH_HOST_KEY_FP_FILE: join(dir, "not-there"),
    }), logger);

    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(FP);
    expect(await store.list({ serverId: row!.id, kind: "ssh_key" })).toHaveLength(1);
  });

  it("a transient fp-file miss never DOWNGRADES a file-written pin to the static env value", async () => {
    const { db, store, dir } = setup();
    const key = generateServerKeypair("m1-master");
    const keyFile = join(dir, "master-ssh-key");
    writeFileSync(keyFile, key.privateOpenSsh);
    const fpFile = join(dir, "host-key-fp");
    const FRESH = "SHA256:FRESHfromFILE0011223344556677889900aabbccddee";
    writeFileSync(fpFile, FRESH);
    const config = cfg({
      MASTER_FQDN: "m1.example.com", MASTER_SSH_USER: "m1",
      MASTER_SSH_KEY_FILE: keyFile, MASTER_SSH_HOST_KEY_FP: FP, MASTER_SSH_HOST_KEY_FP_FILE: fpFile,
    });

    await seedMaster(db.db, store, config, logger); // file wins → pinned FRESH, key sealed
    rmSync(fpFile); // the file transiently unreadable; the stale boot-time env is still set
    await seedMaster(db.db, store, config, logger); // env may only FILL an absent pin — not overwrite

    const row = db.db.select().from(servers).where(eq(servers.role, "master")).get();
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe(FRESH); // NOT downgraded to FP
  });
});
