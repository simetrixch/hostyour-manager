import { and, eq } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import { memberAppProject, memberApplication, memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { RemoveAppParams, tenantLocks } from "./tenant-lifecycle.run.ts";

// tenant-delete-app-record: the record of an app that tenant-remove-app took off a standing tenant
// stays, marked offboarded, because the removal keeps what the app may still need (its Vault keys
// among them). Once nothing of the app remains, a person deletes the record by hand. The run reads
// every piece a member of a tenant has, in the plan and again when it runs, and deletes the row only
// when none stands; otherwise it names each piece and deletes nothing.

/** The offboarded row of `app`, or a refusal that says why there is none to delete. */
function offboardedRow(db: Db, tc: TenantCluster, app: string): void {
  const row = db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, tc.tenantId), eq(tenantApps.name, app))).get();
  if (!row) throw errNotFound(`app "${app}" of tenant ${tc.guid}`);
  if (row.status !== "offboarded") {
    throw errValidation(`app "${app}" of tenant ${tc.guid} is ${row.status}: only an offboarded app's record is deleted — remove the app first`);
  }
}

/** Every piece of the app that still stands, named: its namespace, its ArgoCD Application and
 *  AppProject, its admission policy and its Vault keys. Vault unread is a refusal, never an empty
 *  answer, since a key standing there could not be seen. */
async function remainingPieces(ports: TenantLifecyclePorts, tc: TenantCluster, app: string): Promise<string[]> {
  if (!ports.seeder) throw errValidation(`this Manager cannot read Vault, so it cannot see whether app "${app}" of tenant ${tc.guid} still has a key there`);
  const { clusterReader, argoReader, projectWriter, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
  const pieces: string[] = [];
  const namespace = memberNamespace(tc.guid, app, tc.stage);
  if (await clusterReader.readNamespaceAnnotations(namespace)) pieces.push(`namespace ${namespace}`);
  const application = memberApplication(tc.guid, app, tc.stage);
  if (await argoReader.getApplication(argoNamespace, application)) pieces.push(`ArgoCD Application ${application}`);
  const project = memberAppProject(tc.guid, app, tc.stage);
  if (await projectWriter.appProjectExists(argoNamespace, project)) pieces.push(`AppProject ${project}`);
  const policy = tenantMemberAdmissionPolicyName(tc.guid, app, tc.stage);
  if ((await clusterReader.listAdmissionPolicies()).includes(policy)) pieces.push(`admission policy ${policy}`);
  for (const key of await ports.seeder.listTenantAppKeys({ stage: tc.stage, guid: tc.guid, app })) pieces.push(`Vault key ${tc.stage}/tenants/${tc.guid}/${key}`);
  return pieces;
}

async function assertNothingRemains(ports: TenantLifecyclePorts, tc: TenantCluster, app: string): Promise<void> {
  const pieces = await remainingPieces(ports, tc, app);
  if (pieces.length > 0) {
    throw errValidation(`app "${app}" of tenant ${tc.guid} still has: ${pieces.join("; ")} — its record stays until nothing of it remains`);
  }
}

function deleteAppRecordSteps(ports: TenantLifecyclePorts, params: RemoveAppParams): Step[] {
  const { tenantId, app } = params;
  return [
    attestTenantTargetStep(ports, tenantId),
    {
      name: "delete-app-record",
      title: "Read that nothing of the app remains, then delete its record",
      run: async (ctx) => {
        // Read again: something of the app may have come back between the plan and its approval.
        const tc = loadTenantCluster(ctx.db, tenantId);
        offboardedRow(ctx.db, tc, app);
        await assertNothingRemains(ports, tc, app);
        localTx(ctx, (tx) => {
          tx.delete(tenantApps).where(and(eq(tenantApps.tenantId, tenantId), eq(tenantApps.name, app))).run();
          tx.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
        });
        ctx.log("meta", `record of app "${app}" of tenant ${tc.guid} deleted — nothing of it remained`);
      },
    },
  ];
}

export function makeDeleteAppRecordDef(ports: TenantLifecyclePorts): RunDefinition<RemoveAppParams> {
  return {
    kind: "tenant-delete-app-record",
    paramsSchema: RemoveAppParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      offboardedRow(db, tc, params.app);
      await assertNothingRemains(ports, tc, params.app);
      const stepDefs = deleteAppRecordSteps(ports, params);
      return {
        kind: "tenant-delete-app-record",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Delete the record of the offboarded app "${params.app}" of tenant ${tc.guid} (${tc.stage}): nothing of it remains — no namespace, ArgoCD Application, AppProject, admission policy or Vault key; it reads that again before it deletes`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => deleteAppRecordSteps(ports, params),
  };
}
