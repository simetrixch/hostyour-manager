import { expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Conversation } from "../../adapters/ssh/testing/fake-server.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import type { RunKind } from "../../../shared/enums.ts";
import type { AnyRunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import { AnsiwiseRefused, type AnsiwiseRunRecord } from "../../adapters/ansiwise/port.ts";
import { openChannel, programYaml, runRoot, type ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { ANSIWISE_ELEVATION_SECRET, RECORD_APPEARS_POLL_MS, RECORD_APPEARS_TIMEOUT_MS } from "./defs/ansiwise-run.kit.ts";
import { ANSIWISE_REST_TOOL, ANSIWISE_SESSION_PROGRAM } from "./defs/place-ansiwise.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import {
  makeHarness, scriptedHosts, logger, ELEVATION_PASSWORD, MASTER_ID, SLAVE_ID,
  IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY, MASTER_PUBLIC_KEY, FIXTURE_REGISTRY_HOST, pullDocumentFor, seedMasterCluster,
  type Harness, type HostsScript,
} from "./deploy-slave.fixture.ts";
import type { DbHandle } from "../../db/client.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import {
  MASTER_FQDN, MASTER_MARKING_YAML, MAP_LETSENCRYPT_EMAIL, MAP_LETSENCRYPT_SERVER, MAP_TAILNET_URL,
  SLAVE_FQDN, SLAVE_MARKING_YAML,
} from "./cluster-maps.fixture.ts";

// The fixture half of the ONE suite that talks to a real `ansiwise-rest serve`
// (redeploy.ansiwise.test.ts): the measuring programs the serve installation carries, the worlds
// the run kinds run in, and the observer/step plumbing. Split out of the test file (the file-size
// doctrine); nothing here asserts — the suite does.

// A UNIQUE mailbox per test gives that test its own fingerprint, so one test's green dry can never
// admit another test's run. Where the test drives a STEP, the value has to go into the master's
// cluster map (seedMasterMailbox below), because that is where the step reads it; where a test POSTs
// to the machine itself, it states the value directly.
let stamp = 0;
export const uniqueEmail = (): string => `op-${Date.now()}-${++stamp}@example.com`;

/** THE ONLY THING ANY CLUSTER RUN KIND'S APPROVE CARRIES. Every answer the machine-layer programs
 *  declare beyond the inventory stands in the cluster map and is read there by the run definition
 *  (defs/deploy-slave.ts slaveMachineAnswers), so no plan lists an activation input at all. */
export const elevationOnly = (): Record<string, Buffer> => ({ [ANSIWISE_ELEVATION_SECRET]: Buffer.from(ELEVATION_PASSWORD) });

/** What the step composes for deploy-cluster on the fixture master — mirrored ONLY so a test can
 *  start a dry run itself and hand its id to the step as a checkpoint (the crashed-manager
 *  re-entry). Four values are the harness rows' (domain, stage, role, sshUser) and four are the
 *  master map's, which is what makes [email] a parameter: a test wanting its own fingerprint seeds
 *  that mailbox into the map and states the same one here, or the mirror and the step compose
 *  different answers and the gate admits neither against the other. */
export const composedAnswers = (email: string): Record<string, string> => ({
  fqdn: MASTER_FQDN,
  stage: "prod",
  role: "master+slave",
  operator_user: "m1",
  letsencrypt_email: email,
  letsencrypt_server: MAP_LETSENCRYPT_SERVER,
  books_fqdn: MASTER_FQDN,
  build_plane_fqdn: MASTER_FQDN,
  registry_pull_dockerconfigjson: pullDocumentFor(FIXTURE_REGISTRY_HOST),
});

/** The master's own cluster map, re-seeded with a different mailbox for the certificate authority —
 *  or with none at all where [email] is left out.
 *
 *  THE MAP IS WHERE THAT ANSWER COMES FROM, so a test about the value changes the map and never
 *  approve. `makeHarness` seeds `MASTER_MARKING_YAML` there and says a test about a master map
 *  without a field seeds over it, which is what this does. */
export function seedMasterMailbox(h: Harness, email?: string): void {
  const stated = `  letsencryptEmail: ${MAP_LETSENCRYPT_EMAIL}\n`;
  h.platformRepo.seed(
    h.platformRepo.booksBranch,
    clusterMapPath(MASTER_FQDN),
    MASTER_MARKING_YAML.replace(stated, email === undefined ? "" : `  letsencryptEmail: ${email}\n`),
  );
}

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
    // TWO run kinds run deploy-cluster — redeploy's master arm (m1, whose harness row carries the
    // union role master+slave and whose composition must send it WHOLE, never flattened to
    // "master") and deploy-slave's machine layer (s1/slave) — so the identity rows take either
    // spelling.
    //
    // BOOKS_FQDN AND BUILD_PLANE_FQDN ARE MEASURED LIKE THE REST, because every arm that drives this
    // program reads both off the cluster map (defs/deploy-slave.ts slaveMachineAnswers). An arm that
    // sent neither would be refused at the door by name, which is the answer this fixture owes: a
    // default standing in for a value nobody sent reports the composition green either way.
    "deploy-cluster": programYaml("deploy-cluster", [
      { answer: "fqdn", pattern: "^(m1|s1)\\.example\\.com$" },
      { answer: "stage", pattern: "^prod$" },
      { answer: "role", pattern: "^(master\\+slave|slave)$" },
      { answer: "operator_user", pattern: "^(m1|ubuntu)$" },
      { answer: "letsencrypt_email", pattern: "^[^@]+@[^@]+$" },
      { answer: "letsencrypt_server", pattern: "^https://" },
      { answer: "books_fqdn", pattern: "^m1\\.example\\.com$" },
      { answer: "build_plane_fqdn", pattern: "^m1\\.example\\.com$" },
      // THE CREDENTIAL, MEASURED LIKE THE REST AND DECLARED `secret`. Both arms send it: a machine
      // that keeps the books also pulls through the installation's own registry, and the manager
      // holds the one document either of them needs. The pattern is the shape of the base64
      // dockerconfigjson the manager composes, so a run that sent nothing, or sent something that is
      // not that document, is refused at the machine's own door. `secret` is what keeps the value
      // out of every record the engine writes — a thing a file-sourced credential can never be.
      { answer: "registry_pull_dockerconfigjson", pattern: "^[A-Za-z0-9+/=]{16,}$", secret: true },
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
      { answer: "role", pattern: "^(master\\+slave|slave)$" },
      { answer: "books_fqdn", pattern: "^m1\\.example\\.com$" },
    ]),
    // The deploy-slave family. NO BRANCH PROGRAM IS AMONG THEM: a pure slave has no install branch,
    // so nothing here cuts one. The machine handshake takes ONE address spelling on both sides
    // (emit and register), and register additionally the credentials file's values as answers.
    // TWO run kinds run deploy-host as well — redeploy's master arm (m1/master) and deploy-slave's
    // machine layer (s1/slave) — so the identity row takes either spelling, for the same reason
    // deploy-cluster's does.
    "deploy-host": programYaml("deploy-host", [
      { answer: "operator_user", pattern: "^(m1|ubuntu)$" },
      { answer: "operator_public_key", pattern: "^ssh-ed25519 " },
      // The two the machine cannot answer itself, because the checkout they would be read off is
      // what this program's git_clone row establishes. The BRANCH is the installation's ONE install
      // branch — the books, named after the cluster carrying the master part — for every machine,
      // the slave included: a pure slave has no branch of its own, and a pattern still admitting
      // `s1` would be a check that stopped covering its subject. Never the trunk either: a live tree
      // standing on master is a machine whose release-cluster then cannot find
      // clusters/active/<fqdn>.yaml, measured on a real one.
      { answer: "platform_repo", pattern: "^acme/platform$" },
      { answer: "platform_branch", pattern: "^m1\.example\.com$" },
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
    // The tailnet family. The two client run kinds' real programs declare NO answers, so their
    // fixtures declare one DEFAULTED row: the manager must send nothing at all for the run to go
    // green, which is exactly the composition contract on a host that may carry no cluster row.
    "tailnet-disconnect": clientRunKindYaml("tailnet-disconnect", "leave"),
    "tailnet-reconnect": clientRunKindYaml("tailnet-reconnect", "up"),
    // slave_fqdn takes either machine's domain: the credential is minted per MACHINE, and the
    // rejoin of the master itself mints under the master's own domain (the program's key_file
    // contract names the first DNS label either way).
    "tailnet-mint-join-key": programYaml("tailnet-mint-join-key", [
      { answer: "stage", pattern: "^prod$" },
      { answer: "slave_fqdn", pattern: "^(m1|s1)\\.example\\.com$" },
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
/** Whether a command opened a serve conversation, whatever the machine on the far end IS. The
 *  command carries `--role` (and a master's `--fqdn`) because the serving binary defaults the role
 *  to `master`: a serve started without it makes a slave claim to be a master, and the first program
 *  declared for a slave is then thrown out of Runner.run before it writes one event. The prefix says
 *  WHICH conversation this was; what it told the machine about itself is asserted where measured. */
export const isServe = (command: string): boolean =>
  command.startsWith(`${ANSIWISE_REST_TOOL} ${ANSIWISE_SESSION_PROGRAM}`);

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

/** A harness whose master carries an ACTIVE cluster — the state redeploy's master arm acts on.
 *
 *  Its machine carries no sudoers drop-in, like every other world here — see
 *  FirstContactScript.adopted (deploy-slave.first-contact.fixture.ts).
 *  A first master is installed by hostyour-cloud lifecycle/install-machine driving lifecycle/driver.sh,
 *  which writes no such file, so on a real one the only way to root is the elevation password the run
 *  itself carries.
 *
 *  AND THE MACHINE LOOKS LIKE A LIVE MASTER, which is what the first-contact steps at the head of
 *  that arm are re-measured against: this manager's key already stands in its authorized_keys and
 *  its clock already synchronises, because its own installation put both there. It also really
 *  JUDGES the key a session offers, so the door has something to decide rather than opening whatever
 *  is presented to it — and `overrides` is how the machine that lost that line is asked for, which is
 *  the machine a reinstall at the hosting provider hands back. */
export async function liveMaster(serve: ServeFixture, overrides: Partial<HostsScript> = {}): Promise<Harness> {
  const hosts = scriptedHosts({
    openConversation: async () => openChannel(serve),
    authorizedKeys: [IMAGE_KEY_LINE, MASTER_PUBLIC_KEY],
    ntp: "yes",
    judgesKeys: true,
    ...overrides,
  });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  h.db.db.update(servers).set({ role: "master+slave" }).where(eq(servers.id, MASTER_ID)).run();
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com",
    status: "active", planeState: "ready",
  }).run();
  return h;
}

/** A harness whose SLAVE is the tailnet run kinds' target. The cluster row and the map (where the
 *  rejoin reads global.endpoints.tailnet.url) are the rejoin's world; the two client run kinds run without either
 *  — the host that needs them most is exactly the one whose deploy went wrong.
 *
 *  [tailnetUrl] re-seeds the slave's map ON THE BOOKS BRANCH, which is where readLoginServer
 *  (defs/tailnet.kit.ts) reads that address: a cluster carrying only the slave part has no branch of
 *  its own, so a map seeded on a branch named after the cluster is one nothing reads. `false` takes
 *  the coordinator's address out of the map altogether. Left out, the map `makeHarness` seeds stands
 *  (SLAVE_MARKING_YAML, which states MAP_TAILNET_URL like every map of the installation). */
export async function tailnetHost(serve: ServeFixture, opts: { cluster?: boolean; tailnetUrl?: string | false } = {}): Promise<Harness> {
  const hosts = scriptedHosts({ openConversation: async () => openChannel(serve) });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  if (opts.cluster ?? true) {
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: SLAVE_FQDN, status: "active", slaveId: 1,
    }).run();
    if (opts.tailnetUrl !== undefined) {
      const stated = `    tailnet:\n      url: ${MAP_TAILNET_URL}\n`;
      h.platformRepo.seed(
        h.platformRepo.booksBranch,
        clusterMapPath(SLAVE_FQDN),
        SLAVE_MARKING_YAML.replace(stated, opts.tailnetUrl === false ? "" : `    tailnet:\n      url: ${opts.tailnetUrl}\n`),
      );
    }
  }
  return h;
}

/** A fresh slave this manager already holds a key for, and its master, wired to reach the real
 *  `ansiwise-rest serve` on BOTH hosts.
 *  ONE serve installation stands in for the two machines, and that is honest for what is under
 *  proof: the fixture's programs are pure measurements, so what the engine judges — the gate, the
 *  answers validation, the detached records — is host-independent, while WHICH surface each
 *  conversation went over is still real per host (the scripted sessions are keyed by host and
 *  every `ansiwise-rest serve` open is logged against the host it was opened on). What the programs
 *  would WRITE on a real machine is stood in by the scripted side: the two credential files the
 *  manager `cat`s over the session. The map the join reads its coordinator address from is not
 *  seeded here — the run's own marking step writes it, on the books branch, before the join. */
export async function deployWorld(serve: ServeFixture, opts: { withoutCarriedValues?: boolean } = {}): Promise<Harness> {
  const hosts = scriptedHosts({ openConversation: async () => openChannel(serve) });
  const h = await makeHarness({
    hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve", marking: false,
    ...(opts.withoutCarriedValues === true ? { withoutCarriedValues: true } : {}),
  });
  // The master's own cluster row, as boot seeds it on every installation: gitops-handoff and
  // verify-slave read the master's ArgoCD through it (defs/deploy-slave.kit.ts masterClusterId).
  seedMasterCluster(h);
  return h;
}

/** A slave that already IS one — redeploy's slave arm acts on this. The default marking rides
 *  along (makeHarness seeds SLAVE_MARKING_YAML), which is exactly what a live slave's books say.
 *
 *  AND THE MACHINE LOOKS LIKE ONE TOO, which is what the first-contact steps at the head of that arm
 *  are re-measured against: this manager's key already stands in its authorized_keys and its daemon
 *  already takes no password, because a deployment put both there. A live slave scripted as a fresh
 *  cloud image would let those steps write on every reconciliation and the suite would call it
 *  green — measure-then-act is only a property against a machine that has already been through the
 *  list once.
 *
 *  THE OVERRIDES ARE HOW THE OTHER MACHINE BEHIND THE SAME ROW IS SCRIPTED, and it is the one an
 *  owner actually redeploys: the row still says a finished deployment while the MACHINE was
 *  reinstalled at the hosting provider and carries none of it. That is a different host script under
 *  identical rows, exactly as `liveMaster` takes one for the master arm — never a second world with a
 *  second copy of the rows to drift from these. */
export async function liveSlaveWorld(serve: ServeFixture, overrides: Partial<HostsScript> = {}): Promise<Harness> {
  const hosts = scriptedHosts({
    openConversation: async () => openChannel(serve),
    authorizedKeys: [IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY],
    passwordLogin: "no",
    ntp: "yes",
    // And it judges the key a session offers against that file, so the door really opens on the key
    // here: a slave whose password door is shut has no other way in, and a run that reached the
    // machine on something else would prove nothing about the one it will meet.
    judgesKeys: true,
    ...overrides,
  });
  const h = await makeHarness({ hosts, keystore: "keyfile", ansiwiseServeCommand: "ansiwise-rest serve" });
  h.db.db.insert(clusters).values({
    id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", status: "active", slaveId: 1, planeState: "ready",
  }).run();
  h.db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
  seedMasterCluster(h);
  return h;
}

// ---- reading the machine's own records ----

// WHICH RECORDS BELONG TO THE RUN UNDER TEST, and why this is not a diff over time. Taking the
// records that appear between two `observer.runs()` readings does not work. The machine's record
// store is one directory shared by every `ansiwise-rest serve` the suite starts, and a run is a
// DETACHED child: it writes its record when it finishes, which can be after the test that started it
// has ended. So a record belonging to an earlier test lands inside a later test's two readings and
// is counted as that test's — the later test then sees a program it never ran, or sees one of its own
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

/** EVERYTHING THE MACHINE WROTE DOWN, as one string: every file under the engine's own run root,
 *  which is where a run's header, its answers and its events land on the box.
 *
 *  A secret is kept out of this manager's own surface by the redactor, and that is a claim about
 *  THIS process. What a value put on the far end leaves behind is a different claim, and the run
 *  root is the only place to read it: an answer the program declares `secret` is redacted there by
 *  the engine, and one that arrived as a file was never an answer at all. */
export function machineWroteDown(serve: ServeFixture): string {
  const root = runRoot(serve.dir);
  if (!existsSync(root)) return "";
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");
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
 *  (ansiwise-run.kit appearedRecord); a raw follow in a test has to wait the same way.
 *
 *  IT WAITS WHAT THE STEP WAITS, off the step's own constants rather than a second pair of numbers
 *  beside them. Two copies of a bound drift, and the copy that drifts is the one nobody is looking
 *  at: a fixture that gave up sooner than the step would report a machine as silent where the step
 *  it stands in for would have waited and been answered. */
export async function recordAppeared(client: AnsiwiseClient, id: string): Promise<void> {
  const attempts = Math.max(1, Math.ceil(RECORD_APPEARS_TIMEOUT_MS / RECORD_APPEARS_POLL_MS));
  for (let attempt = 0; ; attempt++) {
    try {
      await client.run(id);
      return;
    } catch (err) {
      if (!(err instanceof AnsiwiseRefused) || err.status !== 404 || attempt >= attempts) throw err;
    }
    await new Promise((r) => setTimeout(r, RECORD_APPEARS_POLL_MS));
  }
}

/** POST over a conversation of the TEST'S own — a run a test starts itself, to hand the step a
 *  checkpoint.
 *
 *  ITS OWN `serve`, AND THAT IS WHAT IT MEASURES. The run is a DETACHED child of the process that
 *  accepted it, so closing this conversation ends the surface that took the request and leaves the
 *  run going — which is exactly the machine `orphaned-end.ansiwise.suite.ts` is about. */
export async function observerStart(serve: ServeFixture, start: { program: string; mode: "dry" | "run"; answers: Record<string, string> }): Promise<{ run: string; fingerprint: string }> {
  const client = new AnsiwiseClient(openChannel(serve));
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
 *  target open, so a detector that opened run.json every poll turn would raise the rate of the very
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

/** One step out of the SHIPPED cluster-redeploy definition, built with the harness's own ports.
 *
 *  BUILT FROM THE DEFINITION AND NOT BESIDE IT. A program step's answers are half the definition's:
 *  the arm hands `deploy-cluster` the reader that composes them off the cluster map
 *  (defs/redeploy.ts). A step assembled by hand in a test carries whichever of those the test
 *  remembered, so it proves the re-entry logic against a composition nobody ships. */
export function redeployStep(h: Harness, name: string): Step {
  const def = buildRunDefinitions(h.runPorts).get("cluster-redeploy") as AnyRunDefinition;
  const step = def.steps({ serverId: MASTER_ID }).find((candidate: Step) => candidate.name === name);
  if (!step) throw new Error(`no step ${name} in cluster-redeploy`);
  return step;
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
