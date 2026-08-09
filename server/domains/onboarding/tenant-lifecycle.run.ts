import { z } from "zod";
import { eq, and, notInArray } from "drizzle-orm";
import type { RunDefinition, Step, LockClaim } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { appName } from "../../../shared/tenant.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { errValidation, errNotFound } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import type { ArgoAppStatusMap, WorkloadStatus } from "../../adapters/kube/port.ts";
import { TENANT_LABEL_KEY, memberApplication, memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import type { TenantRegistry } from "./tenant-registry.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";

// tenant-suspend / tenant-resume / remove-app — the
// tenant (multi-app fan-out) analogues of the consumer suspend/resume/offboard runs (suspend-resume.
// run.ts / offboard.run.ts). No gate-runner: they flip/drop the ONE registration and wait for the
// target ArgoCD to reconcile the fan-out, so they fit the standard synchronous plan() path. Each is
// mutating ⇒ attest-target is its first step. Two shapes differ from the consumer runs:
//   1. A SUSPEND SWITCHES OFF, IT DOES NOT PRUNE. setTenantSuspended flips a FIELD; the registration
//      stays at its one path, every member Application keeps being generated and stays Synced/Healthy,
//      and the charts render the off state — replicas 0 and no Ingress. Pruning instead would be
//      DESTRUCTIVE by construction: the member charts render ServiceClaims whose deprovision finalizer
//      runs on EVERY claim deletion, an ArgoCD prune included, and drops the user AND the databases.
//      So the suspend watch waits for the members to CONVERGE (watch-off), never for them to vanish,
//      and what survives is trivially defined: everything except running pods and public reach.
//   2. The watch is a SET watch (watchApplicationSet) over the fan-out's EXPECTED Application names —
//      tenantWatchSet computes them from inventory via tenant-fanout (the single source of truth for
//      names; a hand-rolled name ArgoCD never creates hangs the watch forever). remove-app prunes ONLY
//      the dropped member's Application — never a sibling.
// tenant-offboard lives in its own file (offboard-tenant.run.ts) for the 400-line budget; it reuses
// the shared helpers exported here.

export const TenantLifecycleParams = z.object({ tenantId: z.string().startsWith("tnt_") });
export type TenantLifecycleParams = z.infer<typeof TenantLifecycleParams>;

/** remove-app additionally names WHICH app of the guid × apps[] matrix to drop (a tenant app label). */
export const RemoveAppParams = z.object({ tenantId: z.string().startsWith("tnt_"), app: appName });
export type RemoveAppParams = z.infer<typeof RemoveAppParams>;

// Every tenant run writes catalog's tenant registrations, which stand on THIS installation's
// books branch — a per-installation value, so the lock claim is computed from the registry that does
// the writing rather than stated as a constant. It is repo-qualified because the same branch NAME
// exists in hostyour-cloud, where it carries the consumer registrations and the cluster maps: two
// repositories, two branches, two locks. The master-kube "m" lock is shared with every
// consumer/tenant run (one master, one ArgoCD).
const masterKubeLock: LockClaim = { resource: "master-kube", key: "m" };
export const tenantLocks = (registry: TenantRegistry): LockClaim[] => [
  { resource: "git-branch", key: `catalog@${registry.branch}` },
  masterKubeLock,
];

/** The label selector the set-watch filters the Application list by, and the one a teardown reaps
 *  namespaces by — every member Application and every member NAMESPACE of a tenant carries
 *  platform/tenant=<guid>. */
export const tenantSelector = (guid: string): string => `${TENANT_LABEL_KEY}=${guid}`;

/** The EXPECTED fan-out Application names for a tenant, computed from inventory (the faithful DB
 *  projection of the registration, written in lock-step by create-tenant/add-app/remove-app): the trio
 *  ALWAYS, then one <guid>-<app>-<stage> per NOT-YET-OFFBOARDED tenant_apps row. Never hand-rolled —
 *  delegates to tenantApplicationSet (tenant-fanout is the single source of truth for names). Computed
 *  from the DB (not the registration) so it still resolves after tenant-offboard git-rm'd the file.
 *
 *  The app filter is "everything except a SETTLED row", NOT "active": since
 *  create-tenant records its rows BEFORE it deploys, a half-created tenant's app rows sit at
 *  "provisioning" — yet the appset generated their Applications the moment the pointer landed, so they
 *  are every bit as deployed as an active tenant's. Filtering on "active" would silently shrink the set
 *  and let a tenant-offboard of a provisional tenant declare the prune complete while those very
 *  Applications keep running. Only a settled row is genuinely gone — "offboarded" (removed) or
 *  "purged" (deprovisioned), asked as the one named set TENANT_SETTLED_STATUS
 *  (shared/enums.ts) so the newer state cannot re-enter a watch set as a name ArgoCD will never create.
 *
 *  It takes only the three TenantCluster fields it actually reads, so the POINTER-driven resolver
 *  (tenant-replace.ts:resolveTeardownTarget) can call it too: that one holds a tenants row but no
 *  cluster join, and it needs this very set whenever the pointer the names would otherwise come from is
 *  already git-rm'd. A full TenantCluster still satisfies the parameter, so the row-driven runs below
 *  are unchanged. */
export function tenantWatchSet(db: Db, tc: Pick<TenantCluster, "tenantId" | "guid" | "stage">): string[] {
  const row = db.select().from(tenants).where(eq(tenants.id, tc.tenantId)).get();
  if (!row) throw errNotFound(`tenant ${tc.tenantId}`);
  const appRows = db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, tc.tenantId), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS]))).all();
  // `row.members` is the tenant's own standing set, recorded when it was created — never a constant.
  // The apps come from their own rows so a settled one drops out of the set.
  return tenantApplicationSet([...row.members, ...appRows.map((a) => a.name)], tc.guid, tc.stage);
}

/** The MEMBERS of a tenant, from the same inventory projection the watch set uses — its standing
 *  members plus one per not-yet-settled app row. What a teardown deletes one AppProject per, and what
 *  the suspend measurement turns into namespaces. */
export function tenantWatchMembers(db: Db, tenantId: string): string[] {
  const row = db.select().from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!row) throw errNotFound(`tenant ${tenantId}`);
  const appRows = db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, tenantId), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS]))).all();
  return [...row.members, ...appRows.map((a) => a.name)];
}

/** The member NAMESPACES of a tenant — tenantWatchMembers under the one naming function. */
export function tenantWatchNamespaces(db: Db, tenantId: string, guid: string): string[] {
  return tenantWatchMembers(db, tenantId).map((m) => memberNamespace(guid, m));
}

/** Prune predicate: EVERY expected name reads health Missing (its CR is gone / never generated). An
 *  absent name maps to Missing (watchApplicationSet completeness gate), so the default is "pruned". */
export const allPruned = (names: readonly string[]) => (m: ArgoAppStatusMap): boolean =>
  names.every((n) => (m.get(n)?.health ?? "Missing") === "Missing");

/** Sync predicate: EVERY expected name is present + Synced + Healthy (a member still Missing / OutOfSync
 *  fails the whole set). syncRevision is NOT checked — the appsets track a catalog BRANCH (not a
 *  per-tenant pin) and member Applications are multi-source (revision unset), so a revision gate would
 *  never converge; the immutable pin is enforced at plan time, not the watch. */
const allSynced = (names: readonly string[]) => (m: ArgoAppStatusMap): boolean =>
  names.every((n) => {
    const s = m.get(n);
    return !!s && s.sync === "Synced" && s.health === "Healthy";
  });

/** The members that did NOT prune, for a fail message (name=health, …). */
export const lingering = (m: ArgoAppStatusMap): string =>
  [...m.entries()].filter(([, s]) => s.health !== "Missing").map(([n, s]) => `${n}=${s.health}`).join(", ") || "none";

/** The members that did NOT converge, for a fail message (name=sync/health, …). */
const notSynced = (m: ArgoAppStatusMap): string =>
  [...m.entries()]
    .filter(([, s]) => !(s.sync === "Synced" && s.health === "Healthy"))
    .map(([n, s]) => `${n}=${s.sync}/${s.health}`)
    .join(", ") || "none";

/** The OFF measurement, shared by tenant-suspend's verify step: a member namespace is switched off when
 *  it still EXISTS and every workload in it asks for ZERO replicas. `available` cannot say this — 0 of 0
 *  is available — so the desired count is what is read. Returns the workloads still asking for replicas,
 *  named, so a refusal says WHICH ones kept running. */
const stillRunning = (workloads: readonly WorkloadStatus[]): string[] =>
  workloads.filter((w) => w.desired > 0).map((w) => `${w.kind}/${w.name} (${w.ready}/${w.desired})`);

function suspendSteps(ports: TenantLifecyclePorts, params: TenantLifecycleParams): Step[] {
  const tenantId = params.tenantId;
  return [
    attestTenantTargetStep(ports, tenantId),
    {
      name: "suspend-tenant",
      title: "Flip the tenant registration to suspended",
      run: async (ctx) => {
        // A FIELD flip (setTenantSuspended): the registration stays at its one path, so every member
        // Application goes on being generated and the charts render the off state from the value.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const { commit } = await ports.registry.setTenantSuspended(tc.stage, tc.guid, true, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid} flipped to suspended on ${ports.registry.branch} (${commit}) — ArgoCD will now re-sync every member into its off state`);
      },
    },
    {
      name: "watch-off",
      title: "Wait for every member to converge on its off state",
      run: async (ctx) => {
        // NOT a prune watch. Every member Application stays Synced/Healthy through a suspend — what
        // changes is what it renders — so the wait is the SAME convergence resume waits for, and a
        // member that went Missing here would mean something pruned a tenant that was only paused.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const names = tenantWatchSet(ctx.db, tc);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const status = await argoReader.watchApplicationSet(argoNamespace, names, allSynced(names), { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: tenantSelector(tc.guid) });
        if (!allSynced(names)(status)) throw errValidation(`tenant ${tc.guid} fan-out did not converge on its off state — ${notSynced(status)}`);
        ctx.log("meta", `tenant ${tc.guid} fan-out is Synced + Healthy at its off state (${names.length} Application(s)) — every member Application, namespace, ServiceClaim and database is untouched`);
      },
    },
    {
      name: "verify-off",
      title: "Verify every member namespace is scaled to zero",
      run: async (ctx) => {
        // The measurement that makes "suspended" a fact rather than a committed intention: in EVERY
        // member namespace, every workload asks for zero replicas. A Synced/Healthy Application proves
        // ArgoCD applied the manifests, not that the manifests carry the off state — a chart that
        // ignored `suspended` would pass the watch above and go on serving.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const namespaces = tenantWatchNamespaces(ctx.db, tc.tenantId, tc.guid);
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        for (const ns of namespaces) {
          const smoke = await clusterReader.smoke(ns);
          if (!smoke.namespaceExists) throw errValidation(`namespace ${ns} does not exist — a suspend switches a tenant off, it never removes a member namespace`);
          const running = stillRunning(smoke.workloads);
          if (running.length) throw errValidation(`tenant ${tc.guid} is flagged suspended but ${ns} still runs ${running.join(", ")}`);
        }
        ctx.checkpoint({ namespaces, scaledToZero: true });
        ctx.log("meta", `tenant ${tc.guid} is off — ${namespaces.length} member namespace(s) still stand with zero replicas in each`);
      },
    },
    {
      name: "record-suspended",
      title: "Record the tenant as suspended",
      run: async (ctx) => {
        localTx(ctx, (tx) => tx.update(tenants).set({ status: "suspended", suspended: true, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run());
        ctx.log("meta", `tenant recorded as suspended (row kept)`);
      },
    },
  ];
}

function resumeSteps(ports: TenantLifecyclePorts, params: TenantLifecycleParams): Step[] {
  const tenantId = params.tenantId;
  return [
    attestTenantTargetStep(ports, tenantId),
    {
      name: "resume-tenant",
      title: "Flip the tenant registration back to active",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, tenantId);
        const { commit } = await ports.registry.setTenantSuspended(tc.stage, tc.guid, false, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid} flipped back to active on ${ports.registry.branch} (${commit}) — ArgoCD will now scale every member back up`);
      },
    },
    {
      name: "watch-sync",
      title: "Wait for ArgoCD to re-sync the tenant fan-out at the pinned commit",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, tenantId);
        const names = tenantWatchSet(ctx.db, tc);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const status = await argoReader.watchApplicationSet(argoNamespace, names, allSynced(names), { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: tenantSelector(tc.guid) });
        if (!allSynced(names)(status)) throw errValidation(`tenant ${tc.guid} fan-out did not reach Synced/Healthy — ${notSynced(status)}`);
        ctx.log("meta", `tenant ${tc.guid} fan-out is Synced + Healthy (${names.length} Application(s)) — the tenant is live again`);
      },
    },
    {
      name: "record-active",
      title: "Record the tenant as active",
      run: async (ctx) => {
        localTx(ctx, (tx) => tx.update(tenants).set({ status: "active", suspended: false, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run());
        ctx.log("meta", `tenant recorded as active`);
      },
    },
  ];
}

function removeAppSteps(ports: TenantLifecyclePorts, params: RemoveAppParams): Step[] {
  const { tenantId, app } = params;
  return [
    attestTenantTargetStep(ports, tenantId),
    {
      name: "remove-app-pointer",
      title: "Drop the app from the tenant registration (GitOps un-deploy)",
      run: async (ctx) => {
        // updateTenantApps drops ONLY this app from the guid × apps[] matrix; every sibling member
        // stays. A drop of an app that is not present is refused (VALIDATION) by the registry — so on a resume
        // (the drop already committed before the crash) skip instead of throwing, mirroring add-app.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const current = await ports.registry.readTenant(tc.stage, tc.guid);
        if (current && !current.entry.apps.some((a) => a.name === app)) {
          ctx.log("meta", `app "${app}" already dropped from tenant ${tc.guid} — skipping (resume)`);
          return;
        }
        const { commit } = await ports.registry.updateTenantApps(tc.stage, tc.guid, { op: "drop", app, runId: ctx.runId });
        ctx.checkpoint({ commit });
        ctx.log("meta", `app "${app}" dropped from tenant ${tc.guid} on ${ports.registry.branch} (${commit}) — ArgoCD will now prune only this member's Application`);
      },
    },
    {
      name: "watch-prune",
      title: "Wait for ArgoCD to prune the removed app",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, tenantId);
        const names = [memberApplication(tc.guid, app, tc.stage)]; // ONLY this member — never a sibling
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const status = await argoReader.watchApplicationSet(argoNamespace, names, allPruned(names), { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: tenantSelector(tc.guid) });
        if (!allPruned(names)(status)) throw errValidation(`app "${app}" of tenant ${tc.guid} was not pruned — ${lingering(status)}; the registration dropped it but its workloads linger`);
        ctx.log("meta", `app "${app}" of tenant ${tc.guid} pruned — every sibling member is untouched`);
      },
    },
    {
      name: "record-app-removed",
      title: "Record the tenant app as offboarded",
      run: async (ctx) => {
        // Soft state: keep the tenant_apps row, flip it to offboarded; the tenant itself stays
        // active — only one member of its matrix was dropped. Bump the tenant's updatedAt/lastRunId (its
        // apps[] matrix changed) so the row's audit trail follows the pointer.
        localTx(ctx, (tx) => {
          tx.update(tenantApps).set({ status: "offboarded", lastRunId: ctx.runId }).where(and(eq(tenantApps.tenantId, tenantId), eq(tenantApps.name, app))).run();
          tx.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
        });
        ctx.log("meta", `tenant app "${app}" recorded as offboarded (row kept)`);
      },
    },
  ];
}

export function makeSuspendTenantDef(ports: TenantLifecyclePorts): RunDefinition<TenantLifecycleParams> {
  return {
    kind: "tenant-suspend",
    paramsSchema: TenantLifecycleParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const stepDefs = suspendSteps(ports, params);
      return {
        kind: "tenant-suspend",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Suspend tenant ${tc.guid} on ${tc.domain} (${tc.stage}): flip the registration to suspended, wait for every member to converge on its off state, verify each member namespace is scaled to zero, mark suspended. A suspend SWITCHES OFF — it prunes nothing: every member Application, namespace, ServiceClaim, database, DNS record and Vault path survives, and only running pods and public reach go. The row is kept.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Controller acts master-locally
        locks: tenantLocks(ports.registry),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => suspendSteps(ports, params),
  };
}

export function makeResumeTenantDef(ports: TenantLifecyclePorts): RunDefinition<TenantLifecycleParams> {
  return {
    kind: "tenant-resume",
    paramsSchema: TenantLifecycleParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const stepDefs = resumeSteps(ports, params);
      return {
        kind: "tenant-resume",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Resume tenant ${tc.guid} on ${tc.domain} (${tc.stage}): flip the registration back to active, wait for every member to re-sync at the pinned commit, mark active.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registry),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => resumeSteps(ports, params),
  };
}

export function makeRemoveAppDef(ports: TenantLifecyclePorts): RunDefinition<RemoveAppParams> {
  return {
    kind: "remove-app",
    paramsSchema: RemoveAppParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const stepDefs = removeAppSteps(ports, params);
      return {
        kind: "remove-app",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Remove app "${params.app}" from tenant ${tc.guid} on ${tc.domain} (${tc.stage}): drop it from the registration, wait for ArgoCD to prune only that member's Application, mark it offboarded. Every sibling member + the row are kept.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registry),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => removeAppSteps(ports, params),
  };
}
