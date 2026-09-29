// The shared Headlamp's slave contexts (hostyour-cloud#255). One Headlamp on the master serves every
// cluster of the installation from its cluster picker: the master in-cluster, and each slave from a
// context in the kubeconfig the Manager writes here. A context dials the API address and the CA the
// Manager sealed when it deployed the slave (plane.kube on the cluster row), and signs the person in
// through Headlamp's own client: every cluster's API server accepts that sign-in and binds the group
// admins to cluster-admin (hostyour-deploy ansiwise/programs/deploy-cluster.yaml). So no credential of
// a slave lands in Headlamp; what a person may do there is what their own sign-in may do.
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import type { HeadlampKubeconfig, HeadlampSignIn } from "../../adapters/kube/port.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import { readClusterPlane, SlaveKubeAccess } from "../../../shared/plane.ts";

/** One slave as Headlamp dials it: its cluster's short name, and the API address and CA of its plane. */
export interface SlaveContext {
  name: string;
  server: string;
  caData: string;
}

/** The active slaves with the kube access their deployment sealed, by name. A slave whose plane holds
 *  none is named in `unreachable`: Headlamp could not dial it. The access is read as cluster-kube.ts
 *  reads it: the version first, then the `kube` field alone, so a plane written before its other
 *  fields settled still offers the address it holds. */
export function activeSlaves(db: Db): { slaves: SlaveContext[]; unreachable: string[] } {
  const rows = db
    .select({ name: clusters.name, status: clusters.status, planeJson: clusters.planeJson, role: servers.role })
    .from(clusters)
    .innerJoin(servers, eq(clusters.serverId, servers.id))
    .all()
    .filter((r) => r.status === "active" && !isMasterRole(r.role));
  const slaves: SlaveContext[] = [];
  const unreachable: string[] = [];
  for (const r of rows) {
    const read = readClusterPlane(r.planeJson);
    const kube = SlaveKubeAccess.safeParse((r.planeJson as { kube?: unknown } | null)?.kube);
    if (read.kind !== "none" && read.kind !== "unsupported" && kube.success) slaves.push({ name: r.name, server: kube.data.server, caData: kube.data.caData });
    else unreachable.push(r.name);
  }
  return { slaves: slaves.sort((a, b) => a.name.localeCompare(b.name)), unreachable: unreachable.sort() };
}

/** The kubeconfig Headlamp reads the slaves from: one cluster and one context per slave, all signing in
 *  as one user, the person, through Headlamp's own client (an `oidc` auth-provider, the shape Headlamp
 *  0.42 takes a context's sign-in from). */
export function headlampKubeconfig(slaves: readonly SlaveContext[], signIn: HeadlampSignIn): string {
  return stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: slaves.map((s) => ({ name: s.name, cluster: { server: s.server, "certificate-authority-data": s.caData } })),
    users: [{ name: "headlamp", user: { "auth-provider": { name: "oidc", config: { "client-id": signIn.clientId, "client-secret": signIn.clientSecret, "idp-issuer-url": signIn.issuerUrl, scope: signIn.scopes } } } }],
    contexts: slaves.map((s) => ({ name: s.name, context: { cluster: s.name, user: "headlamp" } })),
  });
}

/** Bring Headlamp's slave contexts to the installation's active slaves, answered as a sentence for the
 *  record. Writes, and so restarts Headlamp, only where the kubeconfig differs. */
export async function syncHeadlampContexts(deps: { db: Db; headlamp: HeadlampKubeconfig }): Promise<string> {
  const { slaves, unreachable } = activeSlaves(deps.db);
  const next = headlampKubeconfig(slaves, await deps.headlamp.readSignIn());
  const names = slaves.map((s) => s.name).join(", ") || "no slave";
  const missing = unreachable.length > 0 ? `; ${unreachable.join(", ")} sealed no API address at deployment and cannot be offered` : "";
  if ((await deps.headlamp.readKubeconfig()) === next) return `Headlamp offers ${names} beside the master already${missing}`;
  await deps.headlamp.writeKubeconfig(next);
  return `Headlamp offers ${names} beside the master, and restarts to read them${missing}`;
}
