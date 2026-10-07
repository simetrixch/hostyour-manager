import type { Db } from "../../../db/client.ts";
import type { StepCtx, RunDefinition, Plan, Cleanup } from "../../../executor/types.ts";
import { getRun, getRunParams } from "../../../executor/read.ts";
import { errInternal, errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { InstallationDomainParamsSchema, InstallationDomainRollbackParamsSchema, type InstallationDomainParams, type InstallationDomainRollbackParams, type InstallationDomainSnapshot } from "../../../../shared/installation-domain.ts";

export interface InstallationDomainActions {
  read(db: Db, from: string, to: string, signal?: AbortSignal): Promise<InstallationDomainSnapshot>;
  validateRollback(ctx: StepCtx, snapshot: InstallationDomainSnapshot, sourceRunId: string): Promise<void>;
  apply(ctx: StepCtx, snapshot: InstallationDomainSnapshot, reverse: boolean, sourceRunId: string): Promise<void>;
  // The service issuers at the tenants' own sender domains, which move with the installation
  // (server/domains/units/installation-domain-issuers.ts).
  bindIssuers(ctx: StepCtx, snapshot: InstallationDomainSnapshot, which: "after" | "before"): Promise<void>;
  watchTenantZones(ctx: StepCtx, snapshot: InstallationDomainSnapshot, which: "after" | "before"): Promise<void>;
  unbindIssuers(ctx: StepCtx, snapshot: InstallationDomainSnapshot, which: "after" | "before"): Promise<void>;
  issuerCleanups(snapshot: InstallationDomainSnapshot): Cleanup[];
}

function actions(value: InstallationDomainActions | undefined): InstallationDomainActions {
  if (!value) throw errNotConfigured("installation domain actions are not configured");
  return value;
}

function frozen(snapshot: InstallationDomainSnapshot | undefined): InstallationDomainSnapshot {
  if (!snapshot) throw errValidation("the run has no recorded domain plan");
  return snapshot;
}

function plan(kind: string, snapshot: InstallationDomainSnapshot, dryRun: boolean): Plan {
  const isRollback = kind === "installation-domain-rollback";
  const mutatingSteps = isRollback
    ? [
        { name: "bind-previous-issuers", title: "Bind previous service token issuers at sender domains" },
        { name: "move-unit-domains", title: "Restore only the recorded unit records and domain fields" },
        { name: "watch-tenant-zones", title: "Wait until every tenant member renders its previous zone" },
        { name: "unbind-new-issuers", title: "Remove new service token issuers from sender domains" },
      ]
    : [
        { name: "bind-new-issuers", title: "Bind new service token issuers at sender domains" },
        { name: "move-unit-domains", title: "Move only the recorded unit records and domain fields" },
        { name: "watch-tenant-zones", title: "Wait until every tenant member renders its new zone" },
        { name: "unbind-previous-issuers", title: "Remove previous service token issuers from sender domains" },
      ];
  return { kind, targetKind: "installation", targetId: snapshot.booksBranch,
    summary: `${dryRun ? "Dry run" : "Unit domain phase"}: ${snapshot.fromDomain} → ${snapshot.toDomain}; ${snapshot.records.length} records, ${snapshot.registrations.length} registrations, ${snapshot.tenants.length} tenant issuer/cookie effects. Old records retained. External store and session coverage is stated in the preview.`,
    steps: [{ name: "attest-target", title: dryRun ? "Read and report the frozen domain preview" : (isRollback ? "Validate every recorded inverse before any write" : "Check the frozen domain plan before any write") }, ...(dryRun ? [] : mutatingSteps)],
    targets: [], locks: [{ resource: "git-branch", key: snapshot.booksBranch }, { resource: "master-kube", key: "m" }, ...[...new Set(snapshot.clusters.map(c => c.serverId))].map(key => ({ resource: "server" as const, key }))],
    requiredSecrets: [], warnings: [...snapshot.blockers, "Everyone signs in once on the new hosts: no session is carried over.", "No machine rename, old-record retirement or mail change is performed; each old unit host redirects to its new one."] };
}

function compensation(value: InstallationDomainActions | undefined, snapshot: InstallationDomainSnapshot): Cleanup {
  return { name: "restore-unit-domains", title: "Restore this run's unit domain fields and new records", run: ctx => actions(value).apply(ctx, snapshot, true, ctx.runId) };
}

export function makeInstallationDomainDef(value: InstallationDomainActions | undefined): RunDefinition<InstallationDomainParams> {
  return {
    kind: "installation-domain-move", paramsSchema: InstallationDomainParamsSchema, mutating: true,
    plan: async () => { throw errInternal("installation-domain-move uses a streaming plan"); },
    planStream: async (raw, ctx) => {
      const params = InstallationDomainParamsSchema.parse(raw);
      const snapshot = await actions(value).read(ctx.db, params.fromDomain, params.toDomain, ctx.signal);
      ctx.log(JSON.stringify(snapshot));
      return { outcome: "planned", params: { ...params, snapshot }, plan: plan("installation-domain-move", snapshot, params.dryRun) };
    },
    assertApprovable: async params => {
      if (!params.dryRun && frozen(params.snapshot).blockers.length) throw errValidation("the domain plan has cutover blockers; only its dry run can be approved");
    },
    steps: params => [{ name: "attest-target", title: "Check and report the domain plan", run: async ctx => {
      const snapshot = frozen(params.snapshot);
      const current = await actions(value).read(ctx.db, params.fromDomain, params.toDomain, ctx.signal);
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw errValidation("installation domain data changed since planning; ask for a fresh plan");
      if (!params.dryRun && current.blockers.length) throw errValidation("the machine/session preflight still has blockers");
      ctx.log("meta", JSON.stringify(snapshot));
    } }, ...(params.dryRun ? [] : [
      { name: "bind-new-issuers", title: "Bind new service token issuers at sender domains", run: async (ctx: StepCtx) => {
        await actions(value).bindIssuers(ctx, frozen(params.snapshot), "after");
      } },
      { name: "move-unit-domains", title: "Move the recorded unit domain fields", run: async (ctx: StepCtx) => {
        const snapshot = frozen(params.snapshot);
        ctx.registerCleanup(compensation(value, snapshot));
        await actions(value).apply(ctx, snapshot, false, ctx.runId);
      } },
      { name: "watch-tenant-zones", title: "Wait until every tenant member renders its new zone", run: async (ctx: StepCtx) => {
        await actions(value).watchTenantZones(ctx, frozen(params.snapshot), "after");
      } },
      { name: "unbind-previous-issuers", title: "Remove previous service token issuers from sender domains", run: async (ctx: StepCtx) => {
        await actions(value).unbindIssuers(ctx, frozen(params.snapshot), "before");
      } },
    ])],
    cleanups: params => params.dryRun || !params.snapshot ? [] : [compensation(value, params.snapshot), ...actions(value).issuerCleanups(params.snapshot)],
  };
}

export function makeInstallationDomainRollbackDef(value: InstallationDomainActions | undefined): RunDefinition<InstallationDomainRollbackParams> {
  return {
    kind: "installation-domain-rollback", paramsSchema: InstallationDomainRollbackParamsSchema, mutating: true,
    plan: async () => { throw errInternal("installation-domain-rollback uses a streaming plan"); },
    planStream: async (raw, ctx) => {
      const params = InstallationDomainRollbackParamsSchema.parse(raw), source = getRunParams(ctx.db, params.sourceRunId), state = getRun(ctx.db, params.sourceRunId);
      if (source?.kind !== "installation-domain-move" || !state || !["succeeded", "failed", "cancelled"].includes(state.status)) throw errValidation("rollback requires a stopped installation domain move");
      const original = InstallationDomainParamsSchema.parse(source.params);
      if (original.dryRun) throw errValidation("a dry run changed no domain data and has nothing to roll back");
      const snapshot = frozen(original.snapshot);
      ctx.log(JSON.stringify({ rollbackOf: params.sourceRunId, dryRun: params.dryRun, snapshot }));
      const result = plan("installation-domain-rollback", snapshot, params.dryRun);
      result.summary = `${params.dryRun ? "Dry-run rollback" : "Rollback"} of ${params.sourceRunId}: restore only its recorded values; refuse any conflicting newer writer.`;
      return { outcome: "planned", params: { ...params, snapshot }, plan: result };
    },
    steps: params => [{ name: "attest-target", title: "Validate every recorded inverse before any write", run: async ctx => {
      const source = getRun(ctx.db, params.sourceRunId), original = getRunParams(ctx.db, params.sourceRunId);
      if (!source || !["succeeded", "failed", "cancelled"].includes(source.status) || original?.kind !== "installation-domain-move") throw errValidation("the source move is no longer stopped; rollback refuses");
      const recorded = InstallationDomainParamsSchema.parse(original.params);
      if (recorded.dryRun || JSON.stringify(recorded.snapshot) !== JSON.stringify(frozen(params.snapshot))) throw errValidation("the recorded move journal changed; rollback refuses");
      await actions(value).validateRollback(ctx, frozen(params.snapshot), params.sourceRunId);
      ctx.log("meta", JSON.stringify(frozen(params.snapshot)));
    } }, ...(params.dryRun ? [] : [
      { name: "bind-previous-issuers", title: "Bind previous service token issuers at sender domains", run: async (ctx: StepCtx) => {
        await actions(value).bindIssuers(ctx, frozen(params.snapshot), "before");
      } },
      { name: "move-unit-domains", title: "Restore the recorded unit domain fields", run: async (ctx: StepCtx) => {
        await actions(value).apply(ctx, frozen(params.snapshot), true, params.sourceRunId);
      } },
      { name: "watch-tenant-zones", title: "Wait until every tenant member renders its previous zone", run: async (ctx: StepCtx) => {
        await actions(value).watchTenantZones(ctx, frozen(params.snapshot), "before");
      } },
      { name: "unbind-new-issuers", title: "Remove new service token issuers from sender domains", run: async (ctx: StepCtx) => {
        await actions(value).unbindIssuers(ctx, frozen(params.snapshot), "after");
      } },
    ])],
  };
}
