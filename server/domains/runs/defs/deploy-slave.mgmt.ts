import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Step, StepCtx, Cleanup } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { clusters } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx } from "../../../executor/stepkit.ts";
import { registerSecret } from "../../../security/redact.ts";
import type { Stage } from "../../../../shared/enums.ts";
import { removeSlaveMarkingPart, clusterMarkingPath } from "../../inventory/cluster-marking.ts";
import {
  openServeConversation, composeAnswers, programPhase, requireElevationPassword,
  ANSIWISE_PROGRAM_TIMEOUT_MS, type AnsiwisePorts, type ProgramCheckpoint,
} from "./ansiwise-run.kit.ts";
import {
  loadServer, loadMaster, masterFqdnOf, requireSlaveCluster, slaveApiHost, sealTokenOnce, credLabels,
  requirePlatformRepo, statedTarget,
  type DeploySlavePorts, type SlaveTarget,
} from "./deploy-slave.kit.ts";
import { MgmtCredsBlob, CLUSTER_CREDENTIALS_PATH, SLAVE_API_PORT } from "./deploy-slave.remote.ts";

// The management-plane half of deploy-slave: the ONE cross-cluster credential handshake
// (emit-cluster-credentials on the slave, register-slave on the master) and its inverse, the
// remove-slave program as the run's compensating action. Split out of deploy-slave.ts (the
// file-size doctrine, files ≤400 lines).
//
// THE ONE-ADDRESS LAW. The address the master's in-cluster components dial the slave's
// kube-apiserver on is resolved ONCE (slaveApiHost) and handed as THE SAME answer to
// emit-cluster-credentials, to register-slave, and — by mark-slave — into the cluster map's
// apiHost. One stated spelling instead of two sources compared afterwards, which is what the old
// drift check between the map and the emitted blob existed to catch.

const EMIT_PROGRAM = "emit-cluster-credentials";
const REGISTER_PROGRAM = "register-slave";
const REMOVE_PROGRAM = "remove-slave";

/** What create-mgmt persists across re-entries: the register-slave program's checkpoint (the
 *  re-attachable half) plus the non-secret facts sealed on the way to it. */
interface CreateMgmtCheckpoint extends ProgramCheckpoint {
  server?: string;
  slaveId?: number;
  clusterBearerCredId?: string;
  reviewerJwtCredId?: string;
}

/** Read the credentials file emit-cluster-credentials left on the slave, and remove it. stdout
 *  carries ONLY the file and is captured WITHOUT ctx.log: the registration token inside is
 *  cluster-admin on the slave — a leaked file is RCE across the clusters. Every captured byte is
 *  registered with the redactor BEFORE anything can throw. The parse failure is deliberately
 *  static: the raw content must never ride an error message into steps.error. The removal is
 *  best-effort — a leftover file is re-written by the next emit run, and it is 0600 on the box the
 *  credentials were minted for. */
async function readClusterCredentials(ctx: StepCtx, session: SshSession, signal: AbortSignal): Promise<z.infer<typeof MgmtCredsBlob>> {
  const lines: string[] = [];
  const read = await session.exec(`cat ${CLUSTER_CREDENTIALS_PATH}`, {
    signal,
    timeoutMs: 30_000,
    onStdout: (l) => {
      lines.push(l); // NEVER ctx.log — this is the credentials file
    },
    onStderr: (l) => ctx.log("stderr", l),
  });
  const raw = lines.join("\n").trim();
  if (raw.length > 0) registerSecret(ctx.runId, Buffer.from(raw, "utf8"));
  if (read.code !== 0 || raw.length === 0) {
    throw errValidation(
      `could not read the emitted cluster credentials off the slave (${CLUSTER_CREDENTIALS_PATH}, exit ${read.code}) — ` +
      "the emit run above reported green, so read the slave's own run record; retrying the step emits again",
    );
  }
  let blob: z.infer<typeof MgmtCredsBlob>;
  try {
    blob = MgmtCredsBlob.parse(JSON.parse(raw));
  } catch {
    throw errValidation("the slave did not emit a valid cluster-credentials file ({server, caData, argocdToken, reviewerToken})");
  }
  registerSecret(ctx.runId, Buffer.from(blob.argocdToken, "utf8"));
  registerSecret(ctx.runId, Buffer.from(blob.reviewerToken, "utf8"));
  try {
    await session.exec(`rm -f ${CLUSTER_CREDENTIALS_PATH}`, { signal: ctx.signal });
  } catch {
    // best-effort — see above
  }
  return blob;
}

/** `create-mgmt`: emit the slave's management credentials on the slave, carry them over the
 *  sessions this run already holds, and register the slave on the master — both acts programs of
 *  the machine's own catalogue, each proven by a dry run the machine's gate then admits the real
 *  run against. ONE step, the rejoin step's shape and for the same reason: the credentials file is
 *  deleted the moment it is read, so a step that inherited the values from an earlier one could
 *  never be retried on its own — a retry emits again (the emit re-reads the same long-lived token
 *  Secrets, so asking twice hands back the same values).
 *
 *  The emit is NEVER checkpointed; register-slave IS, because it is the re-attachable half — a
 *  re-entry with its live run in flight re-attaches instead of starting a second one, and the
 *  sealing below therefore happens BEFORE the register phases, while the values are in hand.
 *  Re-running this step with a fresh emit is also the RE-POINT path: register-slave rewrites the
 *  mount and the registration entry from the answers it is given. */
export function createMgmtStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "create-mgmt",
    title: "Create the master-side slave-management plane (emit on the slave, register on the master)",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const master = loadMaster(ctx.db);
      const cluster = requireSlaveCluster(ctx.db, domain);
      const password = requireElevationPassword(ctx);
      localTx(ctx, (tx) => tx.update(clusters).set({ planeState: "creating" }).where(eq(clusters.id, cluster.id)).run());

      // The one resolution of the dial address (see the file header). Validated because it rides
      // program answers and the cluster map — refuse garbage early, naming the row to fix.
      const apiHost = slaveApiHost(server);
      if (!/^[a-z0-9._:-]+$/i.test(apiHost)) {
        throw errValidation(`server ${server.name} has a malformed API address "${apiHost}" — fix the inventory row (tailnetHost, lanHost or host)`);
      }
      const apiServerUrl = `https://${apiHost}:${SLAVE_API_PORT}`;

      const cp = ctx.readCheckpoint<CreateMgmtCheckpoint>() ?? { program: REGISTER_PROGRAM };
      const save = (): void => ctx.checkpoint(cp);
      // A finished RED machine run is a settled verdict, not a state to re-attach to (the rejoin
      // step's law): a retry registers AGAIN — fresh emit, fresh proof, new machine run. Dropping
      // a red live drops the dry with it, because the retry's emit may hand rotated tokens and a
      // proof of the old ones no longer proves the input.
      if (cp.dry !== undefined && cp.dry.exitCode !== undefined && cp.dry.exitCode !== 0) delete cp.dry;
      if (cp.live !== undefined && cp.live.exitCode !== undefined && cp.live.exitCode !== 0) {
        delete cp.live;
        delete cp.dry;
      }
      const budget = AbortSignal.timeout(ANSIWISE_PROGRAM_TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, budget]);
      try {
        // The secret answers are needed exactly while a register POST can still happen. Once the
        // live run has started, a re-entry only re-attaches to it and the slave is asked nothing.
        const fresh: Record<string, string> = {};
        if (cp.live === undefined) {
          const slave = await ctx.ssh(); // the run's ownsHost target
          const emit = await openServeConversation(ctx, slave, ports, signal);
          try {
            const emitCp: ProgramCheckpoint = { program: EMIT_PROGRAM };
            const nosave = (): void => undefined;
            const emitAnswers = await composeAnswers(ctx, emit.client, EMIT_PROGRAM, target, signal, async () => ({ api_server_url: apiServerUrl }));
            const proof = await programPhase(ctx, emit.client, emitCp, "dry", { program: EMIT_PROGRAM, answers: emitAnswers, password, signal, save: nosave });
            if (proof.exitCode !== 0) {
              throw errValidation(
                `the slave cannot emit its management credentials — the DRY run of ${EMIT_PROGRAM} is not green ` +
                `(run ${proof.id}, exit ${proof.exitCode}); nothing was minted — fix what the machine named, then retry the step`,
              );
            }
            const minted = await programPhase(ctx, emit.client, emitCp, "run", { program: EMIT_PROGRAM, answers: emitAnswers, password, signal, save: nosave });
            if (minted.exitCode !== 0) {
              throw errValidation(
                `the ${EMIT_PROGRAM} run on the slave failed (run ${minted.id}, exit ${minted.exitCode}) — ` +
                "read the slave's run record, then retry the step (the emit re-reads the same token Secrets, so asking again is safe)",
              );
            }
            ctx.log("meta", `${EMIT_PROGRAM}: dry ${proof.id} proved it, run ${minted.id} performed it — the credentials stand in ${CLUSTER_CREDENTIALS_PATH} on the slave (api server ${apiServerUrl})`);
          } finally {
            emit.close();
          }
          const blob = await readClusterCredentials(ctx, slave, signal);

          // Seal the DURABLE creds and persist the kube-access facts NOW, while the values are in
          // hand — a re-entry that only re-attaches to the register run never re-reads the file.
          // sealTokenOnce is retry-robust (reuse / rotate-in-place / seal); the cluster row is the
          // sanctioned non-secret cross-step channel, MERGED so a redeploy that crashes before
          // register keeps a live slave's plane intact.
          const labels = credLabels(server.name);
          ctx.log("meta", `sealing the cluster bearer credential ("${labels.bearer}")...`);
          cp.clusterBearerCredId = await sealTokenOnce(ctx, { kind: "kubeconfig", label: labels.bearer, serverId: target.serverId, token: blob.argocdToken });
          ctx.log("meta", `sealing the vault reviewer credential ("${labels.reviewer}")...`);
          cp.reviewerJwtCredId = await sealTokenOnce(ctx, { kind: "other", label: labels.reviewer, serverId: target.serverId, token: blob.reviewerToken });
          localTx(ctx, (tx) => {
            const existingPlane = (cluster.planeJson as Record<string, unknown> | null) ?? {};
            tx.update(clusters).set({ planeJson: { ...existingPlane, kube: { server: blob.server, caData: blob.caData } } }).where(eq(clusters.id, cluster.id)).run();
          });
          cp.server = blob.server;
          cp.slaveId = cluster.slaveId;
          save();

          fresh["ca_data"] = blob.caData;
          fresh["argocd_token"] = blob.argocdToken;
          fresh["reviewer_token"] = blob.reviewerToken;
        }

        const mSession = await ctx.ssh(master.id); // the AUX target — declared in `targets`
        const conversation = await openServeConversation(ctx, mSession, ports, signal);
        try {
          const answers = await composeAnswers(ctx, conversation.client, REGISTER_PROGRAM, target, signal,
            async () => ({ slave_fqdn: domain, master_fqdn: masterFqdnOf(ctx.db, loadMaster(ctx.db)), api_server_url: apiServerUrl, ...fresh }));
          const dry = await programPhase(ctx, conversation.client, cp, "dry", { program: REGISTER_PROGRAM, answers, password, signal, save });
          if (dry.exitCode !== 0) {
            throw errValidation(
              `the DRY run of ${REGISTER_PROGRAM} on the master is not green (run ${dry.id}, exit ${dry.exitCode}) — ` +
              "nothing was registered; fix what the machine named, then retry the step (it emits fresh credentials and proves the current input)",
            );
          }
          const live = await programPhase(ctx, conversation.client, cp, "run", { program: REGISTER_PROGRAM, answers, password, signal, save });
          if (live.exitCode !== 0) {
            throw errValidation(
              `the ${REGISTER_PROGRAM} run on the master failed (run ${live.id}, exit ${live.exitCode}) — read the run log; ` +
              "the program is idempotent end-to-end, so a retry of this step registers again from a fresh emit",
            );
          }
          ctx.log("meta", `${REGISTER_PROGRAM}: dry ${dry.id} proved it, run ${live.id} performed it — auth mount kubernetes-${server.name}, policies, consumables and AppProject ${server.name} stand on the master`);
        } finally {
          conversation.close();
        }
        ctx.log("meta", `slave ${server.name} registered on the master; bearer + reviewer sealed (${cp.clusterBearerCredId}, ${cp.reviewerJwtCredId})`);
      } catch (err) {
        if (budget.aborted && !ctx.signal.aborted) {
          throw errValidation(
            `create-mgmt did not finish within ${ANSIWISE_PROGRAM_TIMEOUT_MS / 60_000} min — a machine run in flight keeps ` +
            "going detached; retry the step to re-attach to it (the checkpoint holds its id)",
          );
        }
        throw err;
      }
    },
  };
}

/** The compensating action for everything the master holds about one slave: the remove-slave
 *  program — coordinator membership, the consumable entries, the auth mount with its roles, the
 *  policies, the role widening, the reconciler project. The map's slave part is dropped FIRST,
 *  which is the program's own contract: dropping it is what tears the generated per-slave instance
 *  down, so the reconciler project is already unreferenced when the program deletes it (the
 *  remove-slave-marking cleanup that runs later then finds nothing left to drop). Built per run
 *  because a cleanup carries no ports of its own. */
export function removeSlaveCleanup(ports: DeploySlavePorts & AnsiwisePorts): Cleanup {
  return {
    name: "remove-slave",
    title: "Remove the slave's management plane from the master (map part, then the remove-slave program)",
    run: async (ctx: StepCtx) => {
      const domain = String(ctx.params.domain);
      const stage = String(ctx.params.stage) as Stage;
      const { changed } = await removeSlaveMarkingPart(requirePlatformRepo(ports), domain, ctx.runId);
      ctx.log("meta", changed
        ? `dropped the slave part of ${clusterMarkingPath(domain)} — the generated per-slave instance goes before its project`
        : `${clusterMarkingPath(domain)} carries no slave part — straight to the program`);

      const password = requireElevationPassword(ctx);
      const master = loadMaster(ctx.db);
      const session = await ctx.ssh(master.id);
      const budget = AbortSignal.timeout(ANSIWISE_PROGRAM_TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, budget]);
      const conversation = await openServeConversation(ctx, session, ports, signal);
      try {
        // The cluster row may already be gone or parked — the answers need only what the params
        // state, so the target is the stated one, never the active-cluster lookup.
        const target = statedTarget(String(ctx.params.serverId), domain, stage);
        const cp: ProgramCheckpoint = { program: REMOVE_PROGRAM };
        const nosave = (): void => undefined;
        const answers = await composeAnswers(ctx, conversation.client, REMOVE_PROGRAM, target, signal, async () => ({ slave_fqdn: domain, master_fqdn: masterFqdnOf(ctx.db, loadMaster(ctx.db)) }));
        const dry = await programPhase(ctx, conversation.client, cp, "dry", { program: REMOVE_PROGRAM, answers, password, signal, save: nosave });
        if (dry.exitCode !== 0) {
          throw errValidation(
            `the DRY run of ${REMOVE_PROGRAM} on the master is not green (run ${dry.id}, exit ${dry.exitCode}) — ` +
            "nothing was destroyed (a coordinator that will not answer stops it here); fix what the machine named, then run the cleanup again",
          );
        }
        const live = await programPhase(ctx, conversation.client, cp, "run", { program: REMOVE_PROGRAM, answers, password, signal, save: nosave });
        if (live.exitCode !== 0) {
          throw errValidation(
            `the ${REMOVE_PROGRAM} run on the master failed (run ${live.id}, exit ${live.exitCode}) — read the run log; ` +
            "running the removal again once the machine answers completes it",
          );
        }
        ctx.log("meta", `${REMOVE_PROGRAM}: dry ${dry.id} proved it, run ${live.id} performed it — the slave's management plane is gone from the master`);
      } finally {
        conversation.close();
      }
    },
  };
}
