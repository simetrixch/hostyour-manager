import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import { createSshSession } from "../../adapters/ssh/ssh2-session.ts";
import { generateServerKeypair } from "../../adapters/ssh/keygen.ts";
import { startFakeSshServer, type FakeSshServer } from "../../adapters/ssh/testing/fake-server.ts";
import { AnsiwiseClient } from "../../adapters/ansiwise/client.ts";
import { AnsiwiseRefused } from "../../adapters/ansiwise/port.ts";
import {
  ansiwiseBinary, NO_BINARY, openChannel, programYaml, startServe,
  type ServeFixture,
} from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { activeClusterTarget } from "./defs/deploy-slave.kit.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import {
  makeHarness, disposeHarnesses, scriptedHosts, stepColumn, MASTER_ID, logger, type Harness,
} from "./deploy-slave.fixture.ts";

// The redeploy master arm AND the release on the REAL `ansiwise serve`, and the transport
// underneath them. Nothing here mocks the machine's surface: the serve fixture starts the actual
// binary on a minimal installation whose programs are pure measurements (require_answer_matches),
// so the gate, the answers validation, the detached run records and the ?from= resume are all the
// engine's own.
//
// ONE FILE ON PURPOSE: the engine's run root is per-drive ('/var/lib/ansiwise/runs'), so two
// test files each running a serve fixture in parallel would share records and collide. Everything
// that starts machine runs lives here, sequentially.
//
// TWO RUNS IN ONE SECOND USED TO BE ONE RUN. The machine named a run by second + pid, so a service
// asked twice within a second answered with one id and the two wrote over each other's record. The
// id now carries four random bytes (ansiwise-cli _newRunId), which is why these tests can start
// runs back to back at all — the fixture's programs take milliseconds where a real one takes
// minutes, so this suite is where that defect showed.

const bin = ansiwiseBinary();
const key = generateServerKeypair("test@manager");

// The letsencrypt answers ride approve as activation inputs; a UNIQUE email per test gives each
// test its own fingerprint, so one test's green dry can never admit another test's run.
let stamp = 0;
const uniqueEmail = (): string => `op-${Date.now()}-${++stamp}@example.com`;
const ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

const approveSecrets = (email: string): Record<string, Buffer> => ({
  [ANSIWISE_ELEVATION_SECRET]: Buffer.from("root-pw"),
  "activation-input:letsencrypt_email": Buffer.from(email),
  "activation-input:letsencrypt_server": Buffer.from(ACME_STAGING),
});

/** What the step composes for deploy-cluster on the fixture master — mirrored here ONLY so a
 *  test can start a dry run itself and hand its id to the step as a checkpoint (the crashed-
 *  manager re-entry). The values are the harness rows': domain, stage, role, sshUser. */
const composedAnswers = (email: string): Record<string, string> => ({
  fqdn: "m1.example.com",
  stage: "prod",
  role: "master",
  operator_user: "m1",
  letsencrypt_email: email,
  letsencrypt_server: ACME_STAGING,
});

describe.skipIf(bin === undefined)("redeploy over the machine's own deployment programs (REAL ansiwise serve)", () => {
  if (bin === undefined) {
    // eslint-disable-next-line no-console -- the skip must be loud, not silent (see NO_BINARY)
    console.warn(NO_BINARY);
  }

  let serve: ServeFixture;
  let ssh: FakeSshServer;
  /** Reads the machine's records directly — the ADDRESS wire, dialing the resident surface. */
  let observer: AnsiwiseClient;

  beforeAll(async () => {
    serve = await startServe(bin as string, {
      // The fixture's deploy-cluster judges the COMPOSITION end to end: inventory answers
      // (fqdn/stage/role/operator_user) and approve inputs (the letsencrypt pair) each have a row
      // that goes red when the value is missing or wrong — so a green run IS the proof that the
      // manager composed what the program declared.
      "deploy-cluster": programYaml("deploy-cluster", [
        { answer: "fqdn", pattern: "^m1\\.example\\.com$" },
        { answer: "stage", pattern: "^prod$" },
        { answer: "role", pattern: "^master$" },
        { answer: "operator_user", pattern: "^m1$" },
        { answer: "letsencrypt_email", pattern: "^[^@]+@[^@]+$" },
        { answer: "letsencrypt_server", pattern: "^https://" },
      ]),
      "deploy-gitops": programYaml("deploy-gitops", [
        { answer: "fqdn", pattern: "^m1\\.example\\.com$" },
        { answer: "stage", pattern: "^prod$" },
        { answer: "role", pattern: "^master$" },
      ]),
      // The release's regeneration, judged the same way: the MAP-sourced answers (markingAnswers
      // reads them off clusters/active/m1.example.com.yaml — the fixture harness seeds
      // MASTER_MARKING_YAML) and the approve input each have a row that goes red when the value is
      // missing or wrong. alert_recipients is deliberately NOT declared here: the program declares
      // it text_list, and the REST door does not take a list yet (see the handover finding on
      // ansiwise-rest) — its composition is proven at the unit level in release.test.ts.
      "regenerate-branch": programYaml("regenerate-branch", [
        { answer: "fqdn", pattern: "^m1\\.example\\.com$" },
        { answer: "stage", pattern: "^prod$" },
        { answer: "role", pattern: "^master$" },
        { answer: "build_plane", pattern: "^m1\\.example\\.com$" },
        { answer: "unit_apex", pattern: "^example\\.com$" },
        { answer: "platform_domain", pattern: "^example\\.com$" },
        { answer: "catalog_repo", pattern: "^acme/acme-catalog$" },
        { answer: "committer_email", pattern: "^[^@]+@[^@]+$" },
      ]),
    });
    ssh = await startFakeSshServer({
      authorizedKeys: [key.publicLine],
      conversations: {
        // The channel form of the surface, and it is the real one: spawn the binary and its own
        // standard input and output ARE the connection — exactly what an SSH exec channel hands a
        // process. No token here: a session is authenticated by sshd, and a machine at its first
        // installation has no token yet.
        "ansiwise serve": (stream) => {
          const child = spawn(serve.exe, ["serve", "--programs", "programs", "--config", "ansiwise.yaml"], {
            cwd: serve.dir,
          });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream);
          child.on("close", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
          stream.on("close", () => child.kill());
        },
      },
    });
    observer = new AnsiwiseClient({ kind: "address", host: "127.0.0.1", port: serve.port, token: serve.token });
  }, 60_000);

  afterAll(async () => {
    observer.close();
    await ssh.close();
    await serve.close();
  }, 30_000);
  afterEach(disposeHarnesses);

  /** A harness whose master carries an ACTIVE cluster — the state redeploy and release act on —
   *  wired to reach the real `ansiwise serve`. The channel table rides along because a release's
   *  attest checks the ceiling against it; redeploy never reads it. */
  async function liveMaster(): Promise<Harness> {
    const hosts = scriptedHosts({
      openConversation: async () => openChannel(serve),
    });
    const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise serve" });
    h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, [
      "global:",
      "  channelStages:",
      "    alpha: [dev]",
      "    beta: [dev, test]",
      "    stable: [dev, test, prod]",
      "",
    ].join("\n"));
    h.db.db.update(servers).set({ role: "master+slave" }).where(eq(servers.id, MASTER_ID)).run();
    h.db.db.insert(clusters).values({
      id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com",
      status: "active", tier: "rehearsal", planeState: "ready",
    }).run();
    return h;
  }

  // ================================ the transport, on its own ================================

  it("the typed client speaks HTTP over a REAL SSH channel into the REAL serve: programs, dry, events, ?from= resume, record", { timeout: 120_000 }, async () => {
    const session = await createSshSession({
      host: "127.0.0.1", port: ssh.port, username: "m1",
      auth: { kind: "key", privateKey: key.privateOpenSsh },
    });
    const channel = await session.openChannel("ansiwise serve", { signal: new AbortController().signal });
    const client = new AnsiwiseClient({ kind: "channel", stream: channel.stream });
    try {
      const programs = await client.programs();
      expect(programs.map((p) => p.name).sort()).toEqual(["deploy-cluster", "deploy-gitops", "regenerate-branch"]);
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
    const err = await observerStart({ program: "deploy-cluster", mode: "run", answers: composedAnswers(uniqueEmail()) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnsiwiseRefused);
    expect((err as AnsiwiseRefused).status).toBe(409);
    expect((err as AnsiwiseRefused).reason).toMatch(/needs a successful/);
  });

  /** A 202 answers before the detached child writes its header — the step absorbs that wait
   *  itself (ansiwise-run.kit appearedRecord); a raw follow in a test has to wait the same way. */
  async function recordAppeared(client: AnsiwiseClient, id: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.run(id);
        return;
      } catch (err) {
        if (!(err instanceof AnsiwiseRefused) || err.status !== 404 || attempt >= 40) throw err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** POSTs over the address wire (the observer dials serve directly, which is
   *  fine for reads; STARTS must be spaced — see the file header). */
  async function observerStart(start: { program: string; mode: "dry" | "run"; answers: Record<string, string> }): Promise<{ run: string; fingerprint: string }> {
    const spaced = new AnsiwiseClient({ kind: "address", host: "127.0.0.1", port: serve.port, token: serve.token });
    try {
      return await spaced.start({ ...start, elevationPassword: "pw" });
    } finally {
      spaced.close();
    }
  }

  // ================================ the verb, end to end ================================

  it("plan: the master arm composes attest → run-deploy-cluster → run-deploy-gitops → argocd-follow and asks for the password + the missing answers", async () => {
    const h = await liveMaster();
    const { plan } = await h.executor.plan("redeploy", { serverId: MASTER_ID });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "run-deploy-cluster", "run-deploy-gitops", "argocd-follow"]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.requiredInputs?.map((i) => i.field)).toEqual(
      ["letsencrypt_email", "letsencrypt_server", "build_plane", "lan_cidr", "storage_path", "storage_directory"],
    );
  });

  it("INNOCENT CASE: the whole master arm runs green — both programs proven dry, then run, on the machine's own records; no pin moves", { timeout: 120_000 }, async () => {
    const h = await liveMaster();
    const email = uniqueEmail();
    const before = await observer.runs();

    const r = await h.executor.plan("redeploy", { serverId: MASTER_ID });
    await h.executor.approve(r.runId, approveSecrets(email));
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // The run log carries the machine runs: both programs admitted by their own dry, both green.
    const events = JSON.stringify(readEvents(h.db.db, r.runId));
    expect(events).toContain("admitted by dry");
    expect(events).toContain("deploy-cluster: dry ");
    expect(events).toContain("deploy-gitops: dry ");
    expect(events).toContain("machine run finished: exit 0");
    // The conversation went over the machine's serve surface, and the follow still read ArgoCD.
    const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
    expect(onMaster.filter((c) => c === "ansiwise serve")).toHaveLength(2); // one conversation per program step
    expect(onMaster.some((c) => c.includes("-n argocd get applications.argoproj.io"))).toBe(true);

    // The machine's OWN records: dry + run per program, every one green. This is the record an
    // operator on the machine reads — the manager reported nothing the machine does not stand behind.
    const after = await observer.runs();
    const fresh = after.filter((a) => !before.some((b) => b.id === a.id && b.mode === a.mode));
    const byProgram = (name: string): string[] => fresh.filter((x) => x.program === name && x.exit_code === 0).map((x) => x.mode).sort();
    expect(byProgram("deploy-cluster")).toEqual(["dry", "run"]);
    expect(byProgram("deploy-gitops")).toEqual(["dry", "run"]);

    // The step's checkpoint carries both machine runs green — what a re-entry would skip on.
    const checkpoint = stepColumn(h.db, r.runId, "run-deploy-cluster", "checkpoint_json") ?? "";
    expect(checkpoint).toContain('"exitCode":0');

    // No pin was touched: redeploy moves nothing in the platform repo, whatever delivers the
    // machine layer.
    expect(h.platformRepo.commits).toHaveLength(0);
    expect(h.platformRepo.tags.size).toBe(0);
  });

  it("PLANTED DEFECT (verb): a dry the machine judges red FAILS the step before anything is acted on — no run-mode machine run starts", { timeout: 60_000 }, async () => {
    const h = await liveMaster();
    const runsBefore = (await observer.runs()).filter((x) => x.program === "deploy-cluster" && x.mode === "run").length;

    const r = await h.executor.plan("redeploy", { serverId: MASTER_ID });
    // "not-an-email" fails the program's own ^[^@]+@[^@]+$ row — the defect is ON THE MACHINE'S
    // SIDE of the wire, and the machine's dry run is what catches it.
    await h.executor.approve(r.runId, approveSecrets("not-an-email"));
    await h.executor.settle(r.runId);

    expect(getRun(h.db.db, r.runId)?.status).toBe("failed");
    expect(stepColumn(h.db, r.runId, "run-deploy-cluster", "error")).toMatch(/DRY run of deploy-cluster on the machine is not green/);
    // The proof failed, so the act never started: not one new run-mode record on the machine.
    const runsAfter = (await observer.runs()).filter((x) => x.program === "deploy-cluster" && x.mode === "run").length;
    expect(runsAfter).toBe(runsBefore);
  });

  it("re-entry re-attaches with ?from= instead of starting a second run, and a green checkpoint repeats nothing", { timeout: 120_000 }, async () => {
    const h = await liveMaster();
    const email = uniqueEmail();
    const answers = composedAnswers(email);

    // The crashed manager: a dry was POSTed, the machine run is going (here: already done — the
    // record does not care), and the manager died before seeing one event. All it has is the
    // checkpoint holding the machine's run id.
    const dry = await observerStart({ program: "deploy-cluster", mode: "dry", answers });
    let checkpoint: unknown = { program: "deploy-cluster", dry: { id: dry.run, seen: -1 } };
    const logs: string[] = [];
    const ctx = stepCtx(h, {
      secrets: approveSecrets(email),
      log: (line) => logs.push(line),
      readCheckpoint: () => checkpoint,
      checkpoint: (data) => (checkpoint = data),
    });

    const step = ansiwiseProgramStep(activeClusterTarget(MASTER_ID), "deploy-cluster", { ansiwiseServeCommand: "ansiwise serve" });
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

  /** What a release's approve carries: the elevation password, the two deploy-cluster inputs, the
   *  regenerate-branch committer identity, and the three build-plane PATs the master's own map
   *  demands (MASTER_MARKING_YAML names m1 as its own build plane). The fixture programs declare
   *  none of the PAT answers, so the values ride approve and are never sent — exactly the
   *  composition contract: only what a program declares reaches it. */
  const releaseSecrets = (email: string): Record<string, Buffer> => ({
    ...approveSecrets(email),
    "activation-input:committer_email": Buffer.from(email),
    "activation-input:build_hostyour_cloud_repo_pat": Buffer.from("github_pat_cloud"),
    "activation-input:build_hostyour_manager_repo_pat": Buffer.from("github_pat_manager"),
    "activation-input:build_catalog_repo_pat": Buffer.from("github_pat_catalog"),
  });

  const releaseParams = { serverId: MASTER_ID, version: "1.0.0", channel: "stable" as const };

  it("INNOCENT CASE (release): pin → refresh → regenerate-branch → deploy-cluster → deploy-gitops, every program proven dry then run on the machine's own records", { timeout: 120_000 }, async () => {
    const h = await liveMaster();
    const email = uniqueEmail();
    const before = await observer.runs();

    const r = await h.executor.plan("release", releaseParams);
    expect(r.plan.steps.map((s) => s.name)).toEqual([
      "attest-target", "set-pin", "refresh-checkout",
      "run-regenerate-branch", "run-deploy-cluster", "run-deploy-gitops", "argocd-follow",
    ]);
    await h.executor.approve(r.runId, releaseSecrets(email));
    await h.executor.settle(r.runId);
    expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

    // The pin: ONE tag, minted in the release grammar, and the map states it. This is what the
    // regeneration on a real machine reads back off the branch (the fixture program only measures —
    // the merge semantics are regenerate-branch's own rows, proven in its catalogue).
    expect(h.platformRepo.tags.size).toBe(1);
    const tag = [...h.platformRepo.tags.keys()][0] ?? "";
    expect(tag).toMatch(/^1\.0\.0-stable-\d{14}$/);
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath("m1.example.com"))).toContain(`release: ${tag}`);

    // The machine's OWN records: dry + run per program, every one green, all three programs.
    const fresh = (await observer.runs()).filter((a) => !before.some((b) => b.id === a.id && b.mode === a.mode));
    const byProgram = (name: string): string[] => fresh.filter((x) => x.program === name && x.exit_code === 0).map((x) => x.mode).sort();
    expect(byProgram("regenerate-branch")).toEqual(["dry", "run"]);
    expect(byProgram("deploy-cluster")).toEqual(["dry", "run"]);
    expect(byProgram("deploy-gitops")).toEqual(["dry", "run"]);

    // The machine's checkout was refreshed BEFORE the programs read it (the pin commit and the tag
    // reach the machine through that step or not at all), the three conversations went over the
    // machine's serve surface, and the follow still read ArgoCD.
    const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
    expect(onMaster.some((c) => c.includes("dc-refresh-checkout-"))).toBe(true);
    expect(onMaster.filter((c) => c === "ansiwise serve")).toHaveLength(3); // one conversation per program step
    expect(onMaster.some((c) => c.includes("-n argocd get applications.argoproj.io"))).toBe(true);
  });

  it("PLANTED DEFECT (release): a committer identity the machine's dry run judges red fails run-regenerate-branch — no run-mode regeneration, and the two deploy programs never start", { timeout: 60_000 }, async () => {
    const h = await liveMaster();
    const before = await observer.runs();

    const r = await h.executor.plan("release", releaseParams);
    // "not-an-email" fails the program's own ^[^@]+@[^@]+$ row — the defect is ON THE MACHINE'S
    // SIDE of the wire, and the machine's dry run is what catches it. (approveSecrets seeds a VALID
    // letsencrypt mailbox, so only the committer identity is wrong.)
    await h.executor.approve(r.runId, { ...releaseSecrets(uniqueEmail()), "activation-input:committer_email": Buffer.from("not-an-email") });
    await h.executor.settle(r.runId);

    expect(getRun(h.db.db, r.runId)?.status).toBe("failed");
    expect(stepColumn(h.db, r.runId, "run-regenerate-branch", "error")).toMatch(/DRY run of regenerate-branch on the machine is not green/);

    // The proof failed, so nothing after it was acted on: not one run-mode regeneration, and the
    // two deploy programs saw no run of ANY mode. The pin stands — set-pin precedes the machine
    // acts by design, and a retry of the run adopts exactly that tag instead of minting a second.
    const fresh = (await observer.runs()).filter((a) => !before.some((b) => b.id === a.id && b.mode === a.mode));
    expect(fresh.filter((x) => x.program === "regenerate-branch" && x.mode === "run")).toHaveLength(0);
    expect(fresh.filter((x) => x.program === "deploy-cluster" || x.program === "deploy-gitops")).toHaveLength(0);
    expect(h.platformRepo.tags.size).toBe(1);
  });

  /** A hand StepCtx for driving one program step directly — the executor-shaped surface with the
   *  test holding the checkpoint, the secrets and the log. */
  function stepCtx(h: Harness, over: {
    secrets: Record<string, Buffer>;
    log: (line: string) => void;
    readCheckpoint: () => unknown;
    checkpoint: (data: unknown) => void;
  }): StepCtx {
    const session: SshSession = {
      hostKeyFingerprint: () => "SHA256:fixture",
      isClosed: () => false,
      close: () => undefined,
      putFile: () => Promise.resolve(),
      forwardLocalPort: () => Promise.resolve({ localPort: 0, close: () => undefined }),
      exec: () => Promise.reject(new Error("the program step speaks over openChannel, never exec")),
      mustExec: () => Promise.reject(new Error("the program step speaks over openChannel, never exec")),
      openChannel: async () => {
        const stream = openChannel(serve);
        return { stream, close: () => stream.destroy() };
      },
    };
    return {
      runId: "run_reentry",
      stepName: "run-deploy-cluster",
      db: h.db.db,
      creds: h.store,
      params: { serverId: MASTER_ID },
      secrets: { get: (name) => over.secrets[name], wipe: () => undefined },
      signal: new AbortController().signal,
      logger,
      ssh: () => Promise.resolve(session),
      openPasswordSession: () => Promise.reject(new Error("not in this test")),
      closePasswordSession: () => undefined,
      attest: () => Promise.resolve(),
      log: (_stream, text) => over.log(text),
      checkpoint: over.checkpoint,
      readCheckpoint: <T,>() => over.readCheckpoint() as T | undefined,
      registerCleanup: () => undefined,
    };
  }
});
