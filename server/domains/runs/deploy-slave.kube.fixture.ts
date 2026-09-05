import {
  FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver,
} from "../../adapters/kube/testing/fake.ts";
import type { ArgoApplicationRow, ExternalSecretRow } from "../../adapters/kube/port.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";
import { SLAVE_FQDN } from "./cluster-maps.fixture.ts";

// WHAT THE MASTER'S ARGOCD HOLDS, as the three steps that read it see it. Beside the harness for the
// same reason the placement and first-contact halves are: it is one master, and a suite that drives
// gitops-handoff, verify-slave or argocd-follow reads what it holds off one object rather than
// scripting a `microk8s kubectl` line's output — which is what those three used to do.

/** The namespaces the fixture's master holds, and what stands in each: `argocd` is the master's own
 *  root instance, which gitops-handoff and a master-arm argocd-follow read, and `s1` is the
 *  per-slave instance on the master, which verify-slave's two HARD gates read. */
export const MASTER_ARGO_NS = "argocd";
export const SLAVE_ARGO_NS = "s1";

/** An Application row as a namespace holds it — the shape listApplications answers with. */
export const argoRow = (name: string, sync = "Synced", health = "Healthy"): ArgoApplicationRow => ({
  name, sync, health, syncRevision: null, targetRevision: null,
} as ArgoApplicationRow);

/** An ExternalSecret row as a namespace holds it — the shape listExternalSecrets answers with. */
export const externalSecretRow = (name: string, ready = true, reason = ready ? "SecretSynced" : "SecretSyncedError"): ExternalSecretRow => ({
  name, ready, reason, targetSecret: `${name}-creds`,
});

export interface MasterKubeFakes {
  argo: FakeMasterArgoReader;
  cluster: FakeClusterReader;
  resolver: FakeClusterKubeResolver;
}

/** The master's ArgoCD, its ExternalSecrets, and the resolver every cluster of this harness resolves
 *  to them through.
 *
 *  THE DEFAULTS ARE A CONVERGED INSTALLATION: the master's root instance holds the slave's generated
 *  `<name>-apps` Synced, and ns `s1` on the master holds the per-slave Applications and the three
 *  ExternalSecrets the slave chart renders. A suite that is ABOUT a gate scripts its own rows over
 *  these; every other suite keeps a green read and never has to know the gate exists. */
export function masterKubeFakes(): MasterKubeFakes {
  const argo = new FakeMasterArgoReader({
    status: { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy" },
    applicationsByNamespace: {
      [MASTER_ARGO_NS]: [argoRow(`${clusterShortName(SLAVE_FQDN)}-apps`)],
      [SLAVE_ARGO_NS]: [argoRow("root-applications"), argoRow("platform-apps-prod")],
    },
  });
  const cluster = new FakeClusterReader({
    externalSecretsByNamespace: {
      [SLAVE_ARGO_NS]: [externalSecretRow("cluster-slave"), externalSecretRow("repo-platform"), externalSecretRow("repo-catalog")],
    },
  });
  const resolver = new FakeClusterKubeResolver({
    clusterReader: cluster,
    argoReader: argo,
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: MASTER_ARGO_NS,
  });
  return { argo, cluster, resolver };
}
