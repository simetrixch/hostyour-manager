import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { createSshSession } from "../../adapters/ssh/ssh2-session.ts";
import { generateServerKeypair } from "../../adapters/ssh/keygen.ts";
import { startFakeSshServer, type FakeSshServer } from "../../adapters/ssh/testing/fake-server.ts";
import { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import { AnsiwiseRefused } from "../../adapters/ansiwise/port.ts";
import { ansiwiseBinaries, NO_BINARY, startServe, type ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { activeClusterTarget } from "./defs/deploy-slave.kit.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { readServerTailnet } from "../../../shared/tailnet.ts";
import { SLAVE_MACHINE_INPUTS } from "./defs/deploy-slave.ts";
import {
  STEP_NAMES, REDEPLOY_STEP_NAMES, PARAMS, EMIT_ARGOCD_TOKEN, EMIT_REVIEWER_TOKEN, EMIT_CREDS_JSON,
  disposeHarnesses, MASTER_ID, SLAVE_ID, MINT_AUTHKEY, ANSIWISE_PIN,
} from "./deploy-slave.fixture.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import { ANSIWISE_SERVICE_PORT } from "./defs/place-ansiwise.ts";
import {
  uniqueEmail, approveSecrets, elevationOnly, deploySecrets, composedAnswers,
  fixturePrograms, serveConversation, liveMaster, tailnetHost, deployWorld, liveSlaveWorld,
  recordWindow, startedRuns, expectProven, expectAbsent, settled, recordAppeared, observerStart, observerEnded, programStepCtx,
} from "./ansiwise-serve.fixture.ts";
import { releaseSuite } from "./release.ansiwise.suite.ts";
import { orphanedEndSuite } from "./orphaned-end.ansiwise.suite.ts";

// EVERY run kind that drives the machine's deployment programs, on the REAL `ansiwise-rest serve`:
// redeploy (both arms), release, the tailnet repair run kinds, deploy-slave, and the transport
// underneath them all. Nothing here mocks the machine's surface: the serve fixture starts the
// actual binary on a minimal installation whose programs are pure measurements
// (require_answer_matches), so the gate, the answers validation, the detached run records and the
// ?from= resume are all the engine's own.
//
// ONE FILE ON PURPOSE: the engine's run root is per-drive ('/var/lib/ansiwise/runs'), so two
// test files each running a serve fixture in parallel would share records and collide. Everything
// that starts machine runs lives here, sequentially; the programs, the worlds and the plumbing
// live in ansiwise-serve.fixture.ts, and the release's own suites in release.ansiwise.suite.ts —
// registered INTO this file's describe rather than collected as a second file, for that same reason.
//
// TWO RUNS IN ONE SECOND USED TO BE ONE RUN. The machine named a run by second + pid, so a service
// asked twice within a second answered with one id and the two wrote over each other's record. The
// id now carries four random bytes (ansiwise-cli _newRunId), which is why these tests can start
// runs back to back at all — the fixture's programs take milliseconds where a real one takes
// minutes, so this suite is where that defect showed.

const bin = ansiwiseBinaries();
const key = generateServerKeypair("test@manager");

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
        "emit-cluster-credentials", "regenerate-branch", "regenerate-slave-branch", "register-slave",
        "remove-slave", "tailnet-disconnect", "tailnet-mint-join-key", "tailnet-reconnect",
        "tailnet-rejoin",
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

  it("plan: the master arm composes attest, the placement, the three machine programs and the argocd follow, and asks for the password + the missing answers", async () => {
    const h = await liveMaster(serve);
    const { plan } = await h.executor.plan("cluster-redeploy", { serverId: MASTER_ID });
    // place-ansiwise and run-deploy-host stand here because a master could otherwise receive NO
    // machine-layer change at all: the placement had one call site, in the slave install, and this
    // arm ran only the two programs above GitOps (hostyour-manager#69).
    expect(plan.steps.map((s) => s.name)).toEqual(
      ["attest-target", "place-ansiwise", "run-deploy-host", "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow"],
    );
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
    expect(onMaster.filter((c) => c === "ansiwise-rest serve")).toHaveLength(3); // one conversation per program step
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

  // ================================ the release, end to end ================================
  // Registered from release.ansiwise.suite.ts — the one serve fixture this file starts, the release's
  // own tests in their own file. That module says why the split is of the FILE and not the process.
  releaseSuite(() => serve, () => observer);
  orphanedEndSuite(() => serve, () => observer);

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
    const serves = h.hosts.log.filter((l) => l.command === "ansiwise-rest serve").map((l) => l.host).sort();
    expect(serves).toEqual(["m1.example.com", "s1.example.com"]);
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command === "cat /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command === "rm -f /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);

    // The credential appears NOWHERE in the persisted run surface.
    expect(JSON.stringify(readEvents(h.db.db, r.runId))).not.toContain(MINT_AUTHKEY);

    // The reading on the row is this run's.
    const row = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect((row?.tailnetJson as { runId?: string } | null)?.runId).toBe(r.runId);
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
    expect(h.hosts.log.filter((l) => l.command === "ansiwise-rest serve")).toHaveLength(0);
  });

  // ================================ deploy-slave, end to end ================================

  it("INNOCENT CASE (deploy-slave): the whole run kind runs green — every program dry-proven then run on the machines' own records, one address everywhere, the tokens nowhere", { timeout: 300_000 }, async () => {
    const h = await deployWorld(serve);
    const email = uniqueEmail();

    const r = await h.executor.plan("cluster-deploy-slave", PARAMS);
    expect(r.plan.steps.map((s) => s.name)).toEqual(STEP_NAMES);
    await h.executor.approve(r.runId, deploySecrets(email));
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // hm#22, on the whole run kind: the deployment that makes the machine is the deployment that
    // leaves it SERVING. Nobody typed a command after this run, and the unit is enabled — so a
    // restart brings it back — running, and starting the PINNED binary on the address the manager
    // dials, all four read off the machine and not off the installer.
    expect(h.hosts.serviceEnabled).toBe(true);
    expect(h.hosts.serviceActive).toBe(true);
    expect(h.hosts.serviceExecVersion).toBe(ANSIWISE_PIN);
    expect(h.hosts.serviceExecListen).toBe(`100.64.0.11:${ANSIWISE_SERVICE_PORT}`);

    // The machines' OWN records: dry + run per program, every one green — the branch cut and the
    // registration on the master's surface, the machine layer, the join and the emit on the slave's.
    expectProven(serve, h.db, r.runId, await observer.runs(), [
      "deploy-slave-branch", "deploy-host", "deploy-cluster", "deploy-platform-services",
      "tailnet-mint-join-key", "tailnet-rejoin", "emit-cluster-credentials", "register-slave",
    ]);

    // WHICH surface each conversation went over: three on the master (branch cut, mint,
    // register), five on the slave (host, cluster, gitops, rejoin, emit) — and the master's
    // checkouts were stood up BEFORE its first conversation.
    const master = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
    const slave = h.hosts.log.filter((l) => l.host === "10.1.1.11").map((l) => l.command);
    expect(master.filter((c) => c === "ansiwise-rest serve")).toHaveLength(3);
    expect(slave.filter((c) => c === "ansiwise-rest serve")).toHaveLength(5);
    expect(master.findIndex((c) => c.includes("dc-prepare-checkouts-"))).toBeLessThan(master.indexOf("ansiwise-rest serve"));

    // THE ONE-ADDRESS LAW, on the record: the map the run committed carries the same spelling the
    // emit and the register were given as their answer — the fixture's api_server_url/ca_data rows
    // are what judged those, so the green register run above IS the proof the answers matched.
    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath("s1.example.com")) ?? "";
    for (const want of ["  master: m1.example.com", "booksCluster: m1.example.com", "  apiHost: 100.64.0.11", "  apiPort: 16443", "role: slave", "  catalogUrl: https://github.com/acme/acme-catalog.git"]) {
      expect(map).toContain(want);
    }

    // The credentials file was read over the session and removed; same for the join key.
    expect(slave.some((c) => c === "cat /tmp/ansiwise-cluster-credentials")).toBe(true);
    expect(slave.some((c) => c === "rm -f /tmp/ansiwise-cluster-credentials")).toBe(true);
    expect(master.some((c) => c === "cat /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);
    expect(master.some((c) => c === "rm -f /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);

    // register's terminal choreography: cluster ACTIVE with a valid plane carrying the emitted
    // kube facts and the sealed credential ids; server healthy, with the join's own reading.
    const cluster = h.db.db.select().from(clusters).where(eq(clusters.domain, "s1.example.com")).get();
    expect(cluster?.status).toBe("active");
    const bearer = await h.store.list({ serverId: SLAVE_ID, kind: "kubeconfig" });
    const reviewer = await h.store.list({ serverId: SLAVE_ID, kind: "other" });
    const plane = ClusterPlaneV0.parse(cluster?.planeJson);
    expect(plane.kube).toEqual({ server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==" });
    expect(plane.credentialIds).toEqual({ clusterBearer: bearer[0]?.id, reviewerJwt: reviewer[0]?.id });
    const server = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect(server?.status).toBe("healthy");
    expect(server?.tailnetState).toBe("joined");
    expect(readServerTailnet(server?.tailnetJson).kind).toBe("v0");

    // REDACTION: the two bearer tokens and the join key appear NOWHERE in the persisted run
    // surface (every table except the sealed credential store, plus the run log).
    const tables = h.db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'credentials'")
      .all() as { name: string }[];
    let dump = JSON.stringify(readEvents(h.db.db, r.runId));
    for (const t of tables) dump += JSON.stringify(h.db.sqlite.prepare(`SELECT * FROM ${t.name}`).all());
    expect(dump).not.toContain(EMIT_ARGOCD_TOKEN);
    expect(dump).not.toContain(EMIT_REVIEWER_TOKEN);
    expect(dump).not.toContain(MINT_AUTHKEY);
  });

  it("PLANTED DEFECT (deploy-slave): a TAMPERED credentials file goes red on the machine's own dry run of register-slave — nothing is registered, and the tokens still leak nowhere", { timeout: 300_000 }, async () => {
    const h = await deployWorld(serve);
    // The defect sits in the FILE contract: the slave hands back an authority the master must not
    // trust. The fixture's ca_data row is the machine-side judge.
    h.hosts.credsOut = EMIT_CREDS_JSON.replace("TFMtQ0EtREFUQQ==", "VEFNUEVSRUQ=");

    const runId = await settled(h, "cluster-deploy-slave", PARAMS, deploySecrets(uniqueEmail()));
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(stepColumn(h.db, runId, "create-mgmt", "error")).toMatch(/DRY run of register-slave on the master is not green/);
    // The emit itself is green — the defect is in what it handed over — and the registration
    // never ran: not one run-mode register-slave record on the machine.
    const all = await observer.runs();
    expectProven(serve, h.db, runId, all, ["emit-cluster-credentials"]);
    expect(recordWindow(all, startedRuns(h.db, runId)).filter((x) => x.program === "register-slave" && x.mode === "run")).toHaveLength(0);
    // The tampered file's tokens still appear nowhere in the persisted surface.
    const dump = JSON.stringify(readEvents(h.db.db, runId));
    expect(dump).not.toContain(EMIT_ARGOCD_TOKEN);
    expect(dump).not.toContain(EMIT_REVIEWER_TOKEN);
  });

  it("abort-with-cleanup (deploy-slave): the map's slave part goes FIRST, then the remove-slave program on the master's record, then the snap purge — and the marking cleanup finds nothing left", { timeout: 300_000 }, async () => {
    const h = await deployWorld(serve);
    h.hosts.credsOut = EMIT_CREDS_JSON.replace("TFMtQ0EtREFUQQ==", "VEFNUEVSRUQ="); // park at create-mgmt with all three cleanups armed
    const runId = await settled(h, "cluster-deploy-slave", PARAMS, deploySecrets(uniqueEmail()));
    expect(getRun(h.db.db, runId)?.status).toBe("failed");

    // Each arming step persisted exactly its own cleanup name (__cleanups)...
    for (const [step, name] of [
      ["mark-slave", "remove-slave-marking"],
      ["run-deploy-cluster", "microk8s-reset-slave"],
      ["rejoin", "remove-slave"],
    ] as const) {
      const cp = JSON.parse(stepColumn(h.db, runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
      expect(cp.__cleanups, step).toEqual([name]);
    }

    const logMark = h.hosts.log.length;
    // The failed run's secrets were wiped with it — the abort re-supplies the elevation password,
    // exactly the way a retry does, because the remove-slave cleanup drives the master's programs.
    await h.executor.abortWithCleanup(runId, elevationOnly());
    await h.executor.settle(runId);

    const run = getRun(h.db.db, runId);
    expect(run?.status).toBe("cancelled");
    const cleanupSteps = run?.steps.filter((s) => s.name.startsWith("cleanup:")) ?? [];
    expect(cleanupSteps.map((s) => s.name)).toEqual([
      "cleanup:remove-slave", "cleanup:microk8s-reset-slave", "cleanup:remove-slave-marking",
    ]); // reverse registration order — the map cleanup was armed FIRST (mark-slave), so it runs LAST
    expect(cleanupSteps.every((s) => s.status === "ok")).toBe(true);

    // The map keeps the cluster's identity and loses ONLY the slave part — dropped by the
    // remove-slave cleanup itself, FIRST (the program's own contract), so the marking cleanup
    // afterwards found nothing left to drop.
    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath("s1.example.com")) ?? "";
    expect(map).toContain("role: slave");
    expect(map).toContain("  buildPlane: m1.example.com");
    // booksCluster goes WITH the slave part: a map still carrying the selector key without the
    // endpoint would make the generated Application error instead of disappear.
    for (const gone of ["master:", "booksCluster:", "apiHost:", "apiPort:"]) expect(map).not.toContain(gone);

    // The removal itself is a machine act, dry-proven then run on the master's own record...
    expectProven(serve, h.db, runId, await observer.runs(), ["remove-slave"]);
    // ...and the destructive snap purge ran on the SLAVE.
    const tail = h.hosts.log.slice(logMark);
    expect(tail.find((l) => l.command.includes("snap remove --purge microk8s"))?.host).toBe("10.1.1.11");
  });

  it("INNOCENT CASE (redeploy, slave arm): the live slave is re-reconciled over the programs — no branch cut, no join, a fresh emit re-points the registration, and nothing is armed", { timeout: 300_000 }, async () => {
    const h = await liveSlaveWorld(serve);
    const email = uniqueEmail();

    const r = await h.executor.plan("cluster-redeploy", { serverId: SLAVE_ID });
    expect(r.plan.steps.map((s) => s.name)).toEqual(REDEPLOY_STEP_NAMES);
    expect(r.plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(r.plan.requiredInputs?.map((i) => i.field)).toEqual(SLAVE_MACHINE_INPUTS.map((i) => i.field));
    await h.executor.approve(r.runId, approveSecrets(email));
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // The machine layer and the handshake re-ran, each dry-proven; the two BIRTH acts did not —
    // no branch cut, no mint, no rejoin, on either machine's records.
    const all = await observer.runs();
    expectProven(serve, h.db, r.runId, all, ["deploy-host", "deploy-cluster", "deploy-platform-services", "emit-cluster-credentials", "register-slave"]);
    expectAbsent(h.db, r.runId, all, ["deploy-slave-branch", "tailnet-mint-join-key", "tailnet-rejoin"]);

    // Not one compensating action was armed: every one of them undoes a WORKING slave.
    for (const step of ["mark-slave", "run-deploy-cluster", "create-mgmt"] as const) {
      const cp = JSON.parse(stepColumn(h.db, r.runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
      expect(cp.__cleanups, step).toBeUndefined();
    }

    // The row stayed active + single + same ordinal (re-reconciled in place, never re-inserted).
    const rows = h.db.db.select().from(clusters).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.slaveId).toBe(1);
  });
});
