// The per-cluster kube resolver. The manager pod runs ON the master with only
// its own cluster's access (the pod ServiceAccount in-cluster, or the KUBECONFIG_PATH dev override),
// so out of the box every kube client can only reach the master. This factory
// turns a target `clusterId` into the RIGHT clients for THAT cluster, resolved dynamically from
// inventory (the clusters/servers rows) — never a hardcoded cluster-name list (POLICY: derive
// everything from the servers.role + the plane, so adding a slave needs no code change):
//
//  - A cluster carrying the MASTER part (isMasterRole — "master" AND "master+slave", i.e. the
//    manager's own host): return the master-local trio (built from the master kube input —
//    in-cluster SA by default) and argoNamespace "argocd". A master+slave takes this branch for its
//    OWN cluster: the pod already sits on it, so there is nothing to harvest a bearer for, and its
//    root ArgoCD in namespace "argocd" IS its instance.
//  - A SLAVE cluster: a per-slave `clusterReader` over the harvested cluster-admin bearer
//    (unsealed from the credential store via plane.credentialIds.clusterBearer) + the sealed CA
//    bundle (plane.kube.caData), pointed at the slave API (plane.kube.server). The
//    `argoReader`/`projectWriter` STAY master-local — a slave's Application CRs + AppProject live in
//    the per-slave ArgoCD instance ON the master (ns "<slaveName>") — so only `argoNamespace` moves to
//    the slave cluster's short name (e.g. "s1").
//
// This module imports NO concrete kube adapter: the per-slave ClusterReader constructor and the
// credential opener ride in as injected deps (wire-units.ts supplies the real ones), keeping
// the boundary clean and the resolve logic unit-testable without a cluster.
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";
import { readClusterPlane, type ClusterPlaneV0 } from "../../../shared/plane.ts";
import type {
  ClusterReader, MasterArgoReader, MasterProjectWriter, ClusterKubeResolver, ResolvedClusterKube,
} from "../../adapters/kube/port.ts";

/** The single-cluster ClusterReader input the resolver hands the injected builder — the same shape
 *  as the kube adapter's ClusterKubeInput {server; token; caData} variant, but with caData REQUIRED:
 *  the resolver refuses a slave without a sealed CA bundle rather than skip TLS verification. */
export interface SlaveClusterInput {
  server: string;
  token: string;
  caData: string;
}

/** Everything the resolver needs, injected so this domain module stays free of concrete adapters
 *  and the credential store. wire-units.ts supplies: `db` (the manager DB), the pre-built
 *  master-local trio (the in-cluster pod SA / dev kubeconfig override — reused verbatim for the
 *  master path AND as the argoReader/projectWriter for EVERY path), `openCredential` (store.open
 *  bound to a purpose), and `buildClusterReader` (the KubeClusterReader constructor). */
export interface ClusterKubeDeps {
  db: Db;
  master: {
    clusterReader: ClusterReader;
    argoReader: MasterArgoReader;
    projectWriter: MasterProjectWriter;
  };
  openCredential: (id: string) => Promise<Buffer>;
  buildClusterReader: (input: SlaveClusterInput) => ClusterReader;
}

/** The slice of clusters.plane_json the resolver reads (ClusterPlaneV0, shared/plane.ts, written by
 *  deploy-slave's register step). Declared as a PERMISSIVE subset — exactly the fields the resolver
 *  needs — so a plane written before the plane carried caData (kube absent) yields the explicit
 *  "re-run adopt/backfill" error below rather than an opaque schema failure. The kube-access facts
 *  live under `kube` ({server, caData} == SlaveKubeAccess) and the per-slave ArgoCD namespace under
 *  `argo.namespace` — both frozen in ClusterPlaneV0.
 *
 *  The `satisfies` pin is what keeps a hand-written subset honest: a subset states the field names a
 *  SECOND time, so a rename in the declaration would leave this schema asking for the old ones — and
 *  a field that is optional here then reads as absent on every row and takes the fallback branch
 *  below in silence. Pinned to the declaration's own types, a name that is no longer there cannot
 *  compile. */
const SlavePlaneRead = z.object({
  kube: z.object({ server: z.string().min(1), caData: z.string().min(1) }).optional(),
  argo: z.object({ namespace: z.string().min(1) }).optional(),
  credentialIds: z.object({ clusterBearer: z.string().min(1) }),
}) satisfies z.ZodType<{
  kube?: ClusterPlaneV0["kube"] | undefined;
  argo?: Pick<ClusterPlaneV0["argo"], "namespace"> | undefined;
  credentialIds: Pick<ClusterPlaneV0["credentialIds"], "clusterBearer">;
}>;

interface SlavePlane {
  server: string;
  caData: string;
  clusterBearerId: string;
  argoNamespace?: string;
}

/** Read + validate the slave's plane facts, failing with a typed, actionable error at each gap. */
function readSlavePlane(planeJson: unknown, name: string): SlavePlane {
  if (planeJson === null || planeJson === undefined) {
    throw errValidation(`cluster "${name}" has no management plane recorded (plane_json is empty) — run deploy-slave to register it before onboarding to it`);
  }
  // The version FIRST, through the one reader that knows it (shared/plane.ts). The subset below can
  // only ask for v0's field names, so on a document of a later version every optional one of them
  // reads as absent — and `argo` absent is not an error here, it silently takes the fallback
  // namespace at the bottom of resolve(). Refusing an unknown version is what keeps that fallback
  // meaning "this v0 plane predates argo.namespace" and nothing else.
  const read = readClusterPlane(planeJson);
  if (read.kind === "unsupported") {
    throw errValidation(`cluster "${name}" carries a management plane of version ${read.v}, which this manager cannot read — deploy it with a manager that knows that version`);
  }
  // Every other outcome continues into the subset: a v0 document, and the half-written row
  // `create-mgmt` leaves before `register` writes the plane whole — the per-gap errors below name
  // what is missing far better than "the body did not parse" could.
  const parsed = SlavePlaneRead.safeParse(planeJson);
  if (!parsed.success) {
    throw errValidation(`cluster "${name}" plane_json is missing the cluster bearer credential id (credentialIds.clusterBearer) — re-run deploy-slave/backfill`);
  }
  const { kube, argo, credentialIds } = parsed.data;
  if (kube === undefined) {
    // NEVER skip TLS: a per-slave client without the API server URL + CA bundle cannot verify the
    // connection, and skip-verify is a deliberate non-feature (kube.ts). Fail closed and tell the
    // operator exactly how to heal it — adopt seals plane.kube {server, caData}.
    throw errValidation(`cluster "${name}" has no sealed kube access (plane.kube {server, caData}) — re-run adopt/backfill (the slave API URL + CA bundle were dropped at adopt; a per-slave kube client must verify TLS, never skip it)`);
  }
  return { server: kube.server, caData: kube.caData, clusterBearerId: credentialIds.clusterBearer, ...(argo ? { argoNamespace: argo.namespace } : {}) };
}

/** Build a ClusterKubeResolver over the injected deps. `resolve(clusterId)` reads the cluster + its
 *  server row and branches on the server role (dynamic — never a name list). */
export function makeClusterKubeResolver(deps: ClusterKubeDeps): ClusterKubeResolver {
  return {
    async resolve(clusterId: string): Promise<ResolvedClusterKube> {
      const cluster = deps.db.select().from(clusters).where(eq(clusters.id, clusterId)).get();
      if (!cluster) throw errNotFound(`cluster ${clusterId}`);
      const server = deps.db.select().from(servers).where(eq(servers.id, cluster.serverId)).get();
      if (!server) throw errNotFound(`server ${cluster.serverId} for cluster ${clusterId}`);

      // The MASTER part (master, and a master+slave's own cluster): the master-local trio verbatim
      // + ns "argocd". No bearer is harvested for it — the pod's ServiceAccount already reaches this
      // cluster, and a harvested cluster-admin bearer for the host the manager runs on would be a
      // second, sealed copy of the access it already has.
      if (isMasterRole(server.role)) {
        return {
          clusterReader: deps.master.clusterReader,
          argoReader: deps.master.argoReader,
          projectWriter: deps.master.projectWriter,
          argoNamespace: "argocd",
        };
      }

      // SLAVE: a per-slave clusterReader over the harvested bearer + sealed CA bundle,
      // pointed at the slave API. The argoReader/projectWriter stay master-local; only the ArgoCD
      // namespace moves to the slave cluster's short name (the per-slave ArgoCD instance on the master).
      // The slave's kube-apiserver URL + CA bundle come straight from the plane (plane.kube, sealed at
      // adopt) — no derivation from lan, no cross-namespace read of the master's cluster-slave Secret.
      const plane = readSlavePlane(cluster.planeJson, clusterShortName(cluster.domain));
      const bearer = await deps.openCredential(plane.clusterBearerId);
      let clusterReader: ClusterReader;
      try {
        clusterReader = deps.buildClusterReader({ server: plane.server, token: bearer.toString("utf8"), caData: plane.caData });
      } finally {
        // The token now lives inside the built client's KubeConfig; zero our transient copy.
        bearer.fill(0);
      }
      return {
        clusterReader,
        argoReader: deps.master.argoReader,
        projectWriter: deps.master.projectWriter,
        // The per-slave ArgoCD instance's namespace (plane.argo.namespace); falls back to the
        // cluster's short name, which the platform convention keeps equal to that namespace.
        argoNamespace: plane.argoNamespace ?? clusterShortName(cluster.domain),
      };
    },
  };
}
