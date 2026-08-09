import { randomInt } from "node:crypto";
import { ulid } from "ulid";
import { GUID_ALPHABET } from "../../shared/tenant.ts";

// Prefixed ULIDs: sortable by creation time, self-describing in logs.
export const newId = (prefix: string): string => `${prefix}_${ulid()}`;

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
