import { z } from "zod";
import { asc, eq, isNull } from "drizzle-orm";
import type { Step, StepCtx, RunDefinition, LockClaim, RunTargetRef } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { deploySlaveSteps } from "./deploy-slave.ts";
import { activeClusterTarget, loadMaster, masterFqdnOf } from "./deploy-slave.kit.ts";
import { ANSIWISE_ELEVATION_SECRET, PROGRAM_STEP_PREFIX } from "./ansiwise-run.kit.ts";
import type { RedeployPorts } from "./redeploy.ts";

// `cluster-redeploy-slaves` — the slave arm of `cluster-redeploy`, for every active slave in one run.
//
// ONE SLAVE'S STEP LIST, EACH STEP RUN FOR EVERY SLAVE. The list is deploySlaveSteps in redeploy mode,
// built per slave exactly as `cluster-redeploy` builds it, so nothing of a step is repeated here. What
// this run adds is the order across slaves: a step that acts on the slave alone, or only reads, runs on
// every slave at once; a step that writes the books branch, Vault, the master's cluster or the master's
// machine runs one slave after the other, because two of those at once would race on one branch, one
// store and one machine. A step name this file does not know runs one slave after the other.
//
// ONE RUN HOLDS WHAT EVERY SLAVE'S REDEPLOY CLAIMS. `cluster-redeploy` holds the books branch, the
// master's Vault and the master's cluster for its whole length, which is why two of them never run
// together; this run holds the same claims once, plus every slave's own branch and host.
//
// A STEP THAT FAILS ON ANY SLAVE lets the other slaves finish that step, and then the run fails naming
// every slave that failed. No later step runs, for any slave: every step measures before it acts, so
// the run is started again, or the one slave gets a `cluster-redeploy` of its own.

export const RedeploySlavesParams = z.object({});
export type RedeploySlavesParams = z.infer<typeof RedeploySlavesParams>;

/** The steps every slave runs at the same time: each acts on its own slave or only reads. */
export const CONCURRENT_STEPS: ReadonlySet<string> = new Set([
  "attest-target",
  "prove-elevation",
  "generate-key",
  "install-key",
  "verify-key-login",
  "enable-ntp",
  "remove-sudoers",
  "slave-preflight",
  "disable-password-login",
  "purge-bootstrap-password",
  "place-ansiwise",
  `${PROGRAM_STEP_PREFIX}deploy-host`,
  `${PROGRAM_STEP_PREFIX}deploy-cluster`,
  `${PROGRAM_STEP_PREFIX}deploy-platform-services`,
  "read-membership",
  "gitops-handoff",
  "verify-slave",
]);

export interface FleetSlave {
  serverId: string;
  name: string;
  domain: string;
}

/** Every pure slave whose cluster is active, by name. */
export function activeSlaves(db: Db): FleetSlave[] {
  return db
    .select({ serverId: servers.id, name: servers.name, role: servers.role, domain: clusters.domain, status: clusters.status })
    .from(servers)
    .innerJoin(clusters, eq(clusters.serverId, servers.id))
    .where(isNull(servers.deleted))
    .orderBy(asc(servers.name))
    .all()
    .filter((row) => !isMasterRole(row.role) && row.status === "active")
    .map(({ serverId, name, domain }) => ({ serverId, name, domain }));
}

/** [ctx] for one slave: the default session, params.serverId, the checkpoint and every log line are
 *  that slave's. The password door is refused, because a run keeps one and it reaches the run's first
 *  host, which is another slave for all but one of them. */
export function slaveCtx(ctx: StepCtx, slave: FleetSlave): StepCtx {
  type Checkpoints = Record<string, unknown>;
  return {
    ...ctx,
    params: { ...ctx.params, serverId: slave.serverId },
    logger: ctx.logger.child({ serverId: slave.serverId }),
    ssh: (serverId) => ctx.ssh(serverId ?? slave.serverId),
    attest: (serverId) => ctx.attest(serverId ?? slave.serverId),
    openPasswordSession: () =>
      Promise.reject(errValidation(
        `${slave.name} does not take this manager's key, and a run over every slave opens no password door, because it would reach another machine — redeploy ${slave.name} on its own`,
      )),
    closePasswordSession: () => {},
    log: (stream, text) => ctx.log(stream, text.split("\n").map((line) => (line === "" ? line : `[${slave.name}] ${line}`)).join("\n")),
    // Read and written in one synchronous turn, so two slaves writing at once cannot lose each other's.
    checkpoint: (data) => ctx.checkpoint({ ...(ctx.readCheckpoint<Checkpoints>() ?? {}), [slave.serverId]: data }),
    readCheckpoint: <T>() => ctx.readCheckpoint<Checkpoints>()?.[slave.serverId] as T | undefined,
  };
}

/** One step, run for every slave: at once where [concurrent], else one after the other. The step
 *  fails after every slave has had its turn, naming each slave it failed on. */
export function fleetStep(name: string, title: string, perSlave: ReadonlyArray<{ slave: FleetSlave; step: Step }>, concurrent: boolean): Step {
  return {
    name,
    title: `${title} — on every slave${concurrent ? " at once" : ", one after the other"}`,
    run: async (ctx) => {
      const failed: string[] = [];
      const runOne = async ({ slave, step }: { slave: FleetSlave; step: Step }): Promise<void> => {
        try {
          await step.run(slaveCtx(ctx, slave));
        } catch (err) {
          failed.push(`${slave.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      if (concurrent) {
        await Promise.all(perSlave.map(runOne));
      } else {
        for (const one of perSlave) {
          if (ctx.signal.aborted) {
            failed.push(`${one.slave.name}: not run, because the run was aborted`);
            continue;
          }
          await runOne(one);
        }
      }
      if (failed.length > 0) {
        throw errValidation(`${name} failed on ${failed.length} of ${perSlave.length} slave(s) — ${failed.join("; ")}`);
      }
    },
  };
}

/** Each slave's redeploy list, lined up step by step. The lists are built by one function from one
 *  mode, so they agree in length and order; a list that did not would pair one slave's step with
 *  another's, and is refused. */
export function redeploySlavesSteps(slaves: ReadonlyArray<FleetSlave>, ports: RedeployPorts): Step[] {
  const stepsOf = (serverId: string): Step[] => deploySlaveSteps({ target: activeClusterTarget(serverId), mode: "redeploy" }, ports);
  const lists = slaves.map((slave) => ({ slave, steps: stepsOf(slave.serverId) }));
  // With no slave the list keeps its shape, because the boot check reads its step 0 (guards.ts). A
  // step list only resolves its target when a step runs, and the plan refuses a run with no slave.
  const template = lists[0]?.steps ?? stepsOf("");
  for (const { slave, steps } of lists) {
    if (steps.length !== template.length || steps.some((s, i) => s.name !== template[i]!.name)) {
      throw errValidation(`the redeploy of ${slave.name} is not the step list of the other slaves, so the steps cannot be lined up`);
    }
  }
  return template.map((head, i) =>
    fleetStep(head.name, head.title, lists.map(({ slave, steps }) => ({ slave, step: steps[i]! })), CONCURRENT_STEPS.has(head.name)));
}

export function makeRedeploySlavesDef(ports: RedeployPorts): RunDefinition<RedeploySlavesParams> {
  return {
    kind: "cluster-redeploy-slaves",
    paramsSchema: RedeploySlavesParams,
    mutating: true,
    plan: async (_params, { db }) => {
      const slaves = activeSlaves(db);
      if (slaves.length === 0) throw errValidation("no slave carries an active cluster, so there is no machine layer to redeploy");
      const master = loadMaster(db);
      const books = masterFqdnOf(db, master);
      const stepDefs = redeploySlavesSteps(slaves, ports);
      const targets: RunTargetRef[] = [
        ...slaves.map((s) => ({ serverId: s.serverId, ownsHost: true, label: `${s.name} (slave)` })),
        { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
      ];
      const locks: LockClaim[] = [
        ...slaves.map((s) => ({ resource: "git-branch" as const, key: s.domain })),
        { resource: "git-branch", key: books },
        { resource: "master-vault", key: "m" },
        { resource: "master-kube", key: "m" },
      ];
      return {
        kind: "cluster-redeploy-slaves",
        targetKind: "installation",
        targetId: books,
        summary:
          `Rebuild the machine layer of every active slave in place — ${slaves.map((s) => s.name).join(", ")} — with the ` +
          `${stepDefs.length} steps of a slave's redeploy. Steps that act on a slave alone run on every slave at once; the ` +
          `ones that write the books branch, Vault or the master "${master.name}" run one slave after the other. A step ` +
          `that fails on any slave ends the run after that step and names the slave. The password you enter raises every ` +
          `root command on every slave and is held in memory for the length of the run; a slave that no longer takes this ` +
          `manager's key needs a redeploy of its own, because this run opens no password door.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets,
        locks,
        warnings: [`The machine layer re-runs on ${slaves.length} slave(s) at once — expect a brief kube-apiserver blip on each.`],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    // steps() is handed the persisted params and no database, so the slaves are read through the
    // port the def holds, as redeploy reads a server's role. A slave that became active after the
    // plan is not among the plan's targets, and its first session is refused by name.
    steps: () => redeploySlavesSteps(activeSlaves(ports.db), ports),
  };
}
