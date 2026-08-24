import { describe, it, expect } from "vitest";
import { CONSUMER_RUN_KINDS, TENANT_RUN_KINDS } from "./runKinds.ts";
import type { RunKind } from "../../shared/enums.ts";

// The Consumers right tab filters the ONE shared runs list to the consumer lifecycle family. The
// load-bearing rule is that it filters by KIND, never by targetId — an onboard run targets the
// CLUSTER (targetKind "cluster"), so a targetId filter would silently drop every onboard run.

describe("CONSUMER_RUN_KINDS", () => {
  it("is exactly the consumer lifecycle kinds (incl. purge — force-offboard by name — adopt-consumer — row reconstruction from the registration — restart-workloads and the relocation run kinds backup/restore/migrate)", () => {
    expect([...CONSUMER_RUN_KINDS].sort()).toEqual(["consumer-adopt", "consumer-backup", "consumer-migrate", "consumer-offboard", "consumer-onboard", "consumer-purge", "consumer-restart-workloads", "consumer-restore", "consumer-resume", "consumer-set-size", "consumer-suspend"]);
  });

  it("keeps onboard — the run that targets a cluster, not the app (would vanish under a targetId filter)", () => {
    expect(CONSUMER_RUN_KINDS.has("consumer-onboard")).toBe(true);
  });

  it("keeps every consumer lifecycle run kind", () => {
    for (const k of ["consumer-onboard", "consumer-offboard", "consumer-purge", "consumer-adopt", "consumer-suspend", "consumer-resume", "consumer-restart-workloads", "consumer-set-size", "consumer-backup", "consumer-restore", "consumer-migrate"] as const) {
      expect(CONSUMER_RUN_KINDS.has(k)).toBe(true);
    }
  });

  it("rejects tenant + infra + fixture kinds — the section owns only its own family", () => {
    for (const k of ["tenant-create", "tenant-add-app", "tenant-offboard", "tenant-restart-workloads", "tenant-set-size", "cluster-deploy-slave", "cluster-redeploy", "cluster-release", "cluster-adopt", "noop"] as const satisfies readonly RunKind[]) {
      expect(CONSUMER_RUN_KINDS.has(k)).toBe(false);
    }
  });
});

// The Tenants right tab filters the same shared runs list to the TENANT lifecycle family (the TNT
// block). Same load-bearing rule: it filters by KIND, never by targetId — a create-tenant run targets
// the CLUSTER (targetKind "cluster"), so a targetId filter would silently drop every create-tenant run.

describe("TENANT_RUN_KINDS", () => {
  it("is exactly the tenant lifecycle kinds (create + add/remove-app + suspend/resume/offboard + purge + backup/restore/migrate + the administrator check)", () => {
    expect([...TENANT_RUN_KINDS].sort()).toEqual(["tenant-add-app", "tenant-backup", "tenant-check", "tenant-create", "tenant-migrate", "tenant-offboard", "tenant-purge", "tenant-remove-app", "tenant-restart-workloads", "tenant-restore", "tenant-resume", "tenant-set-size", "tenant-suspend"]);
  });

  it("keeps check-tenants — it targets no tenant row, so only a kind filter surfaces it", () => {
    // Same reason create-tenant and tenant-purge are here: the run is over EVERY tenant and
    // therefore targets the manager, so a targetId filter would drop it off the page entirely.
    expect(TENANT_RUN_KINDS.has("tenant-check")).toBe(true);
  });

  it("keeps create-tenant — the run that targets a cluster, not the tenant (would vanish under a targetId filter)", () => {
    expect(TENANT_RUN_KINDS.has("tenant-create")).toBe(true);
  });

  it("keeps every tenant lifecycle run kind", () => {
    for (const k of ["tenant-create", "tenant-add-app", "tenant-remove-app", "tenant-suspend", "tenant-resume", "tenant-restart-workloads", "tenant-set-size", "tenant-offboard", "tenant-purge", "tenant-backup", "tenant-restore", "tenant-migrate"] as const) {
      expect(TENANT_RUN_KINDS.has(k)).toBe(true);
    }
  });

  it("rejects consumer + infra + fixture kinds — the section owns only its own family", () => {
    for (const k of ["consumer-onboard", "consumer-offboard", "consumer-suspend", "consumer-resume", "consumer-restart-workloads", "consumer-set-size", "consumer-purge", "consumer-adopt", "cluster-deploy-slave", "cluster-redeploy", "cluster-release", "cluster-adopt", "noop"] as const satisfies readonly RunKind[]) {
      expect(TENANT_RUN_KINDS.has(k)).toBe(false);
    }
  });
});
