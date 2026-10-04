// create-tenant's tenants and tenant_apps rows: the one writer both record steps share, split out of
// create-tenant.run.ts like the registration composer (create-tenant-registration.ts).
import { and, eq } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { tenantId as mintTenantRowId, tenantAppId as mintTenantAppId } from "../../kernel/ids.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import { localTx } from "../../executor/stepkit.ts";
import type { CreateTenantParams } from "./create-tenant.run.ts";

/** WHICH of create-tenant's two inventory writes is running. Named once, as one value, so it can never
 *  degenerate into a pair of booleans a caller could combine into a nonsense state:
 *   - "provisional" — record-provisional, BEFORE any mutation: records INTENT (status "provisioning").
 *   - "settled"     — record-inventory, after the fan-out is live: records SUCCESS (status "active"). */
export type TenantRecordPhase = "provisional" | "settled";

/** The ONE writer of the tenants + tenant_apps rows, shared by both record steps so "what the run
 *  intends" and "what the run achieved" can never drift into two different row shapes. Overwrite-
 *  idempotent on (guid, stage) and (tenantId, name), in ONE tx so a crash leaves it resumable: every
 *  DESCRIPTIVE column (the subdomain, the seed flag, the owner) is rewritten in both phases, because a
 *  resume must converge the row onto the params it is actually running.
 *
 *  The row's LIFECYCLE STATE is the deliberate exception — `status` plus `suspended`, which is its flat
 *  projection for the appset selector and which tenant-suspend/-resume move in lock-step with it, so the
 *  two are written as ONE unit and never separately. That unit is written on INSERT in both phases, but
 *  on UPDATE only when SETTLING. A resumed run re-runs record-provisional against a row record-inventory
 *  may ALREADY have lifted to "active" (or a later tenant-suspend moved to "suspended"), and demoting a
 *  live tenant back to "provisioning" would paint it as unfinished, hide its live actions behind the
 *  provisional refusals and pull it out of the reconciliation view. Insert-only is therefore not an
 *  optimisation, it is the correctness rule.
 *  Returns the tenants row id (the caller logs it — it is the handle every removal run kind needs). */
export function upsertTenantInventory(ctx: StepCtx, p: CreateTenantParams, phase: TenantRecordPhase): string {
  const settle = phase === "settled";
  const status: TenantStatus = settle ? "active" : "provisioning";
  const lifecycle = { status, suspended: false }; // the unit above — a fresh tenant is never suspended
  return localTx(ctx, (tx) => {
    const existing = tx.select().from(tenants).where(and(eq(tenants.guid, p.guid), eq(tenants.stage, p.stage))).get();
    const values = {
      clusterId: p.clusterId, guid: p.guid, subdomain: p.subdomain, stage: p.stage,
      // Every later path that reaches the IdP holds a row, not the manifest.
      //
      // The row records the STANDING members only, which is why the app names are filtered out: an
      // app's presence is the tenant_apps row and its status, and a member list that also carried the
      // apps would drift the moment one was offboarded. Every reader unions the two (tenantWatchSet,
      // the tenant card, the relocation world), so the app names are never lost — they are just kept
      // where their status lives. Derived from the two fields rather than carried as a third, which
      // could drift out of step with them.
      identityProvider: p.identityProvider, members: p.members.map((m) => m.name).filter((n) => !p.apps.some((a) => a.name === n)),
      routing: p.routing,
      ...(p.ownDomain ? { ownDomain: p.ownDomain, ownDomainRedirects: p.ownDomainRedirects ?? [] } : {}),
      seedUsers: p.seedUsers,
      owner: p.owner, provenance: "manager" as const,
      lastRunId: ctx.runId, updatedAt: new Date(),
    };
    const rowId = existing?.id ?? mintTenantRowId();
    if (existing) tx.update(tenants).set({ ...values, ...(settle ? lifecycle : {}) }).where(eq(tenants.id, existing.id)).run();
    else tx.insert(tenants).values({ id: rowId, ...values, ...lifecycle }).run();
    for (const a of p.apps) {
      const ex = tx.select().from(tenantApps).where(and(eq(tenantApps.tenantId, rowId), eq(tenantApps.name, a.name))).get();
      if (ex) tx.update(tenantApps).set({ lastRunId: ctx.runId, ...(settle ? { status } : {}) }).where(eq(tenantApps.id, ex.id)).run();
      else tx.insert(tenantApps).values({ id: mintTenantAppId(), tenantId: rowId, name: a.name, status, lastRunId: ctx.runId }).run();
    }
    return rowId;
  });
}
