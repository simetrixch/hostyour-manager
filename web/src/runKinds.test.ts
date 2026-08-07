import { describe, it, expect } from "vitest";
import { CONSUMER_RUN_KINDS, TENANT_RUN_KINDS } from "./runKinds.ts";
import type { RunKind } from "../../shared/enums.ts";

// The Consumers right tab filters the ONE shared runs list to the consumer lifecycle family. The
// load-bearing rule is that it filters by KIND, never by targetId — an onboard run targets the
// CLUSTER (targetKind "cluster"), so a targetId filter would silently drop every onboard run.

describe("CONSUMER_RUN_KINDS", () => {
  it("is exactly the consumer lifecycle kinds (incl. purge — force-offboard by name — adopt-consumer — row reconstruction from the registration — restart-workloads and the relocation verbs backup/restore/migrate)", () => {
    expect([...CONSUMER_RUN_KINDS].sort()).toEqual(["adopt-consumer", "backup", "migrate", "offboard", "onboard", "purge", "restart-workloads", "restore", "resume", "set-size", "suspend"]);
  });

  it("keeps onboard — the run that targets a cluster, not the app (would vanish under a targetId filter)", () => {
    expect(CONSUMER_RUN_KINDS.has("onboard")).toBe(true);
  });

  it("keeps every consumer lifecycle verb", () => {
    for (const k of ["onboard", "offboard", "purge", "adopt-consumer", "suspend", "resume", "restart-workloads", "set-size", "backup", "restore", "migrate"] as const) {
      expect(CONSUMER_RUN_KINDS.has(k)).toBe(true);
    }
  });

  it("rejects tenant + infra + fixture kinds — the section owns only its own family", () => {
    for (const k of ["create-tenant", "add-app", "tenant-offboard", "tenant-restart-workloads", "tenant-set-size", "deploy-slave", "redeploy", "release", "adopt", "noop"] as const satisfies readonly RunKind[]) {
      expect(CONSUMER_RUN_KINDS.has(k)).toBe(false);
    }
  });
});

// The Tenants right tab filters the same shared runs list to the TENANT lifecycle family (the TNT
// block). Same load-bearing rule: it filters by KIND, never by targetId — a create-tenant run targets
// the CLUSTER (targetKind "cluster"), so a targetId filter would silently drop every create-tenant run.

describe("TENANT_RUN_KINDS", () => {
  it("is exactly the tenant lifecycle kinds (create + add/remove-app + suspend/resume/offboard + purge + backup/restore/migrate + the administrator check)", () => {
    expect([...TENANT_RUN_KINDS].sort()).toEqual(["add-app", "check-tenants", "create-tenant", "remove-app", "tenant-backup", "tenant-migrate", "tenant-offboard", "tenant-purge", "tenant-restart-workloads", "tenant-restore", "tenant-resume", "tenant-set-size", "tenant-suspend"]);
  });

  it("keeps check-tenants — it targets no tenant row, so only a kind filter surfaces it", () => {
    // Same reason create-tenant and tenant-purge are here: the run is over EVERY tenant and
    // therefore targets the controller, so a targetId filter would drop it off the page entirely.
    expect(TENANT_RUN_KINDS.has("check-tenants")).toBe(true);
  });

  it("keeps create-tenant — the run that targets a cluster, not the tenant (would vanish under a targetId filter)", () => {
    expect(TENANT_RUN_KINDS.has("create-tenant")).toBe(true);
  });

  it("keeps every tenant lifecycle verb", () => {
    for (const k of ["create-tenant", "add-app", "remove-app", "tenant-suspend", "tenant-resume", "tenant-restart-workloads", "tenant-set-size", "tenant-offboard", "tenant-purge", "tenant-backup", "tenant-restore", "tenant-migrate"] as const) {
      expect(TENANT_RUN_KINDS.has(k)).toBe(true);
    }
  });

  it("rejects consumer + infra + fixture kinds — the section owns only its own family", () => {
    for (const k of ["onboard", "offboard", "suspend", "resume", "restart-workloads", "set-size", "purge", "adopt-consumer", "deploy-slave", "redeploy", "release", "adopt", "noop"] as const satisfies readonly RunKind[]) {
      expect(TENANT_RUN_KINDS.has(k)).toBe(false);
    }
  });
});
