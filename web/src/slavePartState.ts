// WHICH PARTS THE MACHINE THIS MANAGER RUNS ON CARRIES, and whether its card offers the run that
// adds the other one. A pure module beside tailnetState.ts and machineIdentity.ts, for the reason
// those are: vitest runs with environment "node" and includes no .tsx, so wording left inside the
// page cannot be tested — and wording is the whole substance here.
//
// A machine carrying the MASTER part operates the management plane: the ArgoCD, the Vault and the
// registrations every other cluster of the installation is driven from. It may carry the SLAVE part
// as well, and then it also runs workloads on the one cluster it keeps — `cluster-deploy-slave`
// takes a master there by REGENERATING ITS OWN BRANCH under the combined role (the run's master arm,
// server/domains/runs/defs/deploy-slave.master.ts). One machine, one branch, one cluster: no second
// cluster row is written and no per-slave management plane is built, because the plane a slave is
// given is the one this machine already operates.
//
// THE OFFER CARRIES THE RUN'S TWO PARAMETERS rather than a form asking for them. The domain and the
// stage a master takes the slave part on are its OWN cluster's — the plan refuses any others — so
// there is nothing for a person to state and nothing to get wrong, which is the shape redeploy and
// the tailnet repairs already have (web/src/api.ts).
//
// THE SENTENCES ARE THE PLAN'S OWN. Where the card withholds the offer it says what the plan would
// refuse, in the words the plan refuses in; the plan asks every one of those questions again, because
// a browser is not a boundary. And no sentence here tells the operator to do something — the card's
// own button is the button, the same rule the readings beside it are written under.
import type { ServerView } from "../../shared/api-types.ts";
import { isMasterRole, type ServerRole, type Stage } from "../../shared/enums.ts";

/** The role a machine standing under BOTH parts carries — what the run writes onto the row once the
 *  regenerated map states it, and what this card reads to say the part is carried. Spelled once per
 *  side (the run's own spelling is MASTER_AND_SLAVE_ROLE), and `satisfies ServerRole` so a rename of
 *  the literal in shared/enums.ts stops this build. */
const BOTH_PARTS = "master+slave" satisfies ServerRole;

export interface SlavePartBlock {
  /** One sentence on the card: which parts the machine carries, and on which branch and stage. */
  line: string;
  /** The run's two parameters — the machine's OWN domain and stage — where the card offers the act,
   *  and null where it does not. ONE value, so the sentence above and the run started below name one
   *  cluster and cannot come to name two. */
  offer: { domain: string; stage: Stage } | null;
}

/**
 * What a machine carrying the master part says about its parts, and whether it offers to take the
 * other one. Null for every other machine: the slave part of a machine that carries no master part
 * is what deploying it establishes, and the card says that in its lifecycle (pages/Servers.tsx).
 *
 * Total over the four states the one master row can be in — it carries both parts already, it keeps
 * no cluster, its cluster is not live, or it stands ready to take the part — because each of them is
 * a different sentence and three of them are a plan that would refuse.
 *
 * An OPEN RUN withholds the offer and changes no sentence. What the machine carries is what it
 * carries while a run is in flight; the run is the card's one next step, and a second plan started
 * beside it would wait on the first one's locks anyway.
 */
export function slavePartBlock(server: ServerView, o: { runOpen: boolean }): SlavePartBlock | null {
  if (!isMasterRole(server.role)) return null;
  const cluster = server.cluster;
  if (server.role === BOTH_PARTS) {
    return {
      line: cluster
        ? `${server.name} carries the master part and the slave part: its own branch ${cluster.domain} (${cluster.stage}) stands under role ${BOTH_PARTS}, on the one cluster the machine keeps.`
        : `${server.name} carries the master part and the slave part, and this manager records no cluster for it.`,
      offer: null,
    };
  }
  if (!cluster) {
    return {
      line: `${server.name} carries the master part and this manager records no cluster for it — the slave part is added to the master's OWN cluster, and there is none here to add it to.`,
      offer: null,
    };
  }
  if (cluster.status !== "active") {
    return {
      line: `${server.name} carries the master part and its cluster ${cluster.domain} is '${cluster.status}' — the master takes the slave part on its own LIVE cluster, which is the one its platform already runs from.`,
      offer: null,
    };
  }
  return {
    line:
      `${server.name} carries the master part alone: it operates the management plane and runs no workloads of its own. ` +
      `Taking the slave part regenerates its own branch ${cluster.domain} (${cluster.stage}) under role ${BOTH_PARTS} and ` +
      `re-runs its machine layer from it, on the one cluster the machine already keeps.`,
    offer: o.runOpen ? null : { domain: cluster.domain, stage: cluster.stage },
  };
}
