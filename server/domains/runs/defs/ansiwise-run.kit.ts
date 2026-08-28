import type { Step, StepCtx } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import type { ReleaseDownloads } from "../../../adapters/downloads/port.ts";
import { errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { AnsiwiseClient } from "../../../adapters/ansiwise/ansiwise-http.ts";
import { AnsiwiseRefused, type AnsiwiseEvent, type AnsiwiseRunRecord } from "../../../adapters/ansiwise/port.ts";
import { isMasterRole, type Stage } from "../../../../shared/enums.ts";
import { loadServer, loadMaster, sleepUnlessAborted, type SlaveTarget } from "./deploy-slave.kit.ts";
import { CATALOG_CHECKOUT, CATALOG_PROGRAMS } from "./machine-state.ts";

// Driving one ansiwise PROGRAM on a machine, through the machine's own REST surface — the step
// that replaces `setup.sh --<stage>` on hosts whose machine layer is delivered by the
// deploy-cluster / deploy-platform-services programs (digita-deploy ansiwise/programs/) instead of shell.
//
// THE SHAPE IS: prove, then act, and never re-implement the proof. `dry` first, asserted green
// off the machine's own record; then `run`, which the machine's gate only admits against a green
// dry of the SAME fingerprint (program + commit + answers). The gate lives in the binary
// (ansiwise-core Gate) — this step SEQUENCES it and reads `admitted_by` back, it never decides
// admission itself.
//
// THE RUN IS DETACHED ON THE MACHINE AND OUTLIVES THE CHANNEL. POST /runs answers 202 the moment
// the run is going; everything after that is read from the machine's record. So the step
// checkpoints the machine's run id and the last event sequence it saw, and a re-entry — after a
// manager crash, after the channel died mid-follow — RE-ATTACHES with ?from= instead of starting
// a second run. That matters most on the master: re-running deploy-cluster restarts kubelite,
// and the manager's own pod loses its API server mid-follow by design.

/** The name the elevation password rides under through approve (Plan.requiredSecrets →
 *  ctx.secrets). The installation's ansiwise.yaml says `password_from_caller: true`, so the
 *  password comes with each POST and lives exactly as long as the machine run does. */
export const ANSIWISE_ELEVATION_SECRET = "ansiwise-elevation";

/** One program's wall clock, dry and run each. The cold-install budget the host run
 *  used to get, for the same reason: a redeploy may bring a MicroK8s channel change with it.
 *  Expiry fails the STEP only — the machine run keeps going detached, and a retry re-attaches
 *  to it rather than starting a second one. */
export const ANSIWISE_PROGRAM_TIMEOUT_MS = 45 * 60_000;

/** How the manager starts the conversation: the command run over the target's SSH session whose
 *  stdio then speaks HTTP. WHICH checkout the service reads its programs from is that command's to
 *  say — configuration, never an assumption baked in here.
 *
 *  IT IS `ansiwise-rest serve` AND NOT `ansiwise-rest serve`. `serve` is the SESSION door of the serving
 *  binary — the surface over one session's own standard input and output, standing on no address and
 *  demanding no token because sshd authenticated the caller before the process existed (ansiwise-cli
 *  lib/src/rest/resident_service.dart `sessionProgram`). The deployment tool answers `no program is
 *  called serve`, because it runs programs of a catalogue and `serve` is not one. */
export interface AnsiwisePorts {
  ansiwiseServeCommand?: string;
  /** WHERE a machine's two executables are fetched from, with `<name>` standing for which of the
   *  release's assets and `<version>` for the version the platform repo pins (place-ansiwise). Which
   *  release surface an installation takes them from is its own decision; WHICH version is placed
   *  never is, and neither is which pair of names an engine is made of. */
  ansiwiseDownloadUrl?: string;
  /** WHERE A CATALOGUE COMES FROM for a machine that has none, and what opens it.
   *
   *  A SLAVE IS BORN WITHOUT ONE. install-master clones the catalogue onto a first master; nothing
   *  does it for a slave, and every program is read out of that checkout — so the machine's own
   *  surface cannot even start, and what an operator saw was the serving binary's `cd` failing and
   *  the socket hanging up. This manager holds the address and the credential already
   *  (kernel/config.ts `catalog`), which is what lets it make the checkout itself rather than wait
   *  for a program it cannot run.
   *
   *  Absent, the placing step says so and touches no tree: an installation that states no catalogue
   *  is one where a machine's own checkout is the only one there is. */
  catalogueOrigin?: { repoURL: string; token: string };
  /** WHERE those release assets are READ, which is over the manager's own network: the bootstrap
   *  hands a machine bytes rather than a download command, so a machine with no route out and no
   *  `curl` is still placeable (place-ansiwise.ts, THE TRANSFER). */
  releaseDownloads?: ReleaseDownloads;
}

export function requireServeCommand(ports: AnsiwisePorts): string {
  if (!ports.ansiwiseServeCommand) {
    throw errNotConfigured(
      "ANSIWISE_SERVE_COMMAND is not configured — this step reaches the machine's deployment programs through the " +
      "serving binary's SESSION door on the machine, and which command starts it (and so which catalogue checkout it " +
      "reads) is the installation's decision. It is a program of `ansiwise-rest` and not of `ansiwise`, which answers " +
      "`no program is called serve`. Set ANSIWISE_SERVE_COMMAND to the command that serves the surface on the session's " +
      `stdio, e.g. \`cd ${CATALOG_CHECKOUT} && ~/ansiwise-rest serve --programs ${CATALOG_PROGRAMS}\``,
    );
  }
  return ports.ansiwiseServeCommand;
}

/** One phase's progress, persisted so a re-entry re-attaches instead of re-starting. `seen` is
 *  the last event sequence rendered into the run log — the next follow asks `?from=seen+1`, so
 *  a crash costs at most the events since the last checkpoint, replayed. */
export interface PhaseMark {
  id: string;
  seen: number;
  exitCode?: number;
}

export interface ProgramCheckpoint {
  program: string;
  dry?: PhaseMark;
  live?: PhaseMark;
}

/** The elevation password, or the loud refusal every program step gives without it. */
export function requireElevationPassword(ctx: StepCtx): string {
  const password = ctx.secrets.get(ANSIWISE_ELEVATION_SECRET)?.toString("utf8");
  if (password === undefined || password.length === 0) {
    throw errValidation(
      `the "${ANSIWISE_ELEVATION_SECRET}" secret is gone (a restart drops run secrets) — retry the step and ` +
      "supply the machine's elevation password again; the programs raise their commands to root with it",
    );
  }
  return password;
}

/** One conversation with a machine's surface: `ansiwise-rest serve` on the session's stdio, spoken to
 *  by the typed client. The caller owns the session; close() ends the conversation only. */
export interface ServeConversation {
  client: AnsiwiseClient;
  close(): void;
}

export async function openServeConversation(
  ctx: StepCtx,
  session: SshSession,
  ports: AnsiwisePorts,
  signal: AbortSignal,
): Promise<ServeConversation> {
  const serveCommand = requireServeCommand(ports);
  const channel = await session.openChannel(serveCommand, {
    signal,
    onStderr: (line) => ctx.log("stderr", `serve: ${line}`),
  });
  const client = new AnsiwiseClient({ kind: "channel", stream: channel.stream });
  return {
    client,
    close: (): void => {
      client.close();
      channel.close();
    },
  };
}

/** Answers a DEF is authoritative for beyond the inventory row — facts the manager holds in the
 *  platform repo (a cluster map's build plane, apex, catalog repository) and can therefore state
 *  without asking the operator to re-type what stands written. Async because the source is the git
 *  port, and keyed by the PROGRAM's answer names: an entry no program declares is simply never
 *  sent (composeAnswers walks the declaration, not this record). A list-valued entry is an answer
 *  the program declares as text_list, sent as the JSON array the envelope's grammar takes. */
export type ExtraAnswers = (ctx: StepCtx) => Promise<Record<string, string | string[]>>;

/** What a program step takes beyond the program's name. `elevation_password` is deliberately NOT
 *  an ExtraAnswers concern although deploy-platform-services declares an answer of that name: the ENGINE
 *  fills that one from the password the POST carries beside the answers, and refuses a caller who
 *  sends it as an answer ("it is not an answer anybody sends"). */
export interface ProgramStepOpts {
  /** Answers the DEF is authoritative for beyond the inventory — see ExtraAnswers. */
  extra?: ExtraAnswers;
  /** Run the program on the MASTER's surface instead of the run's owned host — the master-side
   *  act of a two-machine run kind (deploy-slave's branch cut). The master must be declared on the
   *  plan's targets, exactly like every other aux session. */
  onMaster?: boolean;
}

/** WHICH program runs on WHICH surface — one entry per program step a run kind will take, in the
 *  order it takes them. `onMaster` reads exactly as it does in ProgramStepOpts above. */
export interface ProgramOnSurface {
  program: string;
  onMaster?: boolean;
}

/** `require-programs`: prove every program this run will drive is one the machine's catalogue
 *  carries, on the surface it will actually be driven over.
 *
 *  IT EXISTS BECAUSE OF WHERE THE ABSENCE WOULD OTHERWISE BE FOUND. composeAnswers reads a program's
 *  declaration off the machine (`GET /programs/{name}`), and a name nothing carries is a 404 THERE —
 *  inside the program step, which a release reaches only after set-pin has already minted the tag and
 *  committed the pin. An installation whose catalogue checkout is older than this manager would then
 *  be recorded standing on a release it never received, and the map and the branch would disagree —
 *  the one thing the `release` field exists to make impossible (cluster-marking.ts). Asking first
 *  costs one conversation per surface and puts that failure in front of every write.
 *
 *  It reads the LIST rather than each name, so one conversation answers for every program on that
 *  surface and a refusal can say what the catalogue DOES carry — the operator's next question either
 *  way. Nothing is acted on: this step only asks. */
export function requireProgramsStep(ports: AnsiwisePorts, programs: readonly ProgramOnSurface[]): Step {
  return {
    name: "require-programs",
    title: "Prove the machine's catalogue carries every program this run drives",
    run: async (ctx) => {
      const surfaces = [false, true].filter((onMaster) => programs.some((p) => (p.onMaster ?? false) === onMaster));
      const carried: Record<string, string[]> = {};
      for (const onMaster of surfaces) {
        const wanted = programs.filter((p) => (p.onMaster ?? false) === onMaster).map((p) => p.program);
        const where = onMaster ? "master" : "machine";
        const session = onMaster ? await ctx.ssh(loadMaster(ctx.db).id) : await ctx.ssh();
        const conversation = await openServeConversation(ctx, session, ports, ctx.signal);
        try {
          const names = (await conversation.client.programs({ signal: ctx.signal })).map((p) => p.name);
          const missing = wanted.filter((name) => !names.includes(name));
          if (missing.length > 0) {
            throw errValidation(
              `the ${where}'s catalogue carries no program called ${missing.map((m) => `"${m}"`).join(", ")} — it offers ` +
              `${names.join(", ")}. This run drives ${wanted.join(", ")} on that surface, and it is asked here rather ` +
              "than at the program step so that nothing is written first: a release commits its pin before the machine's " +
              "turn, and a pin naming a release the cluster never received is a record that contradicts itself. Bring " +
              "the machine's catalogue checkout onto a revision that carries the program, then retry the run",
            );
          }
          carried[where] = wanted;
          ctx.log("meta", `the ${where}'s catalogue carries ${wanted.join(", ")} — ${names.length} programs offered`);
        } finally {
          conversation.close();
        }
      }
      ctx.checkpoint(carried);
    },
  };
}

/** What a program step's name begins with. Exported so a reader can derive WHICH programs a run kind
 *  drives out of its own step list instead of carrying a second copy of them — the step name is the
 *  only place that fact stands. */
export const PROGRAM_STEP_PREFIX = "run-";

/** `run-<program>`: prove the program with a dry run, then run it, following both into the run
 *  log. Both phases go through the ONE machine surface and the machine's own gate. */
export function ansiwiseProgramStep(target: SlaveTarget, program: string, ports: AnsiwisePorts, opts: ProgramStepOpts = {}): Step {
  return {
    name: `${PROGRAM_STEP_PREFIX}${program}`,
    title: `Prove, then run, the ${program} program on the ${opts.onMaster ? "master" : "machine"} (dry → run)`,
    run: async (ctx) => {
      const cp = ctx.readCheckpoint<ProgramCheckpoint>() ?? { program };
      const save = (): void => ctx.checkpoint(cp);
      // The step's own wall clock, kept apart from ctx.signal: a cancel must stay a cancel,
      // and an expired budget must fail the step while the detached machine run keeps going.
      const budget = AbortSignal.timeout(ANSIWISE_PROGRAM_TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, budget]);

      const session = opts.onMaster ? await ctx.ssh(loadMaster(ctx.db).id) : await ctx.ssh();
      const conversation = await openServeConversation(ctx, session, ports, signal);
      try {
        const answers = await composeAnswers(ctx, conversation.client, program, target, signal, opts.extra);
        const password = requireElevationPassword(ctx);

        const dry = await programPhase(ctx, conversation.client, cp, "dry", { program, answers, password, signal, save });
        if (dry.exitCode !== 0) {
          throw errValidation(
            `the DRY run of ${program} on the machine is not green (run ${dry.id}, exit ${dry.exitCode}) — ` +
            "nothing was acted on; read the run log, fix what the machine named, then retry the step",
          );
        }
        const live = await programPhase(ctx, conversation.client, cp, "run", { program, answers, password, signal, save });
        if (live.exitCode !== 0) {
          throw errValidation(
            `the ${program} run on the machine failed (run ${live.id}, exit ${live.exitCode}) — ` +
            "read the run log; a retry of this step RE-READS that run's record and refuses again, " +
            "so fix the machine first, then clear the step by retrying the run from this step",
          );
        }
        ctx.log("meta", `${program}: dry ${dry.id} proved it, run ${live.id} performed it — both green on the machine's own record`);
      } catch (err) {
        if (budget.aborted && !ctx.signal.aborted) {
          throw errValidation(
            `${program} did not finish within ${ANSIWISE_PROGRAM_TIMEOUT_MS / 60_000} min — the machine run keeps ` +
            "going detached; retry the step to re-attach to it (the checkpoint holds its id)",
          );
        }
        throw err;
      } finally {
        conversation.close();
      }
    },
  };
}

/** The answers a program run is handed, composed from three places and NOWHERE hardcoded: what
 *  the inventory is authoritative for (the cluster row and the server row), what the DEF is
 *  authoritative for beyond that (the optional `extra` record — release reads the cluster map,
 *  where the manager keeps facts an operator must never re-type), then — for every answer the
 *  PROGRAM DECLARES beyond those — what the operator supplied at approve
 *  (`activation-input:<answer>`). The declaration is read off the machine (`GET
 *  /programs/{name}`), so which answers exist is the catalogue's to say; an answer nobody
 *  supplied is OMITTED, and the machine's own validation refuses it by name or fills its
 *  declared default — this step never re-implements either.
 *
 *  The target's CLUSTER is looked up lazily — only when the program declares an answer the cluster
 *  row states (fqdn, stage) does the lookup run. A program that declares neither (the tailnet
 *  client run kinds, whose real declarations carry no answers at all) therefore runs against a host
 *  that carries no cluster row. */
export async function composeAnswers(
  ctx: StepCtx,
  client: AnsiwiseClient,
  program: string,
  target: SlaveTarget,
  signal: AbortSignal,
  extra?: ExtraAnswers,
): Promise<Record<string, string | string[]>> {
  const server = loadServer(ctx.db, target.serverId);
  const extraAnswers = extra ? await extra(ctx) : {};
  let cluster: { domain: string; stage: Stage } | undefined;
  const resolved = (): { domain: string; stage: Stage } => (cluster ??= target.resolve(ctx.db));
  const inventory = (name: string): string | undefined => {
    switch (name) {
      case "fqdn": return resolved().domain;
      case "stage": return resolved().stage;
      case "role": return isMasterRole(server.role) ? "master" : "slave";
      case "operator_user": return server.sshUser;
      default: return undefined;
    }
  };
  const declared = await client.program(program, { signal });
  const answers: Record<string, string | string[]> = {};
  for (const spec of declared.answers) {
    const known = extraAnswers[spec.name] ?? inventory(spec.name);
    if (known !== undefined) {
      answers[spec.name] = known;
      continue;
    }
    const supplied = ctx.secrets.get(`activation-input:${spec.name}`)?.toString("utf8").trim();
    if (supplied !== undefined && supplied.length > 0) answers[spec.name] = supplied;
  }
  return answers;
}

/** One phase — the proof or the act — idempotent against the checkpoint:
 *   already green      ⇒ nothing is asked of the machine again;
 *   started earlier    ⇒ RE-ATTACH: follow `?from=seen+1`, never a second POST;
 *   not started        ⇒ POST it, then follow.
 *  The verdict is the RECORD's (`GET /runs/{id}`), never the stream's: a stream can be cut on
 *  its last line, and the record is what the machine itself stands behind. */
export async function programPhase(
  ctx: StepCtx,
  client: AnsiwiseClient,
  cp: ProgramCheckpoint,
  mode: "dry" | "run",
  o: { program: string; answers: Record<string, string | string[]>; password: string; signal: AbortSignal; save: () => void },
): Promise<PhaseMark> {
  const slot = mode === "dry" ? "dry" : "live";
  let mark = cp[slot];
  if (mark?.exitCode === 0) {
    ctx.log("meta", `${o.program} ${mode}: run ${mark.id} is already green — nothing to repeat`);
    return mark;
  }
  if (mark?.exitCode !== undefined) {
    // A FINISHED run that is not green is dropped rather than re-attached to, and this is the case
    // that made "retry the step" a lie. A re-entry keeps its checkpoint, so a red mark sent every
    // retry back to watch a run that had already ended red — the same verdict for ever, and nothing
    // an operator could do about it from the outside. What a retry means here is a fresh proof of
    // the CURRENT machine, so the mark goes and the branch below starts one.
    ctx.log(
      "meta",
      `${o.program} ${mode}: run ${mark.id} ended with exit ${mark.exitCode} — starting a fresh one, ` +
        "because a finished run cannot be retried by watching it again",
    );
    delete cp[slot];
    o.save();
    mark = undefined;
  }
  if (mark === undefined) {
    let accepted;
    try {
      accepted = await client.start(
        { program: o.program, mode, answers: o.answers, elevationPassword: o.password },
        { signal: o.signal },
      );
    } catch (err) {
      if (err instanceof AnsiwiseRefused && err.status === 409 && mode === "run") {
        // The gate said "not yet": the green dry this step holds no longer proves this input —
        // typically the machine's checkout moved between the two phases, which changes the
        // fingerprint. The stale proof is dropped so the retry proves the CURRENT input instead
        // of asking the same refused question forever.
        delete cp.dry;
        o.save();
        throw errValidation(
          `the machine's gate refused the ${o.program} run: ${err.reason} — the dry proof went stale ` +
          "(the input changed under it); retry the step to prove the current input and run it",
        );
      }
      throw err instanceof AnsiwiseRefused ? errValidation(`the machine refused to start ${o.program} (${mode}): ${err.reason}`) : err;
    }
    mark = { id: accepted.run, seen: -1 };
    cp[slot] = mark;
    o.save();
    const admitted = accepted.admitted_by !== undefined ? ` — admitted by dry ${accepted.admitted_by}` : "";
    const waived = accepted.waived !== undefined && accepted.waived.length > 0 ? ` — the installation WAIVED ${accepted.waived.join(", ")}` : "";
    ctx.log("meta", `${o.program} ${mode}: machine run ${mark.id} started (fingerprint ${accepted.fingerprint.slice(0, 12)}…)${admitted}${waived}`);
  } else {
    ctx.log("meta", `${o.program} ${mode}: re-attaching to machine run ${mark.id} from event ${mark.seen + 1}`);
  }

  // 202 means the run is GOING, not that its record exists yet: the run is a detached process
  // that writes its header a beat after it starts, so the follow waits for the record to appear
  // before it asks for events. A run that NEVER writes one died before its first step — the
  // "starts and dies where nobody is watching" case — and is refused by name, bounded.
  await appearedRecord(client, mark.id, o.program, o.signal);

  for await (const event of client.events(mark.id, { from: mark.seen + 1, signal: o.signal })) {
    logEvent(ctx, event);
    mark.seen = event.sequence;
    // Persisted on the boundaries a reader thinks in, not per line — a re-entry then replays at
    // most one step's worth of output into the log.
    if (event.kind === "step-started" || event.kind === "step-finished" || event.kind === "run-finished") o.save();
  }

  const record = await endedRecord(ctx, client, mark.id, o.signal);
  mark.exitCode = record.exit_code ?? -1;
  o.save();
  return mark;
}

/** The record once it EXISTS (see the wait in phase). 404 is the one refusal retried here,
 *  because right after a 202 it means "not written yet" — every other refusal stands. */
async function appearedRecord(client: AnsiwiseClient, id: string, program: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.run(id, { signal });
      return;
    } catch (err) {
      if (!(err instanceof AnsiwiseRefused) || err.status !== 404) throw err;
      if (attempt >= 40) {
        throw errValidation(
          `machine run ${id} (${program}) was accepted but never wrote its record — it started and died before its first step; read the machine's serve log`,
        );
      }
    }
    await sleepUnlessAborted(250, signal);
  }
}

/** The record once it carries an end. The events stream ends when the run does, but the header
 *  is a separate file the run child replaces — one bounded breath covers the moment between the
 *  last event and the rewritten header.
 *
 *  WHAT THE REFUSAL NAMES, AND WHY IT NAMES TWO FILES. The engine writes the closing header beside
 *  the real one and renames it over (ansiwise-core RunRecorder.save). On Windows that rename fails
 *  while any process holds run.json open and it carries no retry, so the end can be sitting in
 *  run.json.writing while run.json keeps the header the run began with — measured at 34 of 265 runs
 *  that had a reader, 0 of 100 that had none (simetrixch/ansiwise-core#65). A refusal that said only
 *  "read the record on the machine" sent the operator to the ONE file that is guaranteed not to
 *  carry the answer in exactly that case. */
async function endedRecord(ctx: StepCtx, client: AnsiwiseClient, id: string, signal: AbortSignal): Promise<AnsiwiseRunRecord> {
  for (let attempt = 0; ; attempt++) {
    const record = await client.run(id, { signal });
    if (record.end !== undefined) return record;
    if (attempt >= 20) {
      throw errValidation(
        `machine run ${id} streamed its last event but its record never ended. Read BOTH halves of ` +
          `the header on the machine: the run's run.json, and run.json.writing beside it. A ` +
          `run.json.writing carrying an exit_code that run.json does not is a rename the engine ` +
          `lost, which no further waiting can find`,
      );
    }
    ctx.log("meta", `machine run ${id}: events are over, waiting for the record to close`);
    await sleepUnlessAborted(500, signal);
  }
}

/** The machine run's events, rendered into THIS run's log — the operator watches one log. The
 *  kinds an operator reads are written through; the bookkeeping kinds stay on the machine's own
 *  record, which keeps every event and is the place to read a run forensically. */
function logEvent(ctx: StepCtx, e: AnsiwiseEvent): void {
  switch (e.kind) {
    case "output":
      ctx.log(e.stream === "stderr" ? "stderr" : "stdout", e.text ?? "");
      break;
    case "log":
      ctx.log("meta", `${e.step !== undefined ? `${e.step}: ` : ""}${e.message ?? ""}`);
      break;
    case "run-started":
      ctx.log("meta", `machine run started: ${e.program ?? ""} (${e.mode ?? ""})`);
      break;
    case "step-started":
      ctx.log("meta", `step ${e.step ?? "?"} started`);
      break;
    case "step-finished":
      ctx.log("meta", `step ${e.step ?? "?"}: ${e.verdict?.label ?? "?"}${e.verdict?.reason !== undefined ? ` — ${e.verdict.reason}` : ""}`);
      break;
    case "command-started":
      ctx.log("meta", `$ ${(e.argv ?? []).join(" ")}`);
      break;
    case "run-finished":
      ctx.log("meta", `machine run finished: exit ${e.exit_code ?? "?"}${e.issues !== undefined && e.issues.length > 0 ? ` — ${e.issues.join("; ")}` : ""}`);
      break;
    default:
      break;
  }
}
