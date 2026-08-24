import { expect } from "vitest";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import type { ServerChannel } from "ssh2";
import type { SshSession } from "../../adapters/ssh/port.ts";
import type { RunKind } from "../../../shared/enums.ts";
import type { StepCtx } from "../../executor/types.ts";
import { AnsiwiseClient } from "../../adapters/ansiwise/client.ts";
import { AnsiwiseRefused, type AnsiwiseRunRecord } from "../../adapters/ansiwise/port.ts";
import { openChannel, programYaml, type ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeHarness, scriptedHosts, logger, MASTER_ID, SLAVE_ID, type Harness } from "./deploy-slave.fixture.ts";

// The fixture half of the ONE suite that talks to a real `ansiwise-rest serve`
// (redeploy.ansiwise.test.ts): the measuring programs the serve installation carries, the worlds
// the run kinds run in, and the observer/step plumbing. Split out of the test file (the file-size
// doctrine); nothing here asserts — the suite does.

export const ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

// The letsencrypt answers ride approve as activation inputs; a UNIQUE email per test gives each
// test its own fingerprint, so one test's green dry can never admit another test's run.
let stamp = 0;
export const uniqueEmail = (): string => `op-${Date.now()}-${++stamp}@example.com`;

export const approveSecrets = (email: string): Record<string, Buffer> => ({
  [ANSIWISE_ELEVATION_SECRET]: Buffer.from("root-pw"),
  "activation-input:letsencrypt_email": Buffer.from(email),
  "activation-input:letsencrypt_server": Buffer.from(ACME_STAGING),
});

export const elevationOnly = (): Record<string, Buffer> => ({ [ANSIWISE_ELEVATION_SECRET]: Buffer.from("root-pw") });

/** What deploy-slave's approve carries: the elevation password, the machine-layer inputs, and the
 *  branch cut's committer identity. */
export const deploySecrets = (email: string): Record<string, Buffer> => ({
  ...approveSecrets(email),
  "activation-input:committer_email": Buffer.from(email),
});

/** What a release's approve carries: the elevation password, the two deploy-cluster inputs, the
 *  regenerate-branch committer identity, and the three build-plane PATs the master's own map
 *  demands (MASTER_MARKING_YAML names m1 as its own build plane). The fixture programs declare
 *  none of the PAT answers, so the values ride approve and are never sent — exactly the
 *  composition contract: only what a program declares reaches it. */
export const releaseSecrets = (email: string): Record<string, Buffer> => ({
  ...deploySecrets(email),
  "activation-input:build_hostyour_cloud_repo_pat": Buffer.from("github_pat_cloud"),
  "activation-input:build_hostyour_manager_repo_pat": Buffer.from("github_pat_manager"),
  "activation-input:build_catalog_repo_pat": Buffer.from("github_pat_catalog"),
});

/** What the step composes for deploy-cluster on the fixture master — mirrored ONLY so a test can
 *  start a dry run itself and hand its id to the step as a checkpoint (the crashed-manager
 *  re-entry). The values are the harness rows': domain, stage, role, sshUser. */
export const composedAnswers = (email: string): Record<string, string> => ({
  fqdn: "m1.example.com",
  stage: "prod",
  role: "master",
  operator_user: "m1",
  letsencrypt_email: email,
  letsencrypt_server: ACME_STAGING,
});

/** A fixture for a program whose REAL declaration carries no answers (the tailnet client run kinds):
 *  one defaulted row, so a run whose caller sent NOTHING still exercises the engine's own record
 *  semantics — and still goes red if the engine were handed a stray value that shadows the default. */
const clientRunKindYaml = (name: string, word: string): string => [
  `name: ${name}`,
  "roles: [master, slave]",
  "answers:",
  "  - name: act",
  "    kind: text",
  `    default: ${word}`,
  "    describes: a defaulted answer nothing supplies",
  "steps:",
  "  - step: require_answer_matches",
  "    answer: act",
  `    pattern: '^${word}$'`,
  "    refusal: the act does not match",
  "    on_failure: exit",
  "",
].join("\n");

/** The measuring programs the ONE serve installation carries — a fixture per real program the
 *  run kinds drive, each judging the COMPOSITION: every row goes red when the manager composes the
 *  value wrong or not at all, so a green run IS the proof the manager composed what the program
 *  declared. */
export function fixturePrograms(): Record<string, string> {
  return {
    // TWO run kinds run deploy-cluster — redeploy's master arm (m1/master) and deploy-slave's machine
    // layer (s1/slave) — so the identity rows take either spelling; books_cluster and build_plane
    // carry the master's domain as their fallback, because the master arm legitimately sends
    // neither (the real program defaults them to the machine's own domain) while a slave that
    // sent its OWN domain goes red.
    "deploy-cluster": programYaml("deploy-cluster", [
      { answer: "fqdn", pattern: "^(m1|s1)\\.example\\.com$" },
      { answer: "stage", pattern: "^prod$" },
      { answer: "role", pattern: "^(master|slave)$" },
      { answer: "operator_user", pattern: "^(m1|ubuntu)$" },
      { answer: "letsencrypt_email", pattern: "^[^@]+@[^@]+$" },
      { answer: "letsencrypt_server", pattern: "^https://" },
      { answer: "books_cluster", pattern: "^m1\\.example\\.com$", fallback: "m1.example.com" },
      { answer: "build_plane", pattern: "^m1\\.example\\.com$", fallback: "m1.example.com" },
    ]),
    // elevation_password is deliberately NOT declared, although the real deploy-gitops declares
    // it: the ENGINE fills that answer from the password the POST carries beside the answers
    // (sending it AS an answer is refused), but the REST door validates the raw answers map
    // BEFORE the run's fill-in — a required one is refused at the door — and the run child folds
    // the filled password into its fingerprint while the door computes one without it, so the
    // gate never admits the run that follows its own green dry. Both are the machine side's to
    // repair (see the handover); until then a program declaring that answer cannot be driven
    // over `ansiwise-rest serve`, and this fixture measures what CAN be.
    "deploy-gitops": programYaml("deploy-gitops", [
      { answer: "fqdn", pattern: "^(m1|s1)\\.example\\.com$" },
      { answer: "stage", pattern: "^prod$" },
      { answer: "role", pattern: "^(master|slave)$" },
      { answer: "books_cluster", pattern: "^m1\\.example\\.com$", fallback: "m1.example.com" },
    ]),
    // The deploy-slave family. The branch cut takes the slave's two facts and the committer
    // identity from approve; the machine handshake takes ONE address spelling on both sides
    // (emit and register), and register additionally the credentials file's values as answers.
    "deploy-slave-branch": programYaml("deploy-slave-branch", [
      { answer: "fqdn", pattern: "^s1\\.example\\.com$" },
      { answer: "stage", pattern: "^prod$" },
      { answer: "role", pattern: "^slave$" },
      { answer: "committer_email", pattern: "^[^@]+@[^@]+$" },
    ]),
    "deploy-host": programYaml("deploy-host", [
      { answer: "operator_user", pattern: "^ubuntu$" },
      { answer: "operator_public_key", pattern: "^ssh-ed25519 " },
    ]),
    "emit-cluster-credentials": programYaml("emit-cluster-credentials", [
      { answer: "api_server_url", pattern: "^https://100\\.64\\.0\\.11:16443$" },
    ]),
    "register-slave": programYaml("register-slave", [
      { answer: "stage", pattern: "^prod$" },
      { answer: "slave_fqdn", pattern: "^s1\\.example\\.com$" },
      { answer: "api_server_url", pattern: "^https://100\\.64\\.0\\.11:16443$" },
      { answer: "ca_data", pattern: "^TFMtQ0EtREFUQQ==$" },
      { answer: "argocd_token", pattern: "^eyJhbGciOiJSUzI1NiJ9\\.argocd-manager-" },
      { answer: "reviewer_token", pattern: "^eyJhbGciOiJSUzI1NiJ9\\.vault-token-reviewer-" },
    ]),
    "remove-slave": programYaml("remove-slave", [
      { answer: "stage", pattern: "^prod$" },
      { answer: "slave_fqdn", pattern: "^s1\\.example\\.com$" },
    ]),
    // The release's regeneration: the MAP-sourced answers (markingAnswers reads them off
    // clusters/active/m1.example.com.yaml — the harness seeds MASTER_MARKING_YAML) and the approve
    // input each have a row. alert_recipients is deliberately NOT declared here: the program
    // declares it text_list, and the REST door does not take a list yet (see the handover finding
    // on ansiwise-rest) — its composition is proven at the unit level in release.test.ts.
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
    // The SLAVE release's regeneration, which runs on the MASTER's surface and is handed nothing out
    // of any cluster map: the real program reads the master's map off the machine itself, so what
    // the manager owes it is the slave's two facts, the pinned role, and the committer identity from
    // approve. A row for build_plane or unit_apex here would measure a composition this program
    // deliberately does not take.
    "regenerate-slave-branch": programYaml("regenerate-slave-branch", [
      { answer: "fqdn", pattern: "^s1\\.example\\.com$" },
      { answer: "stage", pattern: "^prod$" },
      { answer: "role", pattern: "^slave$" },
      { answer: "committer_email", pattern: "^[^@]+@[^@]+$" },
    ]),
    // The tailnet family. The two client run kinds' real programs declare NO answers, so their
    // fixtures declare one DEFAULTED row: the manager must send nothing at all for the run to go
    // green, which is exactly the composition contract on a host that may carry no cluster row.
    "tailnet-disconnect": clientRunKindYaml("tailnet-disconnect", "leave"),
    "tailnet-reconnect": clientRunKindYaml("tailnet-reconnect", "up"),
    "tailnet-mint-join-key": programYaml("tailnet-mint-join-key", [
      { answer: "stage", pattern: "^prod$" },
      { answer: "slave_fqdn", pattern: "^s1\\.example\\.com$" },
    ]),
    "tailnet-rejoin": programYaml("tailnet-rejoin", [
      { answer: "login_server", pattern: "^https://tale\\.m1\\.example\\.com$" },
      { answer: "auth_key", pattern: "^dc-tailnet-preauth-" },
    ]),
  };
}

/** A real sshd whose "ansiwise-rest serve" exec spawns the binary so its own standard input and output
 *  ARE the connection — exactly what an SSH exec channel hands a process. No token on this door: a
 *  session is authenticated by sshd, and a machine at its first installation has no token yet. */
export function serveConversation(serve: ServeFixture): (stream: ServerChannel) => void {
  return (stream) => {
    const child = spawn(serve.exe, ["serve", "--programs", "programs", "--config", "ansiwise.yaml"], { cwd: serve.dir });
    stream.pipe(child.stdin);
    child.stdout.pipe(stream);
    child.on("close", (code) => {
      stream.exit(code ?? 0);
      stream.end();
    });
    stream.on("close", () => child.kill());
  };
}

// ---- the worlds the run kinds run in, each wired to reach the real serve on every host ----

/** The ceiling table a release's attest reads, on the branch it reads it from — seeded by every
 *  world a release runs in, because that check is the one thing both arms do before anything else. */
function seedChannelTable(h: Harness): void {
  h.platformRepo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, [
    "global:",
    "  channelStages:",
    "    alpha: [dev]",
    "    beta: [dev, test]",
    "    stable: [dev, test, prod]",
    "",
  ].join("\n"));
}

/** A harness whose master carries an ACTIVE cluster — the state redeploy and release act on.
 *  The channel table rides along because a release's attest checks the ceiling against it. */
export async function liveMaster(serve: ServeFixture): Promise<Harness> {
  const hosts = scriptedHosts({ openConversation: async () => openChannel(serve) });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  seedChannelTable(h);
  h.db.db.update(servers).set({ role: "master+slave" }).where(eq(servers.id, MASTER_ID)).run();
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com",
    status: "active", tier: "rehearsal", planeState: "ready",
  }).run();
  return h;
}

/** A harness whose SLAVE is the tailnet run kinds' target. The cluster row and the profile (where the
 *  rejoin reads global.endpoints.tailnet.url) are the rejoin's world; the two client run kinds run without either
 *  — the host that needs them most is exactly the one whose deploy went wrong. */
export async function tailnetHost(serve: ServeFixture, opts: { cluster?: boolean; tailnetUrl?: string | false } = {}): Promise<Harness> {
  const hosts = scriptedHosts({ openConversation: async () => openChannel(serve) });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  if (opts.cluster ?? true) {
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", status: "active", slaveId: 1,
    }).run();
    if (opts.tailnetUrl !== false) {
      // Seeded BESIDE the values chain's sentinel file: the fake materializes its own profile on
      // a branch's first touch unless platform/values-common.yaml already stands there.
      h.platformRepo.seed("s1.example.com", "platform/values-common.yaml", "global: {}\n");
      h.platformRepo.seed("s1.example.com", "installation/profile.yaml", `global:\n  endpoints:\n    tailnet:\n      url: ${opts.tailnetUrl ?? "https://tale.m1.example.com"}\n`);
    }
  }
  return h;
}

/** A fresh, adopted slave and its master, wired to reach the real `ansiwise-rest serve` on BOTH hosts.
 *  ONE serve installation stands in for the two machines, and that is honest for what is under
 *  proof: the fixture's programs are pure measurements, so what the engine judges — the gate, the
 *  answers validation, the detached records — is host-independent, while WHICH surface each
 *  conversation went over is still real per host (the scripted sessions are keyed by host and
 *  every `ansiwise-rest serve` open is logged against the host it was opened on). What the programs
 *  would WRITE on a real machine is stood in by the scripted side: the slave-branch profile the
 *  join reads its coordinator address from (seeded on the fake platform repo) and the two
 *  credential files the manager `cat`s over the session. */
export async function deployWorld(serve: ServeFixture): Promise<Harness> {
  const hosts = scriptedHosts({ openConversation: async () => openChannel(serve) });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve", marking: false });
  h.platformRepo.seed("s1.example.com", "platform/values-common.yaml", "global: {}\n");
  h.platformRepo.seed("s1.example.com", "installation/profile.yaml", "global:\n  endpoints:\n    tailnet:\n      url: https://tale.m1.example.com\n");
  return h;
}

/** A slave that already IS one — redeploy's slave arm acts on this. The default marking rides
 *  along (makeHarness seeds SLAVE_MARKING_YAML), which is exactly what a live slave's books say. */
export async function liveSlaveWorld(serve: ServeFixture): Promise<Harness> {
  const hosts = scriptedHosts({ openConversation: async () => openChannel(serve) });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  h.db.db.insert(clusters).values({
    id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", status: "active", slaveId: 1, planeState: "ready",
  }).run();
  h.db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
  return h;
}

/** The same live slave, plus the ceiling table — release's slave arm acts on this. The MASTER is
 *  left as the plain `master` the harness inserts and carries no cluster row of its own, which is
 *  the ordinary one-master-one-slave installation: the pin and the books stand on that master's
 *  branch, named by its own host name, and the regeneration runs over its session. */
export async function releaseSlaveWorld(serve: ServeFixture): Promise<Harness> {
  const h = await liveSlaveWorld(serve);
  seedChannelTable(h);
  return h;
}

// ---- reading the machine's own records ----

/** The records that appeared between two `observer.runs()` readings. */
export function freshRuns(before: AnsiwiseRunRecord[], after: AnsiwiseRunRecord[]): AnsiwiseRunRecord[] {
  return after.filter((a) => !before.some((b) => b.id === a.id && b.mode === a.mode));
}

/** The GREEN modes [fresh] holds for [program], sorted — `["dry", "run"]` is the proven-then-
 *  performed shape every innocent case asserts per program. */
export function greenModes(fresh: AnsiwiseRunRecord[], program: string): string[] {
  return fresh.filter((x) => x.program === program && x.exit_code === 0).map((x) => x.mode).sort();
}

/** Assert the proven-then-performed pair on the machine's own records, per program. */
export function expectProven(fresh: AnsiwiseRunRecord[], programs: string[]): void {
  for (const program of programs) expect(greenModes(fresh, program), program).toEqual(["dry", "run"]);
}

/** Assert not one record of ANY mode exists for these programs among [fresh]. */
export function expectAbsent(fresh: AnsiwiseRunRecord[], programs: string[]): void {
  for (const program of programs) expect(fresh.filter((x) => x.program === program), program).toHaveLength(0);
}

/** plan → approve → settle in one breath, for the cases whose plan shape another test already
 *  pins. Returns the run id; the caller asserts the outcome. */
export async function settled(h: Harness, kind: RunKind, params: Record<string, unknown>, secrets: Record<string, Buffer>): Promise<string> {
  const { runId } = await h.executor.plan(kind, params);
  await h.executor.approve(runId, secrets);
  await h.executor.settle(runId);
  return runId;
}

/** A 202 answers before the detached child writes its header — the step absorbs that wait itself
 *  (ansiwise-run.kit appearedRecord); a raw follow in a test has to wait the same way. */
export async function recordAppeared(client: AnsiwiseClient, id: string): Promise<void> {
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

/** POST over the address wire — a run a TEST starts itself, to hand the step a checkpoint. */
export async function observerStart(serve: ServeFixture, start: { program: string; mode: "dry" | "run"; answers: Record<string, string> }): Promise<{ run: string; fingerprint: string }> {
  const client = new AnsiwiseClient({ kind: "address", host: "127.0.0.1", port: serve.port, token: serve.token });
  try {
    return await client.start({ ...start, elevationPassword: "pw" });
  } finally {
    client.close();
  }
}

/** Waits until the machine's record for [id] carries an end. 404 right after the accept is "not
 *  written yet": a run is a detached process that writes its header a beat after it starts. */
export async function observerEnded(observer: AnsiwiseClient, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const record = await observer.run(id);
      if (record.exit_code !== undefined && record.exit_code !== null) return;
    } catch (err) {
      if (!(err instanceof AnsiwiseRefused) || err.status !== 404) throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`machine run ${id} never ended`);
}

/** A hand StepCtx for driving one program step directly — the executor-shaped surface with the
 *  test holding the checkpoint, the secrets and the log. Its session refuses exec on purpose: the
 *  program step speaks over openChannel, never exec. */
export function programStepCtx(serve: ServeFixture, h: Harness, over: {
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
