import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../../../db/client.ts";
import type { Plan, Step, StepCtx } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { resolveTransport, VIA_LABEL } from "../../../executor/transport.ts";
import { isMasterRole, type RunKind } from "../../../../shared/enums.ts";
import { registerSecret } from "../../../security/redact.ts";
import { recordTailnetReading } from "../tailnet-probe.ts";
import { clusterShortName } from "../../inventory/cluster-marking.ts";
import { activeClusterTarget, loadMaster, loadServer, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import {
  ansiwiseProgramStep, composeAnswers, openServeConversation, programPhase, requireElevationPassword,
  ANSIWISE_ELEVATION_SECRET, ANSIWISE_PROGRAM_TIMEOUT_MS, type AnsiwisePorts, type ProgramCheckpoint,
} from "./ansiwise-run.kit.ts";

// The shared half of the three tailnet repair run kinds (defs/tailnet.ts): the steps they are composed
// of and the one plan builder they all state their targets in. The ACTS themselves are the tailnet
// PROGRAMS of the machine's own catalogue (digita-deploy ansiwise/programs/), each driven over the
// machine's `ansiwise serve` surface and proven by a dry run the machine's gate then admits the
// real run against — nothing here ships a script to a host any more.
//
// WHAT MAKES THESE RUN KINDS DIFFERENT FROM EVERY OTHER RUN. Each one reaches its host on the PUBLIC
// address — servers.host, stated on the plan's own target (RunTargetRef.transport) and resolved by
// executor/transport.ts — because an act that takes a host off the private network, or puts it
// back, cannot travel over that network. Nothing else about them is special: a plan, an approval,
// steps and a log, like every run kind.
//
// A run in flight is not cut by a disconnect. Nothing in this controller dials a tailnet address:
// every SSH session goes to servers.lan_host or servers.host, so what a disconnect takes away is
// the host's membership of the private network, not this controller's way to it.

/** What the three run kinds need beyond the inventory: the command that serves the machine's programs
 *  (every act is a program run), and — for a rejoin — the platform repo the coordinator's address
 *  is read off. */
export interface TailnetPorts extends DeploySlavePorts, AnsiwisePorts {}

/** The two programs a rejoin drives, by the catalogue's own names. The two single-host run kinds need
 *  no constant: their programs are named exactly like the RUN KINDS, and tailnetSteps hands the
 *  kind through. */
const MINT_PROGRAM = "tailnet-mint-join-key";
const REJOIN_PROGRAM = "tailnet-rejoin";

/** The run kinds this kit builds — every RUN_KIND literal in the tailnet family, named by the family
 *  rather than listed, so a fourth one cannot be added to the enum without the map below refusing
 *  to compile. */
export type TailnetKind = Extract<RunKind, `tailnet-${string}`>;

/** WHICH repair a run is. Three acts, not one with a switch — see the def file for what each one
 *  honestly means and where the line between reconnect and rejoin runs. Derived from the kind and
 *  never passed beside it: a plan built for one kind in the shape of another would be a run that
 *  says one thing and does the other. */
type TailnetMode = "disconnect" | "reconnect" | "rejoin";

const MODE: Record<TailnetKind, TailnetMode> = {
  "tailnet-disconnect": "disconnect",
  "tailnet-reconnect": "reconnect",
  "tailnet-rejoin": "rejoin",
};

/** Step 0 of all three, and the reason they are declared mutating: the public address is the one
 *  most exposed to being handed to a different machine, so the run proves the box answering it is
 *  the box that was adopted before it changes anything on it. attestMachineId records the id on a
 *  row that carries none and hard-fails on a mismatch, and the executor then makes this step unskippable. */
function attestTargetStep(serverId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the machine answering the public address",
    run: async (ctx) => {
      const session = await ctx.ssh();
      const outcome = await attestMachineId({ db: ctx.db, session, serverId, signal: ctx.signal, log: (l) => ctx.log("meta", l) });
      ctx.checkpoint({ machineId: outcome.machineId, machineIdAction: outcome.action });
    },
  };
}

/** WHERE the coordinator serves, as the machine's own rendered configuration states it:
 *  `global.tailnetUrl` in installation/profile.yaml on the cluster's install branch, written whole by
 *  the deployment programs (digita-deploy ansiwise/templates/installation-profile.tpl — always
 *  tale.<master>, one coordinator per installation). Read rather than re-composed: a second
 *  composition of the same rule is how the manager and the machine would come to disagree. Only
 *  the tailnetUrl slice of the file is parsed; everything else in it is ignored. */
const CLUSTER_PROFILE_PATH = "installation/profile.yaml";

const TailnetUrlSlice = z.object({
  global: z.object({ tailnetUrl: z.string().startsWith("https://").optional() }).optional(),
});

async function readLoginServer(ports: TailnetPorts, domain: string): Promise<string> {
  if (!ports.platformRepo) {
    throw errNotConfigured(
      "the platform repo is not configured — a rejoin reads the coordinator's address (global.tailnetUrl in " +
      `${CLUSTER_PROFILE_PATH}) off the cluster's own install branch, and reaching that branch needs GITHUB_REPO + ` +
      "GITHUB_WRITE_PAT (and MASTER_FQDN, which names the branch this installation keeps its books on)",
    );
  }
  const raw = await ports.platformRepo.withBranch(domain, (branch) => branch.readFile(CLUSTER_PROFILE_PATH));
  if (raw === null) {
    throw errValidation(
      `no ${CLUSTER_PROFILE_PATH} on the ${domain} branch — every install branch carries one (the deployment ` +
      "programs render it whole), so a branch without it was never generated by them",
    );
  }
  const parsed = TailnetUrlSlice.safeParse(parseYaml(raw));
  const url = parsed.success ? parsed.data.global?.tailnetUrl : undefined;
  if (url === undefined) {
    throw errValidation(
      `${CLUSTER_PROFILE_PATH} on the ${domain} branch carries no readable global.tailnetUrl — the coordinator's ` +
      "address is rendered there per install branch (https://tale.<master>), and a rejoin refuses to guess it",
    );
  }
  return url;
}

/** WHERE tailnet-mint-join-key leaves the credential on the master — the program's own key_file
 *  contract: /tmp/ansiwise-tailnet-join-key-<slave short name>, mode 0600, owned by the account
 *  the surface runs as. The name is the slave's first DNS label, the one derivation the whole
 *  platform files a slave under (clusterShortName). */
function mintedKeyPath(domain: string): string {
  return `/tmp/ansiwise-tailnet-join-key-${clusterShortName(domain)}`;
}

/** Read the minted credential off the master and remove the file. stdout carries ONLY the key and
 *  is captured WITHOUT ctx.log: a pre-auth key puts a machine of the holder's choosing on the
 *  private network. Every captured byte is registered with the redactor BEFORE anything can throw
 *  (mintTailnetJoinKey's idiom, deploy-slave.kit.ts). The removal is best-effort: a leftover file
 *  holds a spent or replaced key at worst, and the next mint run rewrites it. */
async function readMintedKey(ctx: StepCtx, session: SshSession, domain: string, signal: AbortSignal): Promise<string> {
  const path = mintedKeyPath(domain);
  const lines: string[] = [];
  const read = await session.exec(`cat ${path}`, {
    signal,
    timeoutMs: 30_000,
    onStdout: (l) => {
      lines.push(l); // NEVER ctx.log — this is the join credential
    },
    onStderr: (l) => ctx.log("stderr", l),
  });
  const key = lines.join("\n").trim();
  if (key.length > 0) registerSecret(ctx.runId, Buffer.from(key, "utf8"));
  if (read.code !== 0 || key.length === 0) {
    throw errValidation(
      `could not read the minted join credential off the master (${path}, exit ${read.code}) — the mint run above ` +
      "reported green, so read the master's own run record; retrying the step mints again (create-only: the same key comes back)",
    );
  }
  try {
    await session.exec(`rm -f ${path}`, { signal: ctx.signal });
  } catch {
    // best-effort — see above
  }
  return key;
}

/** Mint on the master, then log the host out and join it again — the whole repair in ONE step, so
 *  a retry of the step can always start over from the credential (deploy-slave.kit.ts, the
 *  asked-twice law: the executor never re-runs a step that already succeeded, so a step that
 *  inherited its credential from an earlier one could never be retried on its own).
 *
 *  The order inside the step is the safety: the mint program runs COMPLETELY — dry, which is the
 *  old preflight (a coordinator or a Vault that cannot produce a credential fails here), then the
 *  run that writes the key file — before the tailnet-rejoin program ever starts, and only THAT
 *  program's live run performs the logout. So every failure up to the last phase leaves the host
 *  exactly where it was.
 *
 *  The mint is NEVER checkpointed: it is create-only against the coordinator's own key listing
 *  (asking twice hands back the same key), and the key file is deleted as soon as it is read — a
 *  re-entry that still needs the value must ask the coordinator again. The rejoin program IS
 *  checkpointed, because it is the long half (logout, join, the certificate re-sign and the wait
 *  for readiness in one machine run) and a re-entry must re-attach to a run in flight rather than
 *  start a second one.
 *
 *  EXPORTED because deploy-slave's join is the same act: a fresh slave holds no credential, so the
 *  shape that mints, carries and spends in one step is the first join too — and the rejoin
 *  program's deliberate logout-first is a no-op on a machine that was never on the network. */
export function rejoinStep(target: SlaveTarget, serverId: string, ports: TailnetPorts): Step {
  return {
    name: "rejoin",
    title: "Mint on the master, then log the host out and join it again (one program run)",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const password = requireElevationPassword(ctx);
      const cp = ctx.readCheckpoint<ProgramCheckpoint>() ?? { program: REJOIN_PROGRAM };
      const save = (): void => ctx.checkpoint(cp);
      // A finished RED machine run is a settled verdict, not a state to re-attach to: this step IS
      // the repair, so a retry tries the repair AGAIN — fresh credential, fresh proof, new machine
      // run. A run still in flight keeps its mark and is re-attached below. Dropping a red live
      // drops the dry with it: the retry's mint may hand a replaced key, and a proof of the old
      // one no longer proves the input.
      if (cp.dry !== undefined && cp.dry.exitCode !== undefined && cp.dry.exitCode !== 0) delete cp.dry;
      if (cp.live !== undefined && cp.live.exitCode !== undefined && cp.live.exitCode !== 0) {
        delete cp.live;
        delete cp.dry;
      }
      const budget = AbortSignal.timeout(ANSIWISE_PROGRAM_TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, budget]);
      try {
        // The credential is needed exactly while a POST can still happen. Once the live run has
        // started, a re-entry only re-attaches to it and the master is asked for nothing.
        const fresh: Record<string, string> = {};
        if (cp.live === undefined) {
          // The coordinator's address FIRST: a branch that cannot state it stops the run before
          // any machine is asked anything.
          const loginServer = await readLoginServer(ports, domain);
          const master = loadMaster(ctx.db);
          const mSession = await ctx.ssh(master.id);
          const mint = await openServeConversation(ctx, mSession, ports, signal);
          try {
            const mintCp: ProgramCheckpoint = { program: MINT_PROGRAM };
            const nosave = (): void => undefined;
            const mintAnswers = await composeAnswers(ctx, mint.client, MINT_PROGRAM, target, signal, async () => ({ slave_fqdn: domain }));
            const proof = await programPhase(ctx, mint.client, mintCp, "dry", { program: MINT_PROGRAM, answers: mintAnswers, password, signal, save: nosave });
            if (proof.exitCode !== 0) {
              throw errValidation(
                `the master cannot mint ${domain}'s join credential — the DRY run of ${MINT_PROGRAM} is not green ` +
                `(run ${proof.id}, exit ${proof.exitCode}); the host was not touched — fix what the machine named, then retry the step`,
              );
            }
            const minted = await programPhase(ctx, mint.client, mintCp, "run", { program: MINT_PROGRAM, answers: mintAnswers, password, signal, save: nosave });
            if (minted.exitCode !== 0) {
              throw errValidation(
                `the ${MINT_PROGRAM} run on the master failed (run ${minted.id}, exit ${minted.exitCode}) — the host ` +
                "was not touched; read the master's run record, then retry the step (the mint is create-only, so asking again is safe)",
              );
            }
            ctx.log("meta", `${MINT_PROGRAM}: dry ${proof.id} proved the coordinator answers, run ${minted.id} minted — the credential stands in ${mintedKeyPath(domain)} on the master`);
          } finally {
            mint.close();
          }
          fresh["auth_key"] = await readMintedKey(ctx, mSession, domain, signal);
          fresh["login_server"] = loginServer;
        }
        const session = await ctx.ssh();
        const conversation = await openServeConversation(ctx, session, ports, signal);
        try {
          const answers = await composeAnswers(ctx, conversation.client, REJOIN_PROGRAM, target, signal, async () => fresh);
          const dry = await programPhase(ctx, conversation.client, cp, "dry", { program: REJOIN_PROGRAM, answers, password, signal, save });
          if (dry.exitCode !== 0) {
            throw errValidation(
              `the DRY run of ${REJOIN_PROGRAM} on the host is not green (run ${dry.id}, exit ${dry.exitCode}) — ` +
              "nothing was acted on and the host is still where it was; fix what the machine named, then retry the step (it mints again and proves the fresh input)",
            );
          }
          const live = await programPhase(ctx, conversation.client, cp, "run", { program: REJOIN_PROGRAM, answers, password, signal, save });
          if (live.exitCode !== 0) {
            throw errValidation(
              `the ${REJOIN_PROGRAM} run on the host failed (run ${live.id}, exit ${live.exitCode}) — the run log says ` +
              "how far it came; the logout may have landed without the join, leaving the host on NO network until a retry of this step repairs it (fresh mint, new machine run)",
            );
          }
          ctx.log("meta", `${REJOIN_PROGRAM}: dry ${dry.id} proved it, run ${live.id} performed it — logout, join and the certificate work in one machine run, green on the host's own record`);
        } catch (err) {
          // The one step that can leave a host somewhere its stored reading does not describe — so
          // the reading is taken here before the failure propagates: the card would otherwise go on
          // showing the membership this very step took away, on the one surface built to make it
          // visible. A probe that cannot run must not replace the failure with its own.
          try {
            await recordTailnetReading(ctx, session, serverId);
          } catch {
            // best-effort — see above
          }
          throw err;
        } finally {
          conversation.close();
        }
      } catch (err) {
        if (budget.aborted && !ctx.signal.aborted) {
          throw errValidation(
            `the rejoin did not finish within ${ANSIWISE_PROGRAM_TIMEOUT_MS / 60_000} min — a machine run in flight keeps ` +
            "going detached; retry the step to re-attach to it (the checkpoint holds its id)",
          );
        }
        throw err;
      }
    },
  };
}

/** The last step of all three: read the host and write the pair on its server row, through the one
 *  writer every other reading goes through (domains/runs/tailnet-probe.ts). Without it a card would
 *  go on showing the reading from before the repair — the state the operator asked the run kind to
 *  change. A probe that cannot run leaves the stored reading alone and says so in the log; it does
 *  not fail the step, because the act above already happened and calling the run failed would say
 *  the opposite. EXPORTED for deploy-slave, whose join changes exactly the same reading. */
export function readMembershipStep(serverId: string): Step {
  return {
    name: "read-membership",
    title: "Read the host's tailnet membership",
    run: async (ctx) => {
      const session = await ctx.ssh();
      ctx.checkpoint({ tailnetState: await recordTailnetReading(ctx, session, serverId) });
    },
  };
}

/** The active-cluster lookup is a HANDLE here, resolved only where a program declares an answer
 *  the cluster row states (composeAnswers) or where the rejoin needs the domain. tailnet-disconnect
 *  and tailnet-reconnect declare NO answers, so those two run on a host that carries no cluster at
 *  all — the machine that needs them most is exactly the one whose deploy went wrong. */
export function tailnetSteps(kind: TailnetKind, serverId: string, ports: TailnetPorts): Step[] {
  const target = activeClusterTarget(serverId);
  if (MODE[kind] === "rejoin") {
    return [attestTargetStep(serverId), rejoinStep(target, serverId, ports), readMembershipStep(serverId)];
  }
  // The kind IS the program's name for the two single-host run kinds — the catalogue names its
  // programs after the run kinds, and both declare no answers, so the generic program step fits whole.
  return [attestTargetStep(serverId), ansiwiseProgramStep(target, kind, ports), readMembershipStep(serverId)];
}

const SUMMARY: Record<TailnetMode, (o: { name: string; steps: number; host: string; master: string }) => string> = {
  disconnect: (o) =>
    `Take "${o.name}" off the tailnet: ${o.steps} steps, reaching it on its public address ${o.host} — the ` +
    `tailnet-disconnect program on the host's own ansiwise surface, proven by a dry run first. ` +
    `It keeps answering there afterwards, which is how the two run kinds that put it back reach it.`,
  reconnect: (o) =>
    `Put "${o.name}" back on the tailnet with the credential it already holds: ${o.steps} steps, reaching it on its ` +
    `public address ${o.host} — the tailnet-reconnect program on the host's own ansiwise surface. ` +
    `Nothing is minted and the master is not touched.`,
  rejoin: (o) =>
    `Log "${o.name}" out of the tailnet and join it again with a credential the tailnet-mint-join-key program mints ` +
    `on the master "${o.master}": ${o.steps} steps — the host on its public address ${o.host} (the tailnet-rejoin ` +
    `program does the logout, the join and the certificate work in one machine run), the master on its usual one.`,
};

const WARNINGS: Record<TailnetMode, string[]> = {
  disconnect: ["The host belongs to no private network afterwards, until a reconnect or a rejoin puts it back."],
  reconnect: ["A host whose credential is gone cannot re-establish this way — the run fails, and tailnet-rejoin is the run kind that mints a fresh one."],
  rejoin: [
    "The host is logged out before it joins again, so it is on no network for the length of this run.",
    "The mint is create-only: a stored credential the coordinator still accepts is handed back rather than replaced.",
    "The join hands the host a fresh private address and re-signs its serving certificate to it — the run waits for the node to come back ready.",
  ],
};

/**
 * The plan all three run kinds are approved on. What it states beyond the usual:
 *
 *  - the HOST target names `transport: "public"`, so the frozen plan_json records which of the
 *    server's two addresses this run was approved to use, and the executor opens the session on it
 *    (server/executor/transport.ts). The master, when a rejoin needs one, keeps the usual address:
 *    it is not the host whose network is being repaired.
 *  - the HOST target OWNS its host, which derives the `server:<id>` lock every host-mutating run
 *    takes. Without it a rejoin could run its logout on a slave while a deploy-slave in
 *    flight was joining it, both runs would report success, and the host would end up off the
 *    network with its single-use join credential already redeemed. A run that has SETTLED — the
 *    failed deploy-slave these run kinds exist for — holds no lock to be blocked by: every terminal
 *    path in the executor releases them (finishRun / failRun), whatever the outcome. The master,
 *    when a rejoin needs one, is not owned: the run drives its programs, it does not own the box.
 */
export function tailnetPlan(kind: TailnetKind, serverId: string, db: Db, ports: TailnetPorts): Plan {
  const mode = MODE[kind];
  const server = loadServer(db, serverId);
  if (isMasterRole(server.role)) {
    throw errValidation(
      `refusing: "${server.name}" carries the master part, and the master runs the tailnet coordinator — taking it off its own network is not a repair`,
    );
  }
  const resolved = resolveTransport(server, "public");
  const steps = tailnetSteps(kind, serverId, ports);
  const master = mode === "rejoin" ? loadMaster(db) : undefined;
  // A rejoin needs the FQDN of a cluster that is LIVE, because the credential is minted per slave
  // under that name. Resolved here and not only inside the steps: being refused at plan time beats
  // being refused after approval.
  if (mode === "rejoin") activeClusterTarget(serverId).resolve(db);
  return {
    kind,
    targetKind: "server",
    targetId: serverId,
    summary: SUMMARY[mode]({ name: server.name, steps: steps.length, host: `${resolved.host}:${server.sshPort}`, master: master?.name ?? "" }),
    steps: steps.map((s) => ({ name: s.name, title: s.title })),
    targets: [
      { serverId, ownsHost: true, label: `${server.name} (over its ${VIA_LABEL[resolved.via]})`, transport: "public" },
      ...(master ? [{ serverId: master.id, ownsHost: false, label: `${master.name} (master)` }] : []),
    ],
    warnings: WARNINGS[mode],
    // The programs raise their commands to root with a password the CALLER hands over per run
    // (the installation's ansiwise.yaml: password_from_caller) — collected at approve, held in
    // memory, sent with each POST /runs, persisted nowhere.
    requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
  };
}
