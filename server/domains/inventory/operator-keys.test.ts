import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers } from "../../db/schema/inventory.ts";
import { createOperatorKey, deleteOperatorKey, listOperatorKeys, loadOperatorKey } from "./operator-keys.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";
import { operatorKeyMarker } from "../../../shared/operator-keys.ts";

// The row an operator key IS, and the one refusal that keeps it from becoming a key nothing can
// take off again.

const BLOB_A = "AAAAC3NzaC1lZDI1NTE5AAAAIOperatorPatKeyAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BLOB_B = "AAAAC3NzaC1lZDI1NTE5AAAAIOperatorSamKeyBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAT_FP = fingerprintPublicKey(`ssh-ed25519 ${BLOB_A}`);

describe("operator keys — the rows", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-opkeys-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    db.db.insert(servers).values({
      id: "srv_1", name: "s1", host: "203.0.113.7", sshPort: 22, sshUser: "hostyour1", role: "slave", status: "healthy",
    }).run();
    return db;
  }

  /** Write a reading onto the server row by hand — the shape recordAuthorizedKeysReading produces —
   *  so the delete refusal can be driven without a host. `kind` is what the line was classified as:
   *  "operator" is a line this platform placed under its marker, "foreign" the same key sitting
   *  under a comment somebody else wrote. */
  function recordKeys(db: DbHandle, fingerprints: string[], kind: "operator" | "foreign" = "operator"): void {
    db.db.update(servers).set({
      authorizedKeysState: kind === "operator" ? "accounted" : "unaccounted",
      authorizedKeysJson: {
        v: 0, observedAt: 1_700_000_000_000, runId: "run_x", unparsed: 0,
        keys: fingerprints.map((fingerprint) => ({
          fingerprint, type: "ssh-ed25519", comment: kind === "operator" ? "" : "pat@laptop",
          kind, label: kind === "operator" ? "pat" : null,
        })),
      },
    }).where(eq(servers.id, "srv_1")).run();
  }

  it("stores the key line without the operator's own comment, and fingerprints it", () => {
    const db = setup();
    const view = createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A} pat@example.com` });
    // The stored line's comment slot is empty because the comment on the PLACED line is the marker,
    // and a line has only one. The ROW carries the line; the view does not — nothing in the browser
    // reads a key body, and the run that places one loads the row.
    expect(loadOperatorKey(db.db, view.id).publicKey).toBe(`ssh-ed25519 ${BLOB_A}`);
    expect(view.type).toBe("ssh-ed25519");
    expect(view.fingerprint).toBe(PAT_FP);
    expect(loadOperatorKey(db.db, view.id).label).toBe("pat");
  });

  it("refuses a label that could not be interpolated into the removal pattern", () => {
    const db = setup();
    for (const label of ["Pat", "pat laptop", "pat.*", "a:b"]) {
      expect(() => createOperatorKey(db.db, "op_me", { label, publicKey: `ssh-ed25519 ${BLOB_A}` }), label)
        .toThrowError(/not a usable label/);
    }
  });

  it("refuses anything that is not one usable public key", () => {
    const db = setup();
    const bad = (publicKey: string): unknown => () => createOperatorKey(db.db, "op_me", { label: "pat", publicKey });
    expect(bad("hello")).toThrowError(/single OpenSSH public key line/);
    expect(bad(`ssh-ed25519 ${BLOB_A}\nssh-ed25519 ${BLOB_B}`)).toThrowError(/single OpenSSH public key line/);
    // OpenSSH has disabled ssh-dss by default since 7.0: the host would take the line into the file
    // and still refuse the login, which looks exactly like a placement that worked.
    expect(bad(`ssh-dss ${BLOB_A}`)).toThrowError(/disabled by default/);
  });

  it("keeps one row per label and one per key", () => {
    const db = setup();
    createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A}` });
    // A second row under the same label would make the label name two lines on a host.
    expect(() => createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_B}` }))
      .toThrowError(/already stored/);
    // The same key under a second label would put two lines carrying it on every host, and removing
    // one would leave the other granting access.
    expect(() => createOperatorKey(db.db, "op_me", { label: "sam", publicKey: `ssh-ed25519 ${BLOB_A}` }))
      .toThrowError(/already stored/);
  });

  it("says which servers hold a key from their READINGS, never from a ledger of placements", () => {
    const db = setup();
    const view = createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A}` });
    // Nothing has read the host yet: not "absent", simply not known.
    expect(listOperatorKeys(db.db).find((k) => k.id === view.id)?.onServerIds).toEqual([]);
    recordKeys(db, [PAT_FP]);
    expect(listOperatorKeys(db.db).find((k) => k.id === view.id)?.onServerIds).toEqual(["srv_1"]);
    // A reinstall wipes the file; the next reading is what says so, and the row follows it.
    recordKeys(db, []);
    expect(listOperatorKeys(db.db).find((k) => k.id === view.id)?.onServerIds).toEqual([]);
  });

  it("refuses to forget a key the last reading still finds on a host", () => {
    const db = setup();
    const view = createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A}` });
    recordKeys(db, [PAT_FP]);
    // Deleting the row touches no machine, and the removal run kind needs the row to name the line —
    // so a row deleted now leaves a working key nothing here can take off.
    expect(() => deleteOperatorKey(db.db, "op_me", view.id)).toThrowError(/s1/);
    expect(() => deleteOperatorKey(db.db, "op_me", view.id)).toThrowError(/with an operator-key-remove run first/);
    recordKeys(db, []);
    deleteOperatorKey(db.db, "op_me", view.id);
    expect(listOperatorKeys(db.db)).toEqual([]);
  });

  it("names a HAND edit when the line carrying the key is one no act here can reach", () => {
    const db = setup();
    const view = createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A}` });
    // The colleague's own ssh-copy-id line: same key, a comment this platform did not write. The
    // removal deletes by marker, so it does not reach this line — and telling the operator to
    // "remove it from those servers" would name an act that cannot do it.
    recordKeys(db, [PAT_FP], "foreign");
    expect(() => deleteOperatorKey(db.db, "op_me", view.id)).toThrowError(/deleted on the host itself/);
    expect(() => deleteOperatorKey(db.db, "op_me", view.id)).not.toThrowError(/operator-key-remove run/);
  });

  // The two documents that EXIST on the row and say nothing this build can use. They are not the same
  // as no reading: the row was written by a run that did look at the file, so the key may well be in
  // it — and the delete is what cannot be taken back, because the label the removal keys on goes with
  // the row. The card for such a host already says "reading unreadable"; the refusal has to agree.
  for (const [what, doc] of [
    ["a version this build does not read", { v: 1, observedAt: 1, runId: "run_x", keys: [], unparsed: 0 }],
    ["a document that fails its own schema", { v: 0, observedAt: 1, runId: "run_x" }],
  ] as const) {
    it(`refuses to forget a key while a host's reading is ${what}`, () => {
      const db = setup();
      const view = createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A}` });
      db.db.update(servers).set({ authorizedKeysState: "accounted", authorizedKeysJson: doc }).where(eq(servers.id, "srv_1")).run();

      expect(() => deleteOperatorKey(db.db, "op_me", view.id)).toThrowError(/cannot be established from here/);
      expect(() => deleteOperatorKey(db.db, "op_me", view.id)).toThrowError(/read that server again first/);
      expect(loadOperatorKey(db.db, view.id).id).toBe(view.id); // still there
      // And the list does not claim the key IS on it either — an undecided host is neither.
      expect(listOperatorKeys(db.db).find((k) => k.id === view.id)?.onServerIds).toEqual([]);

      // A fresh, readable reading decides it, and the delete goes through.
      recordKeys(db, []);
      deleteOperatorKey(db.db, "op_me", view.id);
      expect(listOperatorKeys(db.db)).toEqual([]);
    });
  }

  it("places under the marker the removal matches, and never under the manager's", () => {
    const db = setup();
    const view = createOperatorKey(db.db, "op_me", { label: "pat", publicKey: `ssh-ed25519 ${BLOB_A}` });
    expect(operatorKeyMarker(view.label)).toBe("hostyour-operator:pat");
    expect(operatorKeyMarker(view.label).includes("hostyour:")).toBe(false);
  });
});
