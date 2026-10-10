import { and, eq, isNull, ne } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { deletion } from "../../db/schema/stamps.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import type { ClusterReader } from "../../adapters/kube/port.ts";
import { memberAppProject, memberApplication, memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { loadTenantStatus } from "./tenant-provisioned.ts";
import { RemoveAppParams, tenantLocks } from "./tenant-lifecycle.run.ts";

// tenant-purge-app: tenant-remove-app takes an app off a standing tenant and keeps, on purpose, its
// record (marked offboarded), its AppProject, its admission policy and its Vault keys, since its data
// and backups may still need them. The purge deletes exactly those of that one app, named in the plan
// before anyone approves, and the record last, so a run that fails halfway can run again. It also
// deletes the app's member namespace where one stands empty: remove-app prunes the app's ServiceClaims,
// so the service-provisioner has already dropped its databases, and the namespace it leaves behind
// holds nothing. It refuses an app whose Application stands, or whose namespace still holds a workload
// or a ServiceClaim (the app is still deployed: remove it first).

/** Only a standing tenant's app is purged: a settled tenant's restore brings its app rows back by
 *  name, and an unfinished tenant never deployed its apps. */
function assertTenantStanding(db: Db, tc: TenantCluster): void {
  const { status } = loadTenantStatus(db, tc.tenantId);
  if (status === "provisioning" || (TENANT_SETTLED_STATUS as readonly string[]).includes(status)) {
    throw errValidation(`tenant ${tc.guid} is ${status}: only an app removed from a standing tenant is purged`);
  }
}

function assertAppOffboarded(db: Db, tc: TenantCluster, app: string): void {
  const row = db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, tc.tenantId), isNull(tenantApps.deleted), eq(tenantApps.name, app))).get();
  if (!row) throw errNotFound(`app "${app}" of tenant ${tc.guid}`);
  if (row.status !== "offboarded") {
    throw errValidation(`app "${app}" of tenant ${tc.guid} is ${row.status}: only an offboarded app is purged — remove the app first`);
  }
}

/** What of the app still stands on one cluster and the purge deletes there. */
interface ClusterLeftovers {
  clusterId: string;
  /** The cluster's domain, named where it is not the tenant's own cluster. */
  former?: string;
  project?: string;
  policy?: string;
  /** The member namespace, where it stands with no workload and no ServiceClaim in it. */
  namespace?: string;
}

/** What of the app still stands and the purge deletes: per cluster, and its Vault keys; and each former
 *  cluster that could not be read, with why. */
interface AppLeftovers {
  clusters: ClusterLeftovers[];
  vaultKeys: string[];
  unread: string[];
}

/** What a standing member namespace still holds that makes the app deployed: its workloads, of any
 *  replica count, and its ServiceClaims, whose databases the namespace's delete would drop. */
async function namespaceHolds(clusterReader: ClusterReader, namespace: string): Promise<string[]> {
  const [{ workloads }, claims] = await Promise.all([clusterReader.smoke(namespace), clusterReader.listServiceClaims(namespace)]);
  return [
    ...(workloads.length > 0 ? [`workload(s) ${workloads.map((w) => w.name).join(", ")}`] : []),
    ...(claims.length > 0 ? [`ServiceClaim(s) ${claims.join(", ")}`] : []),
  ];
}

/** Every check a purge needs before it deletes, read now: the tenant stands, the app is offboarded,
 *  its registration no longer names it and nothing of it is deployed, and what of it is left. The
 *  registration is read first because it is what the tenant runs: the cluster follows it, so an app
 *  the registration names but ArgoCD has not deployed yet stands nowhere on the cluster. Vault unread
 *  is a refusal, never an empty answer, since a key standing there could not be seen. */
async function readLeftovers(ports: TenantLifecyclePorts, db: Db, tenantId: string, app: string): Promise<{ tc: TenantCluster; left: AppLeftovers }> {
  const tc = loadTenantCluster(db, tenantId);
  assertTenantStanding(db, tc);
  assertAppOffboarded(db, tc, app);
  const registration = await ports.registrations.readTenant(tc.stage, tc.guid);
  if (registration?.entry.apps.some((a) => a.name === app)) {
    throw errValidation(`app "${app}" of tenant ${tc.guid} is still deployed: the registration still names it — remove the app first`);
  }
  if (!ports.seeder) throw errValidation(`this Manager cannot read Vault, so it cannot see whether app "${app}" of tenant ${tc.guid} still has a key there`);
  // The tenant's own cluster, whatever its status, then every other active one: a move before every app
  // row's objects were cleared left a removed app's AppProject and policy on the former cluster, and
  // nothing records which one. The names carry the guid, the app and the stage, so on another cluster
  // they are this app's alone. The own cluster must be read; another one that cannot be is named, and
  // what may stand on it stays there for a later purge.
  const own = db.select({ id: clusters.id, domain: clusters.domain }).from(clusters).where(eq(clusters.id, tc.clusterId)).all();
  const others = db.select({ id: clusters.id, domain: clusters.domain }).from(clusters).where(and(eq(clusters.status, "active"), ne(clusters.id, tc.clusterId))).all();
  const namespace = memberNamespace(tc.guid, app, tc.stage);
  const application = memberApplication(tc.guid, app, tc.stage);
  const project = memberAppProject(tc.guid, app, tc.stage);
  const policy = tenantMemberAdmissionPolicyName(tc.guid, app, tc.stage);
  const deployed: string[] = [];
  const onClusters: ClusterLeftovers[] = [];
  const unread: string[] = [];
  const read = async (cluster: { id: string; domain: string }, former: boolean): Promise<void> => {
    const { clusterReader, argoReader, projectWriter, argoNamespace } = await ports.resolver.resolve(cluster.id);
    const where = former ? ` on ${cluster.domain}` : "";
    const namespaceStands = (await clusterReader.readNamespaceAnnotations(namespace)) !== null;
    const holds = namespaceStands ? await namespaceHolds(clusterReader, namespace) : [];
    if (holds.length > 0) deployed.push(`namespace ${namespace}${where} holds ${holds.join(" and ")}`);
    if (await argoReader.getApplication(argoNamespace, application)) deployed.push(`ArgoCD Application ${application}${where}`);
    const left: ClusterLeftovers = {
      clusterId: cluster.id,
      ...(former ? { former: cluster.domain } : {}),
      ...((await projectWriter.appProjectExists(argoNamespace, project)) ? { project } : {}),
      ...((await clusterReader.admissionPolicyExists(policy)) ? { policy } : {}),
      ...(namespaceStands && holds.length === 0 ? { namespace } : {}),
    };
    if (left.project || left.policy || left.namespace) onClusters.push(left);
  };
  for (const cluster of own) await read(cluster, false);
  for (const cluster of others) {
    try {
      await read(cluster, true);
    } catch (err) {
      unread.push(`${cluster.domain} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (deployed.length > 0) throw errValidation(`app "${app}" of tenant ${tc.guid} is still deployed: ${deployed.join("; ")} — remove the app first`);
  return { tc, left: { clusters: onClusters, vaultKeys: await ports.seeder.listTenantAppKeys({ stage: tc.stage, guid: tc.guid, app }), unread } };
}

const describeLeftovers = (tc: TenantCluster, left: AppLeftovers): string[] => [
  ...left.clusters.flatMap((c) => {
    const where = c.former ? ` on ${c.former}` : "";
    return [
      ...(c.project ? [`AppProject ${c.project}${where}`] : []),
      ...(c.policy ? [`admission policy ${c.policy} with its binding${where}`] : []),
      ...(c.namespace ? [`empty namespace ${c.namespace}${where}`] : []),
    ];
  }),
  ...left.vaultKeys.map((key) => `Vault key ${tc.stage}/tenants/${tc.guid}/${key}`),
];

/** The former clusters that could not be read, said where the person approves and in the run's log. */
const unreadNote = (left: AppLeftovers): string =>
  left.unread.map((u) => `; not read: ${u}; its AppProject, policy and namespace, if any, stay`).join("");

function purgeAppSteps(ports: TenantLifecyclePorts, params: RemoveAppParams): Step[] {
  const { tenantId, app } = params;
  return [
    attestTenantTargetStep(ports, tenantId),
    {
      name: "delete-app-objects",
      title: "Delete the app's AppProject, admission policy, empty namespace and Vault keys",
      run: async (ctx) => {
        // Read again: the tenant or the app may have changed between the plan and its approval.
        const { tc, left } = await readLeftovers(ports, ctx.db, tenantId, app);
        for (const c of left.clusters) {
          const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(c.clusterId);
          if (c.project) await projectWriter.deleteAppProject(argoNamespace, c.project);
          if (c.policy) await clusterReader.deleteAdmissionPolicy(c.policy);
          if (c.namespace) await clusterReader.deleteNamespace(c.namespace);
        }
        const { deleted } = left.vaultKeys.length > 0 ? await ports.seeder!.deleteTenantAppKeys({ stage: tc.stage, guid: tc.guid, app }) : { deleted: [] };
        const gone = describeLeftovers(tc, { ...left, vaultKeys: deleted });
        ctx.log("meta", (gone.length > 0 ? `app "${app}" of tenant ${tc.guid}: deleted ${gone.join(", ")}` : `app "${app}" of tenant ${tc.guid}: nothing but its record stood`) + unreadNote(left));
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
          tx.update(tenantApps).set(deletion()).where(and(eq(tenantApps.tenantId, tenantId), isNull(tenantApps.deleted), eq(tenantApps.name, app))).run();
          tx.update(tenants).set({ lastRunId: ctx.runId }).where(eq(tenants.id, tenantId)).run();
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
        summary: `Purge the offboarded app "${params.app}" of tenant ${tc.guid} (${tc.stage}): ${pieces.length > 0 ? `delete ${pieces.join(", ")}, then its record` : "nothing else of it stands; delete its record"}${unreadNote(left)}`,
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
