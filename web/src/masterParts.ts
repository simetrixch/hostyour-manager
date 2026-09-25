// WHAT THE MACHINE THIS MANAGER RUNS ON CARRIES, in one sentence for its card. A pure module beside
// tailnetState.ts and machineIdentity.ts, for the reason those are: vitest runs with environment
// "node" and includes no .tsx, so wording left inside the page cannot be tested — and wording is the
// whole substance here.
//
// A master operates the management plane — the ArgoCD, the Vault and the registrations every other
// cluster of the installation is driven from — and carries the slave part as well: it runs
// workloads on the one cluster it keeps, from its own installation (hostyour-cloud#232). Nothing
// adds a part to it and nothing takes one off, so the card states what it carries and offers no
// act about it.
import type { ServerView } from "../../shared/api-types.ts";
import { isMasterRole } from "../../shared/enums.ts";

/** One sentence for a machine carrying the master part: what it carries, on which branch and stage.
 *  Null for every other machine: the slave part of a machine that carries no master part is what
 *  deploying it establishes, and the card says that in its lifecycle (pages/Servers.tsx). */
export function masterPartsLine(server: ServerView): string | null {
  if (!isMasterRole(server.role)) return null;
  const cluster = server.cluster;
  return cluster
    ? `${server.name} carries the master part and the slave part: it operates the management plane and runs workloads on its own branch ${cluster.domain} (${cluster.stage}), the one cluster the machine keeps.`
    : `${server.name} carries the master part and the slave part, and this manager records no cluster for it.`;
}
