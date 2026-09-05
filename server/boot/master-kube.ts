import type { Config } from "../kernel/config.ts";
import type { ClusterReader, MasterArgoReader, MasterProjectWriter } from "../adapters/kube/port.ts";
import { KubeMasterArgoReader, KubeClusterReader, KubeMasterProjectWriter } from "../adapters/kube/kube.ts";

/** The master (self-cluster) kube access every master-local client is built from: the pod
 *  ServiceAccount's in-cluster credentials by default, or the KUBECONFIG_PATH file when that
 *  is configured (a dev/test override, never used in a deployed Manager). */
export function masterKubeInput(config: Config): { kubeconfigPath: string } | { inCluster: true } {
  return config.kubeconfigPath !== undefined ? { kubeconfigPath: config.kubeconfigPath } : { inCluster: true };
}

/** The three master-local clients, built ONCE for the whole process.
 *
 *  THEY WERE BUILT THREE TIMES, and a fourth caller would have made it four. Each family that
 *  needed a per-cluster resolver constructed its own trio from the same input and handed it to its
 *  own `makeClusterKubeResolver`, so three sets of clients spoke to one API server with identical
 *  credentials — and a cluster run kind that needed a resolver had no way to reach one at all,
 *  because both stood behind a family's own configuration guard. */
export interface MasterKubeClients {
  clusterReader: ClusterReader;
  argoReader: MasterArgoReader;
  projectWriter: MasterProjectWriter;
}

export function masterKubeClients(config: Config): MasterKubeClients {
  const input = masterKubeInput(config);
  return {
    clusterReader: new KubeClusterReader(input),
    argoReader: new KubeMasterArgoReader(input),
    projectWriter: new KubeMasterProjectWriter(input),
  };
}
