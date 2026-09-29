// The shared Headlamp's slave contexts after a slave came or went (hostyour-cloud#255): the last step
// of deploy-slave, of redeploy's slave arm, and of remove-slave. SOFT, like the verify step's
// observability checks: the cluster picker is a convenience, so a failure is written into the run's
// log with its reason while the slave stays as the steps before left it, and the Manager's next start
// writes the contexts again.
import type { Step } from "../../../executor/types.ts";
import type { HeadlampKubeconfig } from "../../../adapters/kube/port.ts";
import { syncHeadlampContexts } from "../../inventory/headlamp-contexts.ts";

export function headlampContextsStep(ports: { headlamp?: HeadlampKubeconfig }): Step {
  return {
    name: "headlamp-contexts",
    title: "Offer the installation's slaves in the shared Headlamp",
    run: async (ctx) => {
      if (!ports.headlamp) {
        ctx.log("meta", "the shared Headlamp is not wired on this Manager, so its slave contexts were not written");
        return;
      }
      try {
        ctx.log("meta", await syncHeadlampContexts({ db: ctx.db, headlamp: ports.headlamp }));
      } catch (err) {
        ctx.log("meta", `⚠ the shared Headlamp's slave contexts could not be written (${err instanceof Error ? err.message : String(err)}); the slave is not affected, and the Manager's next start writes them again`);
      }
    },
  };
}
