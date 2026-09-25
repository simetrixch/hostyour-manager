import { randomInt } from "node:crypto";
import { monotonicFactory } from "ulid";
import { GUID_ALPHABET } from "../../shared/tenant.ts";

/**
 * THE ONE ANSWER THIS PLATFORM GIVES FOR A TIED TIMESTAMP. Every row minted here carries its own
 * order in its id, so a trail sorts by `id` and needs no second key.
 *
 * A plain `ulid()` cannot do that. Its first 10 characters encode the millisecond and the remaining
 * 16 are fresh randomness on every call, so two ids drawn inside one millisecond sort by a coin
 * toss — measured at 50% inversion over 196,604 same-millisecond pairs. Every timestamp column
 * beside these ids has the same millisecond resolution and ties with them, so neither breaks the
 * other's tie. `monotonicFactory()` keeps the millisecond prefix and increments the random part
 * instead of redrawing it whenever the clock has not moved, so ids from one factory rise with
 * every call and follow the clock once it moves.
 *
 * WHAT THE GUARANTEE RESTS ON, so a reader can see when it stops holding: ONE factory per process.
 * A second process writing the same rows draws from its own factory, and two factories that land
 * on the same millisecond order by the coin toss again. SQLite's `rowid` would be exact across
 * writers — it is the table's own insert counter — but it is not selected onto the row a caller is
 * handed, so an operator typing ORDER BY id, a caller sorting rows it already holds, or an export
 * cannot reach it. The id is what TRAVELS, which is why the order is put into it.
 *
 * The one job that opens a second handle on the manager's SQLite file is jobs/registry-reaper.ts:79
 * — it builds a CredentialStore, which writes `credential.used` audit rows. It reaches a DIFFERENT
 * file only because that job runs with an emptyDir DATA_DIR (config.ts dbFile = DATA_DIR/manager.db),
 * which is a property of the deployment and not something this repository holds.
 *
 * These ids are ROW ids and never a capability: nothing authenticates by holding one. Every secret
 * this platform mints is drawn from node:crypto randomBytes instead (security/store.ts,
 * domains/access/session.ts, domains/units/secret-mint.ts), so a monotonic id gives a guesser
 * nothing that a plain one did not.
 */
const mint = monotonicFactory();

/** A prefixed, monotonic ULID: sortable by creation time down to the write, self-describing in logs. */
export const newId = (prefix: string): string => `${prefix}_${mint()}`;

export const srvId = (): string => newId("srv");
export const clsId = (): string => newId("cls");
export const appId = (): string => newId("app");
export const credId = (): string => newId("cred");
export const runId = (): string => newId("run");
export const stepId = (): string => newId("step");
export const evtId = (): string => newId("evt");
export const opId = (): string => newId("op");
export const opkId = (): string => newId("opk");

// Tenant inventory row minters (server/db/schema/inventory.ts: tenants / tenant_apps). Prefixed
// ULIDs like the minters above — distinct from mintTenantGuid(), which mints the tenant's identity
// guid (its namespace/AppProject), whereas these mint the DB row ids.
export const tenantId = (): string => newId("tnt");
export const tenantAppId = (): string => newId("tna");

/** A tenant guid: 12 chars drawn from GUID_ALPHABET (Crockford base32 minus i/l/o/u) via a CSPRNG
 *  (crypto.randomInt). Unlike the prefixed-ULID minters above, a tenant's guid is its SOLE identity
 *  (every member namespace and AppProject is <guid>-<member>) and carries no prefix. Server-side only —
 *  node:crypto is
 *  not browser-safe, and shared/ is imported by the web bundle. Collision-checking a candidate
 *  against the registrations tree is the create-tenant run's job; this only mints candidates. */
export const mintTenantGuid = (): string => {
  let out = "";
  for (let i = 0; i < 12; i++) out += GUID_ALPHABET.charAt(randomInt(GUID_ALPHABET.length));
  return out;
};
