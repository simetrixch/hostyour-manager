import { expect } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Conversation } from "../../adapters/ssh/testing/fake-server.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import type { RunKind } from "../../../shared/enums.ts";
import type { StepCtx } from "../../executor/types.ts";
import { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import { AnsiwiseRefused, type AnsiwiseRunRecord } from "../../adapters/ansiwise/port.ts";
import { openChannel, programYaml, runRoot, type ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeHarness, scriptedHosts, logger, MASTER_ID, SLAVE_ID, type Harness } from "./deploy-slave.fixture.ts";
import type { DbHandle } from "../../db/client.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

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
    // layer (s1/slave) — so the identity rows take either spelling; books_fqdn and build_plane_fqdn
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
      { answer: "books_fqdn", pattern: "^m1\\.example\\.com$", fallback: "m1.example.com" },
      { answer: "build_plane_fqdn", pattern: "^m1\\.example\\.com$", fallback: "m1.example.com" },
    ]),
    // elevation_password is deliberately NOT declared, although the real deploy-platform-services declares
    // it: the ENGINE fills that answer from the password the POST carries beside the answers
    // (sending it AS an answer is refused), but the REST door validates the raw answers map
    // BEFORE the run's fill-in — a required one is refused at the door — and the run child folds
    // the filled password into its fingerprint while the door computes one without it, so the
    // gate never admits the run that follows its own green dry. Both are the machine side's to
    // repair (see the handover); until then a program declaring that answer cannot be driven
    // over `ansiwise-rest serve`, and this fixture measures what CAN be.
    "deploy-platform-services": programYaml("deploy-platform-services", [
      { answer: "fqdn", pattern: "^(m1|s1)\\.example\\.com$" },
      { answer: "stage", pattern: "^prod$" },
      { answer: "role", pattern: "^(master|slave)$" },
      { answer: "books_fqdn", pattern: "^m1\\.example\\.com$", fallback: "m1.example.com" },
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
      { answer: "build_plane_fqdn", pattern: "^m1\\.example\\.com$" },
      { answer: "unit_apex", pattern: "^example\\.com$" },
      { answer: "platform_domain", pattern: "^example\\.com$" },
      { answer: "catalog_repo", pattern: "^acme/acme-catalog$" },
      { answer: "committer_email", pattern: "^[^@]+@[^@]+$" },
    ]),
    // The SLAVE release's regeneration, which runs on the MASTER's surface and is handed nothing out
    // of any cluster map: the real program reads the master's map off the machine itself, so what
    // the manager owes it is the slave's two facts, the pinned role, and the committer identity from
    // approve. A row for build_plane_fqdn or unit_apex here would measure a composition this program
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
export function serveConversation(serve: ServeFixture): Conversation {
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
      // a branch's first touch unless clusters/platform/values-common.yaml already stands there.
      h.platformRepo.seed("s1.example.com", "clusters/platform/values-common.yaml", "global: {}\n");
      h.platformRepo.seed("s1.example.com", clusterMapPath("s1.example.com"), `global:\n  endpoints:\n    tailnet:\n      url: ${opts.tailnetUrl ?? "https://tale.m1.example.com"}\n`);
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
  h.platformRepo.seed("s1.example.com", "clusters/platform/values-common.yaml", "global: {}\n");
  h.platformRepo.seed("s1.example.com", clusterMapPath("s1.example.com"), "global:\n  endpoints:\n    tailnet:\n      url: https://tale.m1.example.com\n");
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

// WHICH RECORDS BELONG TO THE RUN UNDER TEST, and why this is not a diff over time. These assertions
// used to take the records that appeared between two `observer.runs()` readings. The machine's record
// store is one directory shared by every `ansiwise-rest serve` the suite starts, and a run is a
// DETACHED child: it writes its record when it finishes, which can be after the test that started it
// has ended. So a record belonging to an earlier test landed inside a later test's two readings and
// was counted as that test's — the later test then saw a program it never ran, or saw one of its own
// programs twice. Neither emptying the store between tests nor filtering on the record id's stamp
// closes that: the id's stamp reaches seconds, and the stray shares the second.
//
// So the records are named rather than timed. Every program step checkpoints the machine runs it
// drove (ProgramCheckpoint in defs/ansiwise-run.kit.ts: the program, its `dry` mark and its `live`
// mark, each carrying the machine's own run id), and the checkpoint is written by the step that did
// the work. That is an identity, and an identity cannot be handed to the wrong test.
//
// The machine's own records are still read, because a checkpoint says what the MANAGER believes and
// the whole point of this suite is to hold that against what the MACHINE stands behind. They are read
// over a WINDOW: from the oldest run this manager run recorded, to the newest record on the machine.
// A second run of the same program — the defect this suite exists to catch — is newer than that
// oldest id and is therefore inside the window and caught. A stray from an earlier test is older and
// is therefore outside it. `GET /runs` answers newest-first (the runs endpoint says so), which is
// what makes the window a slice rather than a comparison.

/** One machine run this manager run started: which program, in which mode, under which id. */
export interface StartedRun {
  program: string;
  mode: string;
  id: string;
}

// programPhase (defs/ansiwise-run.kit.ts) logs one meta line per phase it starts, and one when it
// re-attaches to a phase already in flight. Those two lines are the manager's COMPLETE account of the
// machine runs it drove — complete in a way the step checkpoints are not, because a step may
// deliberately record nothing (tailnet's mint is create-only and is never checkpointed, by its own
// documented design) while still having started a machine run.
const STARTED = /^(\S+) (dry|run): (?:machine run (\S+) started|re-attaching to machine run (\S+))/;

/** Every machine run [runId] started, read out of its own run log, de-duplicated: a re-attach names
 *  a run that was already started, and it is the same run. */
export function startedRuns(db: DbHandle, runId: string): StartedRun[] {
  const rows = db.sqlite
    .prepare("SELECT text FROM events WHERE run_id = ? ORDER BY seq")
    .all(runId) as { text: string }[];
  const seen = new Set<string>();
  const out: StartedRun[] = [];
  for (const row of rows) {
    const m = STARTED.exec(row.text);
    if (m === null) continue;
    const id = m[3] ?? m[4] ?? "";
    const key = JSON.stringify([m[1], m[2], id]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ program: m[1] ?? "", mode: m[2] ?? "", id });
  }
  return out;
}

/** The machine's records from the OLDEST run [started] names to the newest on the machine. [all] is
 *  `observer.runs()`, newest-first. Empty when this run started nothing — then there is no window and
 *  no claim to make about the machine. */
export function recordWindow(all: AnsiwiseRunRecord[], started: StartedRun[]): AnsiwiseRunRecord[] {
  const mine = new Set(started.map((r) => r.id));
  let oldest = -1;
  all.forEach((r, i) => {
    if (mine.has(r.id)) oldest = i;
  });
  return oldest === -1 ? [] : all.slice(0, oldest + 1);
}

/** The GREEN modes [window] holds for [program], sorted — `["dry", "run"]` is the proven-then-
 *  performed shape every innocent case asserts per program. */
export function greenModes(window: AnsiwiseRunRecord[], program: string): string[] {
  return window.filter((x) => x.program === program && x.exit_code === 0).map((x) => x.mode).sort();
}

/** Assert the proven-then-performed pair, on BOTH accounts and by IDENTITY.
 *
 *  Leg one: the manager started exactly one dry and one run for the program, and the machine's record
 *  for each of those ids is green. That is the manager's claim held against what the machine stands
 *  behind, named rather than counted.
 *
 *  Leg two: over the window those ids open, the machine carries no OTHER green record for the
 *  program. That is what catches a second run — the defect this suite exists for — whoever started
 *  it, while a record from an earlier test stays outside the window and cannot be mistaken for one.
 *
 *  A RECORD WITHOUT AN END IS NAMED, NOT COMPARED. `exit_code` is absent in exactly one state that
 *  is not the program's doing — the closing header the engine renamed and lost — and leg one is
 *  where a run in that state arrives first. Comparing the absence against 0 produces
 *  `expected undefined to be +0`, which sends the reader looking for a program that went red;
 *  endMissing says which of the two states it is and which file to open. Leg two cannot produce
 *  that shape at all once leg one has passed: every id it counts is one leg one just found green,
 *  so the modes it reports can only be a SUPERSET, which is the second run it exists to catch. */
export function expectProven(serve: ServeFixture, db: DbHandle, runId: string, all: AnsiwiseRunRecord[], programs: string[]): void {
  const started = startedRuns(db, runId);
  const window = recordWindow(all, started);
  for (const program of programs) {
    const mine = started.filter((r) => r.program === program);
    expect(mine.map((r) => r.mode).sort(), `${program}: the machine runs ${runId} started`).toEqual(["dry", "run"]);
    for (const r of mine) {
      const record = all.find((x) => x.id === r.id);
      expect(record, `${program}: the machine has no record of the ${r.mode} run ${r.id}`).toBeDefined();
      const at = `${program}: the ${r.mode} run ${r.id} on the machine`;
      const ended = record?.exit_code !== undefined && record.exit_code !== null;
      expect(record?.exit_code, ended ? at : `${at} — ${endMissing(serve, r.id)}`).toBe(0);
    }
    expect(greenModes(window, program), program).toEqual(["dry", "run"]);
  }
}

/** Assert this run drove these programs NOT AT ALL: it started no machine run for one, and the
 *  machine carries no record of one over the window this run's other programs opened. */
export function expectAbsent(db: DbHandle, runId: string, all: AnsiwiseRunRecord[], programs: string[]): void {
  const started = startedRuns(db, runId);
  const window = recordWindow(all, started);
  for (const program of programs) {
    expect(started.filter((r) => r.program === program), `${program}: run ${runId} started a machine run for it`).toHaveLength(0);
    expect(window.filter((x) => x.program === program), program).toHaveLength(0);
  }
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

/** Waits until the machine's record for [id] carries an end, for as long as the CALLER is willing to
 *  wait. 404 right after the accept is "not written yet": a run is a detached process that writes its
 *  header a beat after it starts.
 *
 *  THE BUDGET IS THE CALLER'S AND THIS HOLDS NONE OF ITS OWN. [signal] is the AbortSignal vitest
 *  gives every test, which fires when that test's declared timeout runs out — so a caller that
 *  budgeted 300s waits 300s. A deadline inside here instead would silently overrule every one of
 *  them, and the callers do not agree on a number: they declare 60s, 120s and 300s deliberately.
 *
 *  AND IT REPORTS WHAT IT SAW, NOT WHAT IT ASSUMES. Giving up is not evidence that the run did not
 *  end — it may end a moment later — so the refusal says this stopped watching and what the last
 *  reading was, and never that the run "never ended".
 *
 *  ONE READER OF run.json, AND IT IS THE SURFACE. What the record says is what `observer.run` just
 *  answered; the only file this opens itself is run.json.writing, which the rename does not care
 *  about (pendingEnd carries the measurement). */
export async function observerEnded(observer: AnsiwiseClient, serve: ServeFixture, id: string, signal: AbortSignal): Promise<void> {
  let lastSeen = "no record on the machine yet";
  while (!signal.aborted) {
    try {
      const record = await observer.run(id);
      if (record.exit_code !== undefined && record.exit_code !== null) return;
      lastSeen = "a record carrying no end";
    } catch (err) {
      if (!(err instanceof AnsiwiseRefused) || err.status !== 404) throw err;
    }
    const stranded = await strandedEnd(serve, id, signal);
    if (stranded !== undefined) throw new Error(stranded);
    await rest(100, signal);
  }
  throw new Error(`stopped watching machine run ${id} — the test's own budget ran out; last reading: ${lastSeen}`);
}

/** How long the two files have to keep saying the same thing before it counts (see strandedEnd). */
const STRANDED_SETTLE_MS = 1_000;

/** Waits [ms], or until [signal] fires — whichever comes first.
 *
 *  The waits in here are the only places that could overrun the caller's budget, and the settle
 *  window below is a full second of it. A plain setTimeout holds the caller past its own deadline
 *  and then reports a timeout with no reading behind it, which is the failure this whole file
 *  exists to stop producing. */
function rest(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Does the pending header beside [id]'s record carry an end?
 *
 *  THIS READS THE RENAME'S SOURCE AND NEVER ITS TARGET, and that is the whole reason it reads one
 *  file instead of two. The state below is produced by a rename that fails while a reader holds the
 *  target open, so a detector that opened run.json every poll turn was raising the rate of the very
 *  thing it measures. Measured on this platform, 300 renames per row, the renaming process and the
 *  reading process separate, the reader spinning as fast as it can read:
 *
 *    no reader                       0 of 300 renames lost
 *    a reader on run.json            270 of 300 lost
 *    a reader on run.json.writing    0 of 300 lost
 *
 *  What run.json says is taken from the record the caller already read over the surface instead —
 *  the same reading the wait itself judges, so the two halves can no longer disagree about the same
 *  moment. The surface is a reader of run.json as well and that one stays: it IS the wait. */
function pendingEnd(serve: ServeFixture, id: string): boolean {
  try {
    const { exit_code: code } = JSON.parse(readFileSync(join(runRoot(serve.dir), id, "run.json.writing"), "utf8")) as { exit_code?: number | null };
    return code !== undefined && code !== null;
  } catch {
    return false; // absent, or half written — either way it is not an end anybody can read
  }
}

/** What to say about a machine run whose record carries no end, for a caller that has already
 *  decided to fail: which of the two states this is, and where the answer stands. The disk is read
 *  ONCE and with no settle window, so this belongs where the run is over and nothing is still
 *  renaming — an assertion after the run settled, never a poll while it runs. */
function endMissing(serve: ServeFixture, id: string): string {
  const dir = join(runRoot(serve.dir), id);
  return pendingEnd(serve, id)
    ? `its end was written and never installed: ${join(dir, "run.json.writing")} carries the exit code and ${join(dir, "run.json")} carries none. The engine renames the one onto the other and that rename did not land`
    : `its record carries no end and no ${join(dir, "run.json.writing")} beside it carries one either, so the run had not finished when this was read`;
}

/** The message for an end the machine wrote that never became its record, or nothing when the record
 *  is simply not there yet. Called only where the SURFACE has just answered that the record carries
 *  no end, which is the other half of the state and is never read off the disk here.
 *
 *  A run's closing header is written beside the real one and renamed over it (ansiwise-core
 *  lib/src/infrastructure/file_recorder.dart, RunRecorder.save). Measured on Windows over 365 runs
 *  of this fixture: that rename fails while any process has run.json open, at a rate that rises with
 *  how often it is read — 0 of 100 with no reader, 1 of 40 read ten times a second, 12 of 60 read as
 *  fast as the surface answers — and it carries no retry, so run.json.writing is left holding the
 *  exit code while run.json keeps the header the run began with. Every one of those 34 orphans held
 *  the exit code, so the run itself finished and only the rename was lost.
 *
 *  Waiting on a record in that state waits for something nothing will ever write, which is why this
 *  is read at all: without it the caller spends its whole budget and vitest reports a bare timeout
 *  pointing at the it() line, which says nothing about the machine.
 *
 *  CONFIRMED BEFORE IT IS REPORTED. run.json.writing holds exactly this shape for the microseconds
 *  between the write and the rename of the closing save, so a single reading could call a run
 *  stranded that is about to be fine. The pending header has to still carry the end a second later,
 *  which is four orders of magnitude longer than that window — and it is gone the instant the
 *  rename lands, so the settle also clears a run that ended DURING the window. */
async function strandedEnd(serve: ServeFixture, id: string, signal: AbortSignal): Promise<string | undefined> {
  if (!pendingEnd(serve, id)) return undefined;
  await rest(STRANDED_SETTLE_MS, signal);
  if (signal.aborted || !pendingEnd(serve, id)) return undefined;
  const dir = join(runRoot(serve.dir), id);
  return `machine run ${id} ended and its end was never installed: ${join(dir, "run.json.writing")} carries the exit code and ${join(dir, "run.json")} still carries none, ${STRANDED_SETTLE_MS}ms apart. The engine renames the one onto the other and that rename did not land; nothing will retry it, so no amount of further waiting can find an end here`;
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
