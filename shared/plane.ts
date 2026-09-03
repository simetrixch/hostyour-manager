// The per-slave management-plane schema, stored as JSON in clusters.plane_json, together with the
// reader that narrows on its version. `v` is a contract only where a reader refuses a body it was
// not written for; readClusterPlane at the bottom of this file is that reader, and the one reader of
// the column goes through it: cluster-kube.ts, for the version alone, ahead of the permissive subset
// it needs for a plane written before caData was sealed.
import { z } from "zod";

/**
 * ClusterPlane **v0** — the Run-written identity of a slave's management plane, stored in
 * clusters.plane_json (mode "json"). TWO deploy-slave steps write it: `create-mgmt` folds in the
 * harvested kube access, `register` writes the whole plane over it. The per-cluster kube client
 * resolver (server/domains/units/cluster-kube.ts) is the only code that reads the column, and
 * it dials three fields: `kube`, `argo.namespace` and `credentialIds.clusterBearer`. The remaining
 * fields are the run's written account of the plane it provisioned — no screen renders them, and
 * they are read by a person going to the row. Everything here is a stable fact of the slave, and
 * every per-slave resource is named by the slave NAME <name> (never the internal ordinal):
 *  - `v`               — the schema version; ALWAYS 0 for this shape. readClusterPlane below narrows
 *                        on it before touching the body, so a future v1 can be added without
 *                        rewriting stored v0 rows and without a v0 reader guessing.
 *  - `branch` — the install branch == clusters.domain (one FQDN branch per slave).
 *  - `slaveId`         — the internal ordinal (never reused; clusters_slave_id_uq); NOT a name.
 *  - `vault`           — the surface the master's Vault carries for this slave (mount + auth path +
 *                        policy + address); the note on the field says why it is kept unread.
 *  - `argo`            — the slave-ArgoCD namespace + the Application name; the slave cluster is
 *                        registered under its own <name>.
 *  - `kube`            — how a per-cluster kube client dials the slave's kube-apiserver DIRECTLY:
 *                        the API server URL + the base64 CA bundle the slave emitted at deployment.
 *                        Stored here so the resolver builds the client from the plane alone —
 *                        NO cross-namespace read of the master's cluster-slave Secret.
 *  - `credentialIds`   — Manager credential-store ids for the harvested slave creds.
 *  - `hostnames.kube`  — kube-<name>.<master-fqdn> once Headlamp is enabled (optional).
 */

/** The slave's kube-apiserver access facts (deploy-slave create-mgmt harvests them from the
 *  --emit-mgmt-credentials blob; register folds them into the plane below). `server` is THE one
 *  place the plane states the slave's apiserver endpoint — the URL the slave reported, which the
 *  run refuses unless it is the very address it stated as --api-host and wrote into the cluster
 *  map's apiHost. A second field decomposing the same URL into host + port would be a second
 *  writer of one datum with nothing reading it. `caData` is the
 *  base64 CA bundle (kubeconfig `certificate-authority-data`) — a public cert, not a secret.
 *  Together with the sealed cluster bearer (credentialIds.clusterBearer) they are exactly the
 *  kube adapter's ClusterKubeInput {server, token, caData}. Persisting caData here lets a
 *  per-cluster client be built without re-reading the
 *  master's cluster-slave Secret cross-namespace. */
export const SlaveKubeAccess = z.object({
  server: z.string().url(),
  caData: z.string().min(1),
});
export type SlaveKubeAccess = z.infer<typeof SlaveKubeAccess>;

export const ClusterPlaneV0 = z.object({
  v: z.literal(0),
  branch: z.string(), // == clusters.domain
  slaveId: z.number().int().positive(),
  // The surface the register-slave program creates for this slave on the MASTER's Vault: the KV
  // mount <name>, the kubernetes auth mount kubernetes-<name>, the policy <name>-eso the slave's ESO
  // logs in under, and the master's Vault address. Vault is central on the master — there is no per-slave
  // Vault instance and none is planned — so these four are the whole Vault story of a slave.
  //
  // KEPT although no code reads it. This document is the account of what the run provisioned, not a
  // cache for the resolver, and the account is what a person reading one row gets; every field is
  // required by the parse and asserted whole by the deploy-slave journey check, so the record cannot
  // quietly stop being written. A code reader is not coming either: the step that undoes this
  // surface hands the remove-slave program the slave's domain and lets it recompose the four
  // names from it, which is all a reader here could do as well. Deleting the field would in exchange
  // change what the frozen `v: 0` shape means, for a reader whose whole point is to refuse a
  // document it was not written for.
  vault: z.object({ addr: z.string().url(), kvMount: z.string(), k8sAuthPath: z.string(), policy: z.string() }),
  argo: z.object({ namespace: z.string(), appName: z.string() }),
  kube: SlaveKubeAccess,
  credentialIds: z.object({ clusterBearer: z.string(), reviewerJwt: z.string() }),
  hostnames: z.object({ kube: z.string().optional() }),
});
export type ClusterPlaneV0 = z.infer<typeof ClusterPlaneV0>;

/** What reading clusters.plane_json produced. A UNION rather than `ClusterPlaneV0 | null`, because
 *  the four outcomes are four different facts about a cluster and a reader that folds them cannot
 *  say which one it met: no document at all is the master's own cluster row (nothing writes a plane
 *  for the cluster the manager sits on) or a slave before deploy-slave; a document this build
 *  does not know is a newer manager's write; and a document that fails the body schema is a
 *  half-written row — `create-mgmt` stashes `{kube}` on this column BEFORE `register` writes the
 *  whole document, so an unversioned partial is a normal state of a slave mid-deploy. */
export type ClusterPlaneRead =
  | { kind: "none" }
  | { kind: "v0"; plane: ClusterPlaneV0 }
  | { kind: "unsupported"; v: number }
  | { kind: "unreadable"; reason: string };

/** Just the version, read on its own so an unknown version is answered as such instead of failing
 *  the whole body's schema and reading as corruption. */
const Versioned = z.object({ v: z.number().int() });

/**
 * Read a stored plane document: narrow on `v` FIRST, parse the body only for a version this build
 * knows, and name every other outcome instead of collapsing it to null.
 *
 * Reading the column any other way is what let a reader ask for field names the schema never
 * declared: a cast states the shape the reader WANTS, so a name that is nowhere in the document
 * compiles, resolves to undefined and takes the caller's fallback on every row, forever. Through
 * this reader the field names come from ClusterPlaneV0 itself and a wrong one cannot compile.
 */
export function readClusterPlane(stored: unknown): ClusterPlaneRead {
  if (stored === null || stored === undefined) return { kind: "none" };
  const versioned = Versioned.safeParse(stored);
  if (!versioned.success) return { kind: "unreadable", reason: "no version field" };
  if (versioned.data.v !== 0) return { kind: "unsupported", v: versioned.data.v };
  const parsed = ClusterPlaneV0.safeParse(stored);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { kind: "v0", plane: parsed.data };
}
