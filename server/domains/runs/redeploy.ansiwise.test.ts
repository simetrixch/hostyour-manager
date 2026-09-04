import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers } from "../../db/schema/inventory.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { createSshSession } from "../../adapters/ssh/ssh2-session.ts";
import { generateServerKeypair } from "../../adapters/ssh/keygen.ts";
import { startFakeSshServer, type FakeSshServer } from "../../adapters/ssh/testing/fake-server.ts";
import { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import { AnsiwiseRefused } from "../../adapters/ansiwise/port.ts";
import { ansiwiseBinaries, NO_BINARY, startServe, type ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { isServe } from "./ansiwise-serve.fixture.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { activeClusterTarget } from "./defs/deploy-slave.kit.ts";

import {
  disposeHarnesses, ELEVATION_PASSWORD, MASTER_ID, SLAVE_ID, MINT_AUTHKEY,
  IMAGE_KEY_LINE, MASTER_PUBLIC_KEY, type Harness,
} from "./deploy-slave.fixture.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import {
  uniqueEmail, approveSecrets, elevationOnly, composedAnswers,
  fixturePrograms, serveConversation, liveMaster, tailnetHost,
  recordWindow, startedRuns, expectProven, settled, recordAppeared, observerStart, observerEnded, programStepCtx,
} from "./ansiwise-serve.fixture.ts";
import { orphanedEndSuite } from "./orphaned-end.ansiwise.suite.ts";
import { recordAppearsSuite } from "./record-appears.ansiwise.suite.ts";
import { deploySlaveSuite } from "./deploy-slave.ansiwise.suite.ts";

// EVERY run kind that drives the machine's deployment programs, on the REAL `ansiwise-rest serve`:
// redeploy (both arms), the tailnet repair run kinds, deploy-slave, and the transport
// underneath them all. Nothing here mocks the machine's surface: the serve fixture starts the
// actual binary on a minimal installation whose programs are pure measurements
// (require_answer_matches), so the gate, the answers validation, the detached run records and the
// ?from= resume are all the engine's own.
//
// ONE FILE ON PURPOSE: the engine's run root is per-drive ('/var/lib/ansiwise/runs'), so two
// test files each running a serve fixture in parallel would share records and collide. Everything
// that starts machine runs lives here, sequentially; the programs, the worlds and the plumbing
// live in ansiwise-serve.fixture.ts; the orphaned-end and deploy-slave suites live in
// orphaned-end.ansiwise.suite.ts and deploy-slave.ansiwise.suite.ts, registered INTO this file's
// describe rather than collected as separate files, for that same reason.
//
// TWO RUNS IN ONE SECOND MUST NOT BE ONE RUN. A machine naming a run by second + pid answers a
// service asked twice within a second with one id, and the two write over each other's record. The
// id carries four random bytes (ansiwise-cli _newRunId), which is why these tests can start
// runs back to back at all — the fixture's programs take milliseconds where a real one takes
// minutes, so this suite is where that defect shows.

const bin = ansiwiseBinaries();
const key = generateServerKeypair("test@manager");

/** What a step wrote down about what it FOUND — its own checkpoint's data, which is where a
 *  measure-then-act step records the reading its act was decided on. Read off the run's rows rather
 *  than off the machine, because the question is what the step reported and not only what the
 *  machine ended up holding. */
const found = (h: Harness, runId: string, step: string): Record<string, unknown> =>
  (JSON.parse(stepColumn(h.db, runId, step, "checkpoint_json") ?? "{}") as { data?: Record<string, unknown> }).data ?? {};

describe.skipIf(bin === undefined)("the manager's run kinds over the machine's own deployment programs (REAL ansiwise-rest serve)", () => {
  if (bin === undefined) {
    // eslint-disable-next-line no-console -- the skip must be loud, not silent (see NO_BINARY)
    console.warn(NO_BINARY);
  }

  let serve: ServeFixture;
  let ssh: FakeSshServer;
  /** Reads the machine's records directly — the ADDRESS wire, dialing the resident surface. */
  let observer: AnsiwiseClient;

  beforeAll(async () => {
    serve = await startServe(bin as { tool: string; rest: string }, fixturePrograms());
    // The channel form of the surface, and it is the real one (serveConversation): the binary's
    // own stdio is the connection, exactly what an SSH exec channel hands a process.
    ssh = await startFakeSshServer({
      authorizedKeys: [key.publicLine],
      conversations: { "ansiwise-rest serve": serveConversation(serve) },
    });
    observer = new AnsiwiseClient({ kind: "address", host: "127.0.0.1", port: serve.port, token: serve.token });
  }, 60_000);

  afterAll(async () => {
    observer.close();
    await ssh.close();
    await serve.close();
  }, 30_000);
  afterEach(disposeHarnesses);

  // ================================ the transport, on its own ================================

  it("the typed client speaks HTTP over a REAL SSH channel into the REAL serve: programs, dry, events, ?from= resume, record", { timeout: 120_000 }, async () => {
    const session = await createSshSession({
      host: "127.0.0.1", port: ssh.port, username: "m1",
      auth: { kind: "key", privateKey: key.privateOpenSsh },
    });
    const channel = await session.openChannel("ansiwise-rest serve", { signal: new AbortController().signal });
    const client = new AnsiwiseClient({ kind: "channel", stream: channel.stream });
    try {
      const programs = await client.programs();
      expect(programs.map((p) => p.name).sort()).toEqual([
        "deploy-cluster", "deploy-host", "deploy-platform-services", "deploy-slave-branch",
        "emit-cluster-credentials", "register-slave",
        "remove-slave", "tailnet-disconnect", "tailnet-mint-join-key",
        "tailnet-reconnect", "tailnet-rejoin",
      ]);
      expect(programs.find((p) => p.name === "deploy-cluster")?.answers.map((a) => a.name)).toContain("letsencrypt_email");

      const answers = composedAnswers(uniqueEmail());
      const dry = await client.start({ program: "deploy-cluster", mode: "dry", answers, elevationPassword: "pw" });
      expect(dry.mode).toBe("dry");
      await recordAppeared(client, dry.run);

      // Follow the whole run over the SAME channel; sequences must be dense from 0.
      const seen: number[] = [];
      let finished = false;
      for await (const e of client.events(dry.run, { from: 0 })) {
        seen.push(e.sequence);
        if (e.kind === "run-finished") finished = true;
      }
      expect(finished).toBe(true);
      expect(seen).toEqual(seen.map((_, i) => i));

      // ?from= is a resume point: no gap, nothing twice.
      const tail: number[] = [];
      for await (const e of client.events(dry.run, { from: 2 })) tail.push(e.sequence);
      expect(tail[0]).toBe(2);
      expect(tail.at(-1)).toBe(seen.at(-1));

      // The record is the machine's own verdict.
      const record = await client.run(dry.run);
      expect(record.exit_code).toBe(0);
      expect(record.end).toBeDefined();

      // The gate admits the run against the green dry — sequenced, never re-implemented here.
      const admitted = await client.start({ program: "deploy-cluster", mode: "run", answers, elevationPassword: "pw" });
      expect(admitted.admitted_by).toBe(dry.run);
    } finally {
      client.close();
      channel.close();
      session.close();
    }
  });

  it("PLANTED DEFECT (transport): a run with NO green dry behind it is refused by the machine's gate with its own sentence", { timeout: 60_000 }, async () => {
    const err = await observerStart(serve, { program: "deploy-cluster", mode: "run", answers: composedAnswers(uniqueEmail()) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnsiwiseRefused);
    expect((err as AnsiwiseRefused).status).toBe(409);
    expect((err as AnsiwiseRefused).reason).toMatch(/needs a successful/);
  });

  // ================================ redeploy (master arm), end to end ================================

  it("plan: the master arm composes attest, first contact, the placement, the three machine programs and the argocd follow, and asks for the password + the missing answers", async () => {
    const h = await liveMaster(serve);
    const { plan } = await h.executor.plan("cluster-redeploy", { serverId: MASTER_ID });
    // place-ansiwise and run-deploy-host stand here because a master could otherwise receive NO
    // machine-layer change at all: the placement's other call site is the slave install, and without
    // these two this arm would run only the programs above GitOps (hostyour-manager#69).
    //
    // The six first-contact steps stand between the attest and the placement because everything from
    // the placement down reaches the machine over ctx.ssh(), which authenticates with the key
    // install-key puts there — and a machine reinstalled at the hosting provider keeps its cluster
    // row at `active`, which makes this run kind the only one that may act on it at all.
    expect(plan.steps.map((s) => s.name)).toEqual([
      "attest-target",
      "prove-elevation", "generate-key", "install-key", "verify-key-login", "enable-ntp", "remove-sudoers",
      "place-ansiwise", "run-deploy-host", "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
    ]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.requiredInputs?.map((i) => i.field)).toEqual(
      ["letsencrypt_email", "letsencrypt_server", "build_plane_fqdn", "lan_cidr", "storage_mount", "storage_subdirectory"],
    );
  });

  it("INNOCENT CASE: the whole master arm runs green — all three programs proven dry, then run, on the machine's own records; no pin moves", { timeout: 180_000 }, async () => {
    const h = await liveMaster(serve);
    const email = uniqueEmail();

    const runId = await settled(h, "cluster-redeploy", { serverId: MASTER_ID }, approveSecrets(email));
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");

    // The run log carries the machine runs: both programs admitted by their own dry, both green.
    const events = JSON.stringify(readEvents(h.db.db, runId));
    expect(events).toContain("admitted by dry");
    expect(events).toContain("deploy-host: dry ");
    expect(events).toContain("deploy-cluster: dry ");
    expect(events).toContain("deploy-platform-services: dry ");
    expect(events).toContain("machine run finished: exit 0");
    // The conversation went over the machine's serve surface, and the follow still read ArgoCD.
    const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
    expect(onMaster.filter(isServe)).toHaveLength(3); // one conversation per program step
    expect(onMaster.some((c) => c.includes("-n argocd get applications.argoproj.io"))).toBe(true);

    // The machine's OWN records: dry + run per program, every one green. This is the record an
    // operator on the machine reads — the manager reported nothing the machine does not stand behind.
    expectProven(serve, h.db, runId, await observer.runs(), ["deploy-host", "deploy-cluster", "deploy-platform-services"]);

    // The step's checkpoint carries both machine runs green — what a re-entry would skip on.
    const checkpoint = stepColumn(h.db, runId, "run-deploy-cluster", "checkpoint_json") ?? "";
    expect(checkpoint).toContain('"exitCode":0');

    // No pin was touched: redeploy moves nothing in the platform repo, whatever delivers the
    // machine layer.
    expect(h.platformRepo.commits).toHaveLength(0);
    expect(h.platformRepo.tags.size).toBe(0);
  });

  it("a master that lost this manager's key is reached on the password, gets the key back, and carries on into the machine layer", { timeout: 180_000 }, async () => {
    // THE MACHINE AN OWNER RESETS AT THE HOSTING PROVIDER. What comes back carries the image's own
    // key and no line of this manager's, so a session offering that key is refused; its cluster row
    // is still `active`, which is the row cluster-deploy-slave turns away (defs/deploy-slave.attest.ts)
    // and the row this run kind is for. Without the door at the head of this arm the run opens a key
    // session for a key the machine no longer holds and dies on its own first step.
    const h = await liveMaster(serve, { authorizedKeys: [IMAGE_KEY_LINE] });

    const runId = await settled(h, "cluster-redeploy", { serverId: MASTER_ID }, approveSecrets(uniqueEmail()));
    // The first step's own error FIRST, because it names what the machine turned away — a bare status
    // assertion would go red saying only that something did.
    expect(stepColumn(h.db, runId, "attest-target", "error") ?? "").toBe("");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");

    // WHICH OF THE DOOR'S THREE OUTCOMES THIS WAS, in the run log an operator reads: the machine
    // presented the host key recorded for it and THEN refused the key, which is a machine carrying no
    // line of ours rather than a machine this manager cannot identify (defs/manager-key.kit.ts).
    const events = JSON.stringify(readEvents(h.db.db, runId));
    expect(events).toContain("refused this manager's key");
    expect(events).toContain("the password opens the session again");

    // THE KEY IS BACK, appended once and beside the image's own key, which no run kind here removes.
    // The manager never lost it — only the machine did — so nothing was generated.
    expect(found(h, runId, "generate-key")["generated"]).toBe(false);
    expect(found(h, runId, "install-key")["appended"]).toBe(true);
    expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE, MASTER_PUBLIC_KEY]);

    // AND NOTHING WAS ARMED TO TAKE IT OFF AGAIN. An abort that removed this line would leave a LIVE
    // cluster with nothing to reach it by, and cluster-redeploy implements no such cleanup for the
    // name to be resolved against — a step that armed one would end the abort on a step that is not
    // there.
    const armed = JSON.parse(stepColumn(h.db, runId, "install-key", "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
    expect(armed.__cleanups).toBeUndefined();

    // AND THE RUN CARRIED ON INTO THE MACHINE LAYER over the key it had just put back: all three
    // programs proven dry, then run, on the machine's own records.
    expectProven(serve, h.db, runId, await observer.runs(), ["deploy-host", "deploy-cluster", "deploy-platform-services"]);
  });

  it("a master that still holds the key is written to by none of the added steps, and the run does what it did before", { timeout: 180_000 }, async () => {
    // THE OTHER HALF OF THE SAME PROPERTY, and the one that makes the six steps safe in front of
    // EVERY redeploy rather than only the ones that need them: this machine carries the key line and
    // a clock already synchronised, because its own installation put both there, so each step
    // measures, finds its work done and says so. A step left out of a list is a step nobody can see
    // was considered; a step that reports finding nothing to do is a reading.
    const h = await liveMaster(serve);

    const runId = await settled(h, "cluster-redeploy", { serverId: MASTER_ID }, approveSecrets(uniqueEmail()));
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");

    // The door took the key path, and the operator's password was offered to nothing at all.
    const events = JSON.stringify(readEvents(h.db.db, runId));
    expect(events).toContain("takes this manager's own key, so no password is offered to it");
    expect(events).not.toContain("password opens the session");

    // What each step wrote down about what it found.
    expect(found(h, runId, "prove-elevation")["loginIsRoot"]).toBe(false);
    expect(found(h, runId, "generate-key")["generated"]).toBe(false);
    expect(found(h, runId, "install-key")["appended"]).toBe(false);
    expect(found(h, runId, "enable-ntp")["ntp"]).toBe("already-on");
    expect(found(h, runId, "remove-sudoers")["sudoersDropIn"]).toBe("absent");

    // …and the machine is byte for byte what it was: no second copy of the key line, and no clock
    // setting written over one the step had just measured as already right.
    expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE, MASTER_PUBLIC_KEY]);
    expect(h.hosts.log.filter((l) => l.command.includes(">> ~/.ssh/authorized_keys"))).toEqual([]);
    expect(h.hosts.log.filter((l) => l.command.includes("timedatectl set-ntp"))).toEqual([]);

    // And the machine layer ran exactly as it does without any of them.
    expectProven(serve, h.db, runId, await observer.runs(), ["deploy-host", "deploy-cluster", "deploy-platform-services"]);
  });

  it("reads the master's cluster with the password the RUN carries — on a machine that grants no passwordless route at all", { timeout: 180_000 }, async () => {
    // THE MACHINE THIS RUNS ON: /etc/sudoers.d/ holds nothing. That is what ansiwise-client leaves
    // behind, so it is what a FIRST MASTER is — measured on a real one, a README and no
    // rule — and the scripted host refuses every `sudo -n` on it exactly as that machine does.
    // `argocd-follow` reaching the cluster that way is refused there while every step
    // before it has gone green, with "sudo: interactive authentication is required" printed under a
    // line telling the operator the cluster was not answering yet.
    const h = await liveMaster(serve);
    expect(h.hosts.adopted).toBe(false);

    const runId = await settled(h, "cluster-redeploy", { serverId: MASTER_ID }, approveSecrets(uniqueEmail()));
    // The step's own error FIRST, because it names what the machine turned away — a bare status
    // assertion would go red saying only that something did.
    expect(stepColumn(h.db, runId, "argocd-follow", "error") ?? "").toBe("");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");

    // AND THE CLUSTER WAS REALLY READ, over the master's own session: a run that never reached the
    // follow would pass both assertions above by doing nothing. The password rode on standard input
    // and nowhere else — an argument list is readable by every process listing on the machine.
    const reads = h.hosts.log.filter((l) => l.host === "m1.example.com" && l.command.includes("get applications.argoproj.io"));
    expect(reads).not.toEqual([]);
    expect(reads.filter((l) => l.stdin === undefined).map((l) => l.command)).toEqual([]);
    expect(reads.some((l) => l.command.includes(ELEVATION_PASSWORD))).toBe(false);
  });

  it("PLANTED DEFECT (redeploy): a dry the machine judges red FAILS the step before anything is acted on — no run-mode machine run starts", { timeout: 60_000 }, async () => {
    const h = await liveMaster(serve);
    const runsBefore = (await observer.runs()).filter((x) => x.program === "deploy-cluster" && x.mode === "run").length;

    // "not-an-email" fails the program's own ^[^@]+@[^@]+$ row — the defect is ON THE MACHINE'S
    // SIDE of the wire, and the machine's dry run is what catches it.
    const runId = await settled(h, "cluster-redeploy", { serverId: MASTER_ID }, approveSecrets("not-an-email"));
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(stepColumn(h.db, runId, "run-deploy-cluster", "error")).toMatch(/DRY run of deploy-cluster on the machine is not green/);
    // The proof failed, so the act never started: not one new run-mode record on the machine.
    const runsAfter = (await observer.runs()).filter((x) => x.program === "deploy-cluster" && x.mode === "run").length;
    expect(runsAfter).toBe(runsBefore);
  });

  it("a checkpoint holding a FINISHED-RED machine run starts a fresh one — a retry that could never work", { timeout: 120_000 }, async ({ signal }) => {
    // THE TRAP THIS CLOSES. A re-entry keeps its checkpoint, and a mark whose run had already ended
    // red fell into the re-attach branch: every retry watched the same finished run, read the same
    // red record, and failed the same way — while the step's own message told the operator to retry
    // it. Nothing they could do from outside would ever clear it.
    const h = await liveMaster(serve);
    const email = uniqueEmail();

    // A machine run that is FINISHED and RED: the program refuses an answer it can judge itself.
    const bad = await observerStart(serve, {
      program: "deploy-cluster",
      mode: "dry",
      answers: { ...composedAnswers(email), letsencrypt_email: "not-an-email" },
    });
    await observerEnded(observer, serve, bad.run, signal);
    const ended = await observer.run(bad.run);
    expect(ended.exit_code === 0).toBe(false);

    let checkpoint: unknown = {
      program: "deploy-cluster",
      dry: { id: bad.run, seen: -1, exitCode: ended.exit_code ?? -1 },
    };
    const logs: string[] = [];
    const ctx = programStepCtx(serve, h, {
      secrets: approveSecrets(email),
      log: (line) => logs.push(line),
      readCheckpoint: () => checkpoint,
      checkpoint: (data) => (checkpoint = data),
    });

    const step = ansiwiseProgramStep(activeClusterTarget(MASTER_ID), "deploy-cluster", { ansiwiseServeCommand: "ansiwise-rest serve" });
    await step.run(ctx);

    expect(
      logs.some((l) => l.includes("cannot be retried by watching it again")),
      "the step re-attached to a run that had already ended",
    ).toBe(true);
    expect(logs.some((l) => l.includes(`re-attaching to machine run ${bad.run}`))).toBe(false);
    // And it got somewhere: a fresh dry of the CURRENT input, green, plus the run it admitted.
    const mine = (await observer.runs()).filter((x) => x.fingerprint !== bad.fingerprint && x.exit_code === 0);
    expect(mine.length).toBeGreaterThan(0);
  });

  it("re-entry re-attaches with ?from= instead of starting a second run, and a green checkpoint repeats nothing", { timeout: 120_000 }, async () => {
    const h = await liveMaster(serve);
    const email = uniqueEmail();
    const answers = composedAnswers(email);

    // The crashed manager: a dry was POSTed, the machine run is going (here: already done — the
    // record does not care), and the manager died before seeing one event. All it has is the
    // checkpoint holding the machine's run id.
    const dry = await observerStart(serve, { program: "deploy-cluster", mode: "dry", answers });
    let checkpoint: unknown = { program: "deploy-cluster", dry: { id: dry.run, seen: -1 } };
    const logs: string[] = [];
    const ctx = programStepCtx(serve, h, {
      secrets: approveSecrets(email),
      log: (line) => logs.push(line),
      readCheckpoint: () => checkpoint,
      checkpoint: (data) => (checkpoint = data),
    });

    const step = ansiwiseProgramStep(activeClusterTarget(MASTER_ID), "deploy-cluster", { ansiwiseServeCommand: "ansiwise-rest serve" });
    await step.run(ctx);

    expect(logs.some((l) => l.includes(`re-attaching to machine run ${dry.run} from event 0`))).toBe(true);
    // Exactly the dry it re-attached to plus the ONE run the gate admitted — never a second dry.
    const mine = (await observer.runs()).filter((x) => x.fingerprint === dry.fingerprint);
    expect(mine.map((x) => x.mode).sort()).toEqual(["dry", "run"]);
    expect(mine.every((x) => x.exit_code === 0)).toBe(true);

    // A second entry over the green checkpoint asks the machine to repeat NOTHING.
    logs.length = 0;
    await step.run(ctx);
    expect(logs.filter((l) => l.includes("already green"))).toHaveLength(2);
    expect((await observer.runs()).filter((x) => x.fingerprint === dry.fingerprint)).toHaveLength(mine.length);
  });

  // Registered from orphaned-end.ansiwise.suite.ts — the one serve fixture this file starts, the
  // suite's own tests in their own file. That module says why the split is of the FILE and not the
  // process.
  orphanedEndSuite(() => serve, () => observer);

  // The other end of the same run's life: what may be said about a record that has not appeared YET,
  // where the one above judges an end that was written and never installed.
  recordAppearsSuite(() => serve, () => observer);

  // ================================ the tailnet run kinds, end to end ================================

  // The run kind carries its family and the catalogue program does not, so the pair is stated here —
  // the same two spellings tailnet.kit.ts's PROGRAM map holds apart.
  for (const { kind, program } of [
    { kind: "cluster-tailnet-disconnect", program: "tailnet-disconnect" },
    { kind: "cluster-tailnet-reconnect", program: "tailnet-reconnect" },
  ] as const) {
    it(`INNOCENT CASE (${kind}): the program runs on the host's own surface over the PUBLIC address — no cluster row needed — and the membership is re-read`, { timeout: 120_000 }, async () => {
      const h = await tailnetHost(serve, { cluster: false });

      const r = await h.executor.plan(kind, { serverId: SLAVE_ID });
      expect(r.plan.steps.map((s) => s.name)).toEqual(["attest-target", `run-${program}`, "read-membership"]);
      expect(r.plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
      await h.executor.approve(r.runId, elevationOnly());
      await h.executor.settle(r.runId);
      expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

      // The machine's OWN records: dry + run, both green — the proof, then the act.
      expectProven(serve, h.db, r.runId, await observer.runs(), [program]);

      // EVERY session went to the host's PUBLIC address (servers.host) — never the LAN one every
      // other run kind would use — and the master was not touched at all.
      expect(h.hosts.log.length).toBeGreaterThan(0);
      expect(h.hosts.log.every((l) => l.host === "s1.example.com")).toBe(true);

      // The stored reading was replaced through the one writer, stamped with THIS run.
      const row = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
      expect(row?.tailnetState).toBe("joined"); // what the scripted probe reports
      expect((row?.tailnetJson as { runId?: string } | null)?.runId).toBe(r.runId);
    });
  }

  it("INNOCENT CASE (tailnet-rejoin): mint on the master, carry the credential, ONE rejoin program run on the host — every machine run green, the key nowhere in the run surface", { timeout: 120_000 }, async () => {
    const h = await tailnetHost(serve);

    const r = await h.executor.plan("cluster-tailnet-rejoin", { serverId: SLAVE_ID });
    expect(r.plan.steps.map((s) => s.name)).toEqual(["attest-target", "rejoin", "read-membership"]);
    await h.executor.approve(r.runId, elevationOnly());
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // The machine's OWN records: dry + run per program, all green. The rejoin program's rows judge
    // the COMPOSITION — login_server off the branch's profile, auth_key off the master's key file —
    // so a wrong value goes red on the machine's side of the wire.
    expectProven(serve, h.db, r.runId, await observer.runs(), ["tailnet-mint-join-key", "tailnet-rejoin"]);

    // Two surfaces: the mint conversation on the MASTER (its usual address), the rejoin on the
    // host's PUBLIC one; the key file was read and removed on the master.
    const serves = h.hosts.log.filter((l) => isServe(l.command)).map((l) => l.host).sort();
    expect(serves).toEqual(["m1.example.com", "s1.example.com"]);
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command === "cat /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command === "rm -f /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);

    // The credential appears NOWHERE in the persisted run surface.
    expect(JSON.stringify(readEvents(h.db.db, r.runId))).not.toContain(MINT_AUTHKEY);

    // The reading on the row is this run's.
    const row = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect((row?.tailnetJson as { runId?: string } | null)?.runId).toBe(r.runId);
  });

  it("INNOCENT CASE (master rejoin): a rejoin whose target IS the master mints and joins on ONE machine, with the same program every other host runs", { timeout: 120_000 }, async () => {
    const h = await liveMaster(serve);

    const r = await h.executor.plan("cluster-tailnet-rejoin", { serverId: MASTER_ID });
    expect(r.plan.steps.map((s) => s.name)).toEqual(["attest-target", "rejoin", "read-membership"]);
    await h.executor.approve(r.runId, elevationOnly());
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // The machine's OWN records: dry + run per program, all green — and the join is the SAME program
    // every other host runs. A master had a stamp-free variant for one evening, on the reasoning that
    // nothing dials a master's kube-apiserver at a tailnet address. The restart it was meant to avoid
    // happened anyway: MicroK8s re-issues its own serving certificate when an address it has not
    // issued one for appears, and it took the secret store down with it because nothing was waiting.
    const all = await observer.runs();
    expectProven(serve, h.db, r.runId, all, ["tailnet-mint-join-key", "tailnet-rejoin"]);
    expect(recordWindow(all, startedRuns(h.db, r.runId)).filter((x) => x.program === "tailnet-join-master")).toHaveLength(0);

    // ONE machine, on the address the plan froze: both serve conversations went to m1, and the
    // key file was read and removed there — the same host the join then ran on.
    const serves = h.hosts.log.filter((l) => isServe(l.command)).map((l) => l.host);
    expect(serves).toEqual(["m1.example.com", "m1.example.com"]);
    // WHAT THE MACHINE WAS TOLD IT IS, all three facts, off its own cluster row — the mint's
    // conversation and the join's alike. The engine defaults the stage to `dev` and writes that word
    // into the record of every run the machine keeps, so a serve that leaves it unsaid makes a prod
    // installation keep records saying dev: measured on apps6, whose deploy-slave-branch record
    // 20260903T220006Z-227727-07d5f8a7 carries "stage": "dev" while its own map says prod.
    for (const c of h.hosts.log.filter((l) => isServe(l.command)).map((l) => l.command)) {
      expect(c, c).toContain("--role master+slave --fqdn m1.example.com --stage prod");
    }
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command === "cat /tmp/ansiwise-tailnet-join-key-m1")).toBe(true);
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command === "rm -f /tmp/ansiwise-tailnet-join-key-m1")).toBe(true);

    // The credential appears NOWHERE in the persisted run surface, and the reading on the
    // master's row is this run's.
    expect(JSON.stringify(readEvents(h.db.db, r.runId))).not.toContain(MINT_AUTHKEY);
    const mrow = h.db.db.select().from(servers).where(eq(servers.id, MASTER_ID)).get();
    expect((mrow?.tailnetJson as { runId?: string } | null)?.runId).toBe(r.runId);
  });

  it("PLANTED DEFECT (tailnet-rejoin): a coordinator address the machine's dry run judges red fails the step BEFORE the logout — no run-mode rejoin starts, and the membership was still re-read", { timeout: 60_000 }, async () => {
    const h = await tailnetHost(serve, { tailnetUrl: "https://tale.wrong.example.com" });

    const runId = await settled(h, "cluster-tailnet-rejoin", { serverId: SLAVE_ID }, elevationOnly());
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(stepColumn(h.db, runId, "rejoin", "error")).toMatch(/DRY run of tailnet-rejoin on the host is not green/);

    // The mint is fine — its two runs are green — and the act never started: not one run-mode
    // rejoin record on the machine, so the logout never happened.
    const all = await observer.runs();
    expectProven(serve, h.db, runId, all, ["tailnet-mint-join-key"]);
    expect(recordWindow(all, startedRuns(h.db, runId)).filter((x) => x.program === "tailnet-rejoin" && x.mode === "run")).toHaveLength(0);

    // The failure still re-read the host, so the card shows the world as the failed run left it.
    const row = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect((row?.tailnetJson as { runId?: string } | null)?.runId).toBe(runId);
  });

  it("PLANTED DEFECT (tailnet-rejoin): a profile without global.endpoints.tailnet.url is refused BY NAME before any machine is asked anything", { timeout: 60_000 }, async () => {
    const h = await tailnetHost(serve, { tailnetUrl: false });

    const runId = await settled(h, "cluster-tailnet-rejoin", { serverId: SLAVE_ID }, elevationOnly());
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(stepColumn(h.db, runId, "rejoin", "error")).toMatch(/no readable global\.endpoints\.tailnet\.url/);

    // Not one machine run started, on either surface — no serve conversation was even opened.
    expect(startedRuns(h.db, runId)).toEqual([]);
    expect(h.hosts.log.filter((l) => isServe(l.command))).toHaveLength(0);
  });

  // Registered from deploy-slave.ansiwise.suite.ts — the composed run kind's own four journeys,
  // in their own file for the size doctrine and against the ONE serve fixture this file starts.
  deploySlaveSuite(() => serve, () => observer);
});
