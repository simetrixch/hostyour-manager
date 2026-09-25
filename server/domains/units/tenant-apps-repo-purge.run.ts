import { z } from "zod";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { STAGE } from "../../../shared/enums.ts";
import type { OrphanBuildView } from "../../../shared/api-types.ts";
import { type TenantLifecyclePorts } from "./lifecycle.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { Registrations } from "#unit/server/registrations.ts";

// "tenant-apps-repo-purge" — the removal of a build registration nothing accounts for (#241).
//
// A build-only registration (registrations/<unit>/build.yaml) is written by tenant-apps-repo for a
// tenant's own apps repository and goes with the tenant's last app or with the tenant
// (tenant-apps-repo-remove.ts, #217). Nothing else removes one: there is no unit offboard. So a
// registration whose tenant is gone another way — the tenant purged before #217, the repository
// deleted by hand — stands forever: the App-token refresh presents it every tick and fails on it by
// name, its Vault entry build/<unit>/repo-pat stays, and the build ApplicationSet renders an
// Application for a repository that is not there. This run kind is that removal, keyed on the unit
// name the orphan scan found, exactly as tenant-purge is keyed on the guid the tenant scan found.
//
// WHAT IS ORPHANED: a build registration with NO stage file beside it (a consumer's build.yaml stands
// beside its stage files and is theirs), that NO tenant registration, at any stage, names as
// `appsImage`, and that the catalog's `tenant.buildRepos` does NOT name (those are registered
// build-only by the tenant onboarding and are the product's own build units — the first build of
// this run kind listed them and its purge took three of the customer's repositories). All three are
// asked at plan time and again in the removal itself: removeBuildRegistration refuses on its own
// while a stage file stands.
//
// NOTHING IS DELETED ON GITHUB. The registration and the Vault entry go; the repository stands, said
// in the log, and is the owner's to delete by hand once it is to go (github-app/port.ts).
//
// mutating: true ⇒ attest-target is step 0 (guards.assertGuardsArmed), on the master — the build
// plane the unit's `<unit>-build` namespace lives on, as for every build-only form.

export const TenantAppsRepoPurgeParams = z.object({ unit: z.string().min(1) });
export type TenantAppsRepoPurgeParams = z.infer<typeof TenantAppsRepoPurgeParams>;

/** Every build registration no stage file, no tenant registration and no catalog build unit accounts
 *  for. THROWS where a build.yaml does not read (listBuildRegistrations) or the catalog does not: a
 *  set that silently shrank would list an accounted-for unit as orphaned. */
export async function scanOrphanBuilds(deps: {
  registrations: Pick<TenantRegistrations, "listTenantPointers">;
  buildRegistrations: Pick<Registrations, "listBuildRegistrations" | "readUnitStages">;
  catalogBuildUnits: (signal?: AbortSignal) => Promise<string[]>;
  signal?: AbortSignal;
}): Promise<OrphanBuildView[]> {
  const named = new Set<string>(await deps.catalogBuildUnits(deps.signal));
  for (const stage of STAGE) {
    for (const t of (await deps.registrations.listTenantPointers(stage)).pointers) if (t.appsImage) named.add(t.appsImage);
  }
  const orphans: OrphanBuildView[] = [];
  for (const { unit, entry } of await deps.buildRegistrations.listBuildRegistrations()) {
    if (named.has(unit)) continue;
    if ((await deps.buildRegistrations.readUnitStages(unit)).length > 0) continue;
    orphans.push({ unit, repoURL: entry.repoURL });
  }
  return orphans;
}

/** The scan over the ports a def or a route holds; a refusal where the catalog cannot be read. */
export function orphanBuildsScan(ports: Pick<TenantLifecyclePorts, "registrations" | "buildRegistrations" | "catalogBuildUnits">): (signal?: AbortSignal) => Promise<OrphanBuildView[]> {
  return (signal) => {
    if (!ports.buildRegistrations || !ports.catalogBuildUnits) throw errValidation("the build registrations or the catalog's build units cannot be read on this manager — nothing is listed as orphaned, and nothing can be purged");
    return scanOrphanBuilds({ registrations: ports.registrations, buildRegistrations: ports.buildRegistrations, catalogBuildUnits: ports.catalogBuildUnits, ...(signal ? { signal } : {}) });
  };
}

function purgeSteps(ports: TenantLifecyclePorts, p: TenantAppsRepoPurgeParams): Step[] {
  return [
    {
      name: "attest-target",
      title: "Attest the build plane (deploy-state fresh)",
      run: async (ctx) => {
        const master = resolveMasterCluster(ctx.db);
        const { clusterReader } = await ports.resolver.resolve(master.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), master.domain, p.unit);
        ctx.log("meta", `build plane ${master.domain} attested for ${p.unit} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "remove-build-registration",
      title: "Remove the build registration; the repository stands",
      run: async (ctx) => {
        if (!ports.buildRegistrations) throw errValidation("no build registrations are wired on this manager — nothing can be purged");
        const current = await ports.buildRegistrations.readBuildRegistration(p.unit);
        if (current) ctx.log("meta", `repository ${current.entry.repoURL} stands — this Manager deletes no repository (#241); it is the owner's to delete by hand once it is to go`);
        const { removed } = await ports.buildRegistrations.removeBuildRegistration(p.unit, ctx.runId);
        ctx.log("meta", removed ? `build registration of ${p.unit} removed` : `build registration of ${p.unit} already absent`);
      },
    },
    {
      name: "remove-repo-pat",
      title: "Remove the unit's repo PAT (local build Vault)",
      run: async (ctx) => {
        // The entry the App-token refresh wrote for the registration (app-token-refresh.ts); the
        // consumer offboard's remove-repo-pat, idempotent on an already-absent entry.
        if (!ports.seeder) {
          ctx.log("meta", `no Vault seeder is wired on this manager — build/${p.unit}/repo-pat stays`);
          return;
        }
        await ports.seeder.deleteBuildRepoPat({ consumerName: p.unit });
        ctx.log("meta", `repo PAT removed — build/${p.unit}/repo-pat deleted`);
      },
    },
  ];
}

export function makeTenantAppsRepoPurgeDef(ports: TenantLifecyclePorts): RunDefinition<TenantAppsRepoPurgeParams> {
  return {
    kind: "tenant-apps-repo-purge",
    paramsSchema: TenantAppsRepoPurgeParams,
    mutating: true,
    plan: async (p, { db }) => {
      if (!ports.buildRegistrations) throw errValidation("no build registrations are wired on this manager — nothing can be purged");
      // Refused at plan and again in the removal: a unit the catalog names, a tenant names, or one
      // standing at a stage, is not an orphan, and the operator is told which.
      const orphan = (await orphanBuildsScan(ports)()).find((o) => o.unit === p.unit);
      if (!orphan) throw errValidation(`${p.unit} is not an orphaned build registration — the catalog's buildRepos names it, a tenant names it, a stage file stands beside it, or it is already gone`);
      const master = resolveMasterCluster(db);
      const stepDefs = purgeSteps(ports, p);
      return {
        kind: "tenant-apps-repo-purge",
        targetKind: "cluster",
        targetId: master.clusterId,
        summary: `Purge the orphaned build registration ${p.unit}: remove registrations/${p.unit}/build.yaml and build/${p.unit}/repo-pat. The repository ${orphan.repoURL} stands — nothing is deleted on GitHub. No tenant and no catalog build unit names it, and no stage file stands beside it.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [...tenantLocks(ports.registrations), { resource: "git-branch", key: ports.buildRegistrations.branch }],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => purgeSteps(ports, params),
  };
}
