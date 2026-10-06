import { and, eq } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import { memberAppProject, memberApplication, memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { loadTenantStatus } from "./tenant-provisioned.ts";
import { RemoveAppParams, tenantLocks } from "./tenant-lifecycle.run.ts";

// tenant-purge-app: tenant-remove-app takes an app off a standing tenant and keeps, on purpose, its
// record (marked offboarded), its AppProject, its admission policy and its Vault keys, since its data
// and backups may still need them. The purge deletes exactly those of that one app, named in the plan
// before anyone approves, and the record last, so a run that fails halfway can run again. It refuses
// an app whose namespace or Application still stands (the app is still deployed: remove it first).

/** Only a standing tenant's app is purged: a settled tenant's restore brings its app rows back by
 *  name, and an unfinished tenant never deployed its apps. */
function assertTenantStanding(db: Db, tc: TenantCluster): void {
  const { status } = loadTenantStatus(db, tc.tenantId);
  if (status === "provisioning" || (TENANT_SETTLED_STATUS as readonly string[]).includes(status)) {
    throw errValidation(`tenant ${tc.guid} is ${status}: only an app removed from a standing tenant is purged`);
  }
}

function assertAppOffboarded(db: Db, tc: TenantCluster, app: string): void {
  const row = db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, tc.tenantId), eq(tenantApps.name, app))).get();
  if (!row) throw errNotFound(`app "${app}" of tenant ${tc.guid}`);
  if (row.status !== "offboarded") {
    throw errValidation(`app "${app}" of tenant ${tc.guid} is ${row.status}: only an offboarded app is purged — remove the app first`);
  }
}

/** What of the app still stands and the purge deletes; an AppProject or policy is named where it stands. */
interface AppLeftovers {
  project?: string;
  policy?: string;
  vaultKeys: string[];
}

/** Every check a purge needs before it deletes, read now: the tenant stands, the app is offboarded
 *  and no longer deployed, and what of it is left. Vault unread is a refusal, never an empty answer,
 *  since a key standing there could not be seen. */
async function readLeftovers(ports: TenantLifecyclePorts, db: Db, tenantId: string, app: string): Promise<{ tc: TenantCluster; left: AppLeftovers }> {
  const tc = loadTenantCluster(db, tenantId);
  assertTenantStanding(db, tc);
  assertAppOffboarded(db, tc, app);
  if (!ports.seeder) throw errValidation(`this Manager cannot read Vault, so it cannot see whether app "${app}" of tenant ${tc.guid} still has a key there`);
  const { clusterReader, argoReader, projectWriter, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
  const deployed: string[] = [];
  const namespace = memberNamespace(tc.guid, app, tc.stage);
  if (await clusterReader.readNamespaceAnnotations(namespace)) deployed.push(`namespace ${namespace}`);
  const application = memberApplication(tc.guid, app, tc.stage);
  if (await argoReader.getApplication(argoNamespace, application)) deployed.push(`ArgoCD Application ${application}`);
  if (deployed.length > 0) throw errValidation(`app "${app}" of tenant ${tc.guid} is still deployed: ${deployed.join("; ")} — remove the app first`);
  const project = memberAppProject(tc.guid, app, tc.stage);
  const policy = tenantMemberAdmissionPolicyName(tc.guid, app, tc.stage);
  return {
    tc,
    left: {
      ...((await projectWriter.appProjectExists(argoNamespace, project)) ? { project } : {}),
      ...((await clusterReader.admissionPolicyExists(policy)) ? { policy } : {}),
      vaultKeys: await ports.seeder.listTenantAppKeys({ stage: tc.stage, guid: tc.guid, app }),
    },
  };
}

const describeLeftovers = (tc: TenantCluster, left: AppLeftovers): string[] => [
  ...(left.project ? [`AppProject ${left.project}`] : []),
  ...(left.policy ? [`admission policy ${left.policy} with its binding`] : []),
  ...left.vaultKeys.map((key) => `Vault key ${tc.stage}/tenants/${tc.guid}/${key}`),
];

function purgeAppSteps(ports: TenantLifecyclePorts, params: RemoveAppParams): Step[] {
  const { tenantId, app } = params;
  return [
    attestTenantTargetStep(ports, tenantId),
    {
      name: "delete-app-objects",
      title: "Delete the app's AppProject, admission policy and Vault keys",
      run: async (ctx) => {
        // Read again: the tenant or the app may have changed between the plan and its approval.
        const { tc, left } = await readLeftovers(ports, ctx.db, tenantId, app);
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        if (left.project) await projectWriter.deleteAppProject(argoNamespace, left.project);
        if (left.policy) await clusterReader.deleteAdmissionPolicy(left.policy);
        const { deleted } = left.vaultKeys.length > 0 ? await ports.seeder!.deleteTenantAppKeys({ stage: tc.stage, guid: tc.guid, app }) : { deleted: [] };
        const gone = describeLeftovers(tc, { ...left, vaultKeys: deleted });
        ctx.log("meta", gone.length > 0 ? `app "${app}" of tenant ${tc.guid}: deleted ${gone.join(", ")}` : `app "${app}" of tenant ${tc.guid}: nothing but its record stood`);
      },
    },
    {
      name: "delete-app-record",
      title: "Delete the app's record",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, tenantId);
        assertTenantStanding(ctx.db, tc);
        assertAppOffboarded(ctx.db, tc, app);
        localTx(ctx, (tx) => {
          tx.delete(tenantApps).where(and(eq(tenantApps.tenantId, tenantId), eq(tenantApps.name, app))).run();
          tx.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
        });
        ctx.log("meta", `record of app "${app}" of tenant ${tc.guid} deleted — nothing of the app remains`);
      },
    },
  ];
}

export function makePurgeAppDef(ports: TenantLifecyclePorts): RunDefinition<RemoveAppParams> {
  return {
    kind: "tenant-purge-app",
    paramsSchema: RemoveAppParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const { tc, left } = await readLeftovers(ports, db, params.tenantId, params.app);
      const pieces = describeLeftovers(tc, left);
      const stepDefs = purgeAppSteps(ports, params);
      return {
        kind: "tenant-purge-app",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Purge the offboarded app "${params.app}" of tenant ${tc.guid} (${tc.stage}): ${pieces.length > 0 ? `delete ${pieces.join(", ")}, then its record` : "nothing else of it stands; delete its record"}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => purgeAppSteps(ports, params),
  };
}
