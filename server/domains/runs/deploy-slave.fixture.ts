import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { ANSIWISE_PIN_PATH } from "../inventory/ansiwise-pin.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { servers } from "../../db/schema/inventory.ts";
import { meta } from "../../db/schema/meta.ts";
import { ExecFailedError } from "../../adapters/ssh/port.ts";
import type { SshFactory, SshSession, SshTarget, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";
import { answerPlacementCommand, ScriptedReleases } from "./deploy-slave.placement.fixture.ts";
import type { StepCtx } from "../../executor/types.ts";
import { VERIFY_SLAVE_TIMEOUT_MS } from "./defs/deploy-slave.verify.ts";

// The deploy-slave test fixture (shared by deploy-slave.test.ts — plan/guards/failure modes —
// and redeploy.ansiwise.test.ts — the journeys over the REAL `ansiwise-rest serve`): a scripted
// two-host setup, the harness wiring, and the fake-timer helper that expires verify-slave's
// bounded retry window without ever waiting real minutes. The deployment programs themselves are
// NOT scripted here: every program act goes over a serve conversation (openConversation), which
// the non-serve tests leave refusing and the serve suites wire to the real binary.

export const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent",
    MANAGER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

export const SLAVE_ID = "srv_slave1";
export const MASTER_ID = "srv_master1";
export const PARAMS = { serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com" };
export const STEP_NAMES = [
  "attest-target", "slave-preflight", "prepare-checkouts", "run-deploy-slave-branch", "mark-slave",
  "place-ansiwise", "run-deploy-host", "refresh-checkout", "run-deploy-cluster", "run-deploy-platform-services",
  "rejoin", "read-membership", "enable-ansiwise-service", "create-mgmt", "gitops-handoff",
  "verify-slave", "register",
];
/** The redeploy slave arm: the same list minus the two birth acts (the branch cut with its
 *  checkout preparation, and the tailnet join with its membership read). */
export const REDEPLOY_STEP_NAMES = STEP_NAMES.filter(
  (n) => !["prepare-checkouts", "run-deploy-slave-branch", "rejoin", "read-membership"].includes(n),
);

// The public half of the key adopt installed — deploy-host's operator_public_key answer is read
// off the newest ssh_key credential's stored public line.
export const SLAVE_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5TESTKEY hostyour:s1";

// The tailnet-mint-join-key program's credential (the master's key file, read + removed by the
// rejoin step). A pre-auth key puts a machine of the holder's choosing on the private network, so
// the redaction assertions check it appears NOWHERE in the persisted run surface — and it is
// deliberately not shaped like anything the generic redact PATTERNS would catch on their own.
export const MINT_AUTHKEY = "dc-tailnet-preauth-SECRET-0003-abcdef";

// What the client reports once the join has gone through — the reading the run records on the
// server row right after it. The default for every scripted host, because a slave that reached the
// end of the join step IS on the network: the program fails the step otherwise.
export const TAILNET_ADDRESS = "100.71.4.9";
export const TAILNET_COORDINATOR = "https://tailnet.m1.example.com";
export const TAILNET_PROBE_JOINED = [
  "TAILNET client present",
  "TAILNET version 1.80.2",
  "TAILNET backend Running",
  `TAILNET address ${TAILNET_ADDRESS}`,
  `TAILNET coordinator ${TAILNET_COORDINATOR}`,
].join("\n");

// The credentials FILE emit-cluster-credentials leaves on the slave (its export step's contract:
// the stated address under `server`, the authority, the two bearer tokens). The two tokens are the
// crown jewels of the run — the redaction assertions check they appear NOWHERE in the persisted
// run surface. Pretty-printed like the real export's multi-line file.
export const EMIT_ARGOCD_TOKEN = "eyJhbGciOiJSUzI1NiJ9.argocd-manager-cluster-admin-SECRET-0001.sig";
export const EMIT_REVIEWER_TOKEN = "eyJhbGciOiJSUzI1NiJ9.vault-token-reviewer-SECRET-0002.sig";
export const EMIT_CREDS_JSON = JSON.stringify(
  { server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==", argocdToken: EMIT_ARGOCD_TOKEN, reviewerToken: EMIT_REVIEWER_TOKEN },
  null, 2,
);

// A healthy slave preflight: adopt's checks + the slave musts (80/443 free, snapd present).
export const HEALTHY_SLAVE_PREFLIGHT = [
  "CHECK os.ubuntu PASS ubuntu 26.04",
  "CHECK os.arch PASS x86_64",
  "CHECK cpu.count PASS 8 cores",
  "CHECK mem.total PASS 32 GiB",
  "CHECK disk.free PASS 900 GB free",
  "CHECK port.22 PASS sshd listening",
  "CHECK port.80 PASS port 80 free",
  "CHECK port.443 PASS port 443 free",
  "CHECK net.egress PASS github.com reachable",
  "CHECK snapd.present PASS snap present",
  "CHECK time.sync PASS clock synced",
  "PUBLIC_IP 203.0.113.7",
].join("\n");

// A scripted two-host setup (mutable, so a test can change behavior between runs). Sessions
// are keyed by target.host — the slave answers on its LAN address (10.1.1.11), the master on
// its FQDN — which lets the tests assert multi-target routing end to end. Every remote exec leg
// of the steps has a scripted answer; the PROGRAM conversations go through openConversation.
export interface HostsScript {
  machineId: string;
  dnsOut: string;
  preflightOut: string;
  vaultCode: string;
  vaultExit: number;
  // prepare-checkouts AND prepare-regeneration (master): LIVE_HEAD + WORK_HEAD lines. ONE field for
  // two steps, because the two scripts assert the same two facts under the same stdout contract —
  // WHICH branches they stand the checkouts on is decided in deploy-slave.remote.ts's two builders
  // and proven there, not by a second scripted answer repeating the same two words.
  checkoutsOut: string;
  checkoutsExit: number;
  refreshOut: string;     // refresh-checkout (slave): CHECKOUT_HEAD <old> <new>
  refreshExit: number;
  credsOut: string;       // create-mgmt (slave): what `cat` of the emitted credentials file answers
  credsExit: number;
  mintedKeyOut: string;   // the join (master): what `cat` of the mint program's key file answers
  mintedKeyExit: number;
  tailnetProbeOut: string; // read-membership (slave): what the joined client reports back
  appSyncOut: string;      // "Synced" ends gitops-handoff's wait immediately
  externalSecretsOut: string; // verify HARD gate 0 (master): `name|Ready|reason` rows in ns <name>
  diagOut: string;         // verify diagnostic bundle (master, runs only while a gate is failing)
  argoAppsOut: string;     // verify HARD gate 1 (master): `name|sync|health` rows in ns <name>
  secretStoresOut: string; // verify HARD gate 2 (slave): `ns/name|Ready` rows
  promOut: string;         // verify SOFT (master): PROM_CHECK data|empty|skipped
  certsOut: string;        // verify SOFT (slave): `ns/name|Ready` rows
  // ---- what the machine carries of the BOOTSTRAP (place-ansiwise). Every one of these is written
  // by a file transfer or by the serving binary's own install-service and read back by asking the
  // file — so a second run of a step measures what the first one left, and a double-run assertion is
  // about idempotence rather than about a value the test changed in between.
  /** What the service manager on the machine says about ansiwise.service: the two facts asked
   *  separately, because a unit that is enabled and dead and one that runs and is not enabled are two
   *  different machines and neither is the one a caller asked for. */
  serviceEnabled: boolean;
  serviceActive: boolean;
  /** What the unit STARTS, which is what `systemctl show -p ExecStart` answers: the absolute file its
   *  command names and the address on that command's `--listen`. install-service composes that
   *  command out of the binary it was run as and the options it was given, so both are written by the
   *  invocation the step made. undefined is a machine whose service manager knows no such unit. */
  serviceExecPath: string | undefined;
  serviceExecVersion: string | undefined;
  serviceExecListen: string | undefined;
  /** The version of the executable the RUNNING process is, which is NOT what the unit says while a
   *  unit was rewritten and the process kept going: install-service ends at `systemctl enable --now`,
   *  and `--now` starts a unit that is not active and does nothing to one that is. Only a restart
   *  moves this. Nothing the manager asks reads it — it is the machine the report is about, and a
   *  test asserts it off the machine directly. */
  serviceRunningVersion: string | undefined;
  /** The value at /etc/ansiwise/service-token, or undefined for a machine that has not been through
   *  the run that mints it — the machine the service placement has to refuse rather than enable a
   *  unit that cannot read its own credential. */
  serviceToken: string | undefined;
  /** Whether the service the install-service invocation enabled actually COMES UP. False is what a
   *  unit that installs cleanly and then fails to bind looks like: install-service exits zero and the
   *  service manager says the machine is not serving. */
  serviceStartsAfterInstall: boolean;
  /** One-shot exec fault injections: the FIRST exec whose command contains `match` REJECTS
   *  with Error(`message`) and the entry is consumed — e.g. a transport-level
   *  "(SSH) Channel open failure" mid-verify (the MaxSessions incident). */
  execFaults: { match: string; message: string }[];
  /** What answers an openChannel CONVERSATION (SshSession.openChannel) — a test that drives the
   *  ansiwise program steps hands back a Duplex carrying the REAL `ansiwise-rest serve` (a socket to
   *  its listener). The default refuses: the scripted hosts hold no conversations. */
  openConversation: (command: string) => Promise<Duplex>;
  /** Every exec and every conversation, with what the caller put on the command's STANDARD INPUT
   *  where it sent any. The credentials of a placement ride that input and nothing else — they may
   *  reach no file and no argument list — so a caller that composed them and then did not hand them
   *  through is invisible in `files` and in `command`, and this is where it shows. */
  log: { host: string; command: string; stdin?: Buffer }[];
  files: { host: string; path: string; content: string; mode: number }[];
}

export function scriptedHosts(overrides: Partial<HostsScript> = {}): HostsScript {
  return {
    machineId: "abc123def4567890abc123def4567890",
    dnsOut: "DNS_WILDCARD 198.51.100.10",
    preflightOut: HEALTHY_SLAVE_PREFLIGHT,
    vaultCode: "200",
    vaultExit: 0,
    checkoutsOut: "LIVE_HEAD aaa1111\nWORK_HEAD ccc3333",
    checkoutsExit: 0,
    refreshOut: "CHECKOUT_HEAD ddd4444 eee5555",
    refreshExit: 0,
    credsOut: EMIT_CREDS_JSON,
    credsExit: 0,
    mintedKeyOut: MINT_AUTHKEY,
    mintedKeyExit: 0,
    tailnetProbeOut: TAILNET_PROBE_JOINED,
    appSyncOut: "Synced",
    externalSecretsOut: "cluster-slave|True|SecretSynced\nrepo-hostyour-cloud|True|SecretSynced",
    diagOut: "==== verify-slave diagnostics (ns s1) ====",
    argoAppsOut: "root-applications|Synced|Healthy\nplatform-apps-prod|Synced|Healthy",
    secretStoresOut: "external-secrets/vault-backend|True\nredis/vault-backend|True",
    promOut: "PROM_CHECK data",
    certsOut: "redis/redis-tls|True",
    // A slave as deploy-slave meets it: adopted, and carrying neither executable yet. No surface of
    // its own, and the token file already there — enable-ansiwise-service stands AFTER
    // run-deploy-platform-services in the list, and that program's file_from_vault row is what writes it.
    serviceEnabled: false,
    serviceActive: false,
    serviceExecPath: undefined,
    serviceExecVersion: undefined,
    serviceExecListen: undefined,
    serviceRunningVersion: undefined,
    serviceToken: "scripted-service-token",
    serviceStartsAfterInstall: true,
    execFaults: [],
    openConversation: (command) => Promise.reject(new Error(`no conversation scripted for "${command}"`)),
    log: [],
    files: [],
    ...overrides,
  };
}

export function hostsFactory(f: HostsScript): SshFactory {
  return (target: SshTarget) => {
    const host = target.host;
    const execImpl = async (command: string, o: ExecOptions): Promise<ExecResult> => {
      f.log.push({ host, command, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
      const faultIdx = f.execFaults.findIndex((x) => command.includes(x.match));
      if (faultIdx !== -1) {
        const [fault] = f.execFaults.splice(faultIdx, 1);
        throw new Error(fault?.message ?? "injected exec fault");
      }
      const emit = (s: string): void => {
        for (const l of s.split("\n")) o.onStdout?.(l);
      };
      const done = (code = 0): ExecResult => ({ code, stdoutTail: "", stderrTail: "" });
      if (command === "cat /etc/machine-id") { emit(f.machineId); return done(); }
      if (command.includes("dc-dns-probe-")) { emit(f.dnsOut); return done(); }
      if (command.includes("dc-slave-preflight-")) { emit(f.preflightOut); return done(); }
      if (command.startsWith("curl") && command.includes("/v1/sys/health")) { emit(f.vaultCode); return done(f.vaultExit); }
      // ---- the bootstrap every program act stands on, and the machine's own resident surface. Every
      // answer is read off what the file transfer actually wrote (deploy-slave.placement.fixture.ts),
      // so a step that transferred nothing is answered by a machine carrying nothing.
      const placement = answerPlacementCommand(f, host, command);
      if (placement !== undefined) {
        emit(placement.out);
        return done(placement.code);
      }
      // ---- the git upkeep around the programs
      if (command.includes("dc-prepare-checkouts-") || command.includes("dc-prepare-regeneration-")) { emit(f.checkoutsOut); return done(f.checkoutsExit); }
      if (command.includes("dc-refresh-checkout-")) { emit(f.refreshOut); return done(f.refreshExit); }
      // ---- the two credential files the manager reads over the session and removes
      if (command.startsWith("cat ") && command.includes("ansiwise-cluster-credentials")) { emit(f.credsOut); return done(f.credsExit); }
      if (command.includes("ansiwise-cluster-credentials")) return done();
      if (command.startsWith("cat ") && command.includes("ansiwise-tailnet-join-key-")) { emit(f.mintedKeyOut); return done(f.mintedKeyExit); }
      if (command.includes("ansiwise-tailnet-join-key-")) return done();
      if (command.includes("dc-tailnet-probe-")) { emit(f.tailnetProbeOut); return done(); }
      // ---- gitops-handoff
      if (command.includes("get application ")) { emit(f.appSyncOut); return done(); }
      // ---- verify-slave (three HARD gates + diagnostics + two SOFT checks)
      if (command.includes("annotate externalsecrets.external-secrets.io")) return done();
      if (command.includes("get externalsecrets.external-secrets.io")) { emit(f.externalSecretsOut); return done(); }
      if (command.includes("dc-slave-diag-")) { emit(f.diagOut); return done(); }
      if (command.includes("applications.argoproj.io")) { emit(f.argoAppsOut); return done(); }
      if (command.includes("secretstores.external-secrets.io")) { emit(f.secretStoresOut); return done(); }
      if (command.includes("dc-prom-check-")) { emit(f.promOut); return done(); }
      if (command.includes("certificates.cert-manager.io")) { emit(f.certsOut); return done(); }
      // ---- cleanups
      if (command.includes("snap remove --purge microk8s")) return done();
      return done();
    };
    const session: SshSession = {
      hostKeyFingerprint: () => "SHA256:fixture",
      isClosed: () => false, // a fake transport never dies under a step
      close: () => undefined,
      putFile: async (path, content, mode) => {
        f.files.push({ host, path, content: content.toString("utf8"), mode });
      },
      forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
      openChannel: async (command) => {
        f.log.push({ host, command });
        const stream = await f.openConversation(command);
        return { stream, close: () => stream.destroy() };
      },
      exec: execImpl,
      mustExec: async (command, o) => {
        const r = await execImpl(command, o);
        if (r.code !== 0) throw new ExecFailedError(r.code, r.stderrTail, command);
        return r;
      },
    };
    return Promise.resolve(session);
  };
}

export interface Harness {
  db: DbHandle;
  executor: Executor;
  store: CredentialStore;
  hosts: HostsScript;
  /** The platform repo the run reads the master's map from and writes the slave's onto (mark-slave). */
  platformRepo: FakePlatformRepo;
  /** The release surface the bootstrap reads both executables off — every address it was asked for,
   *  and where a test puts something other than the asset an address names. */
  releases: ScriptedReleases;
}

/** A slave's cluster map as mark-slave leaves it on the books branch — identity plus the slave
 *  part that makes the master's slaves ApplicationSet able to dial it. Seeded by tests that start
 *  from a slave that ALREADY IS one (redeploy, release's slave arm); a fresh deploy writes its own. */
export const SLAVE_MARKING_YAML = [
  `stage: ${PARAMS.stage}`,
  "role: slave",
  "booksCluster: m1.example.com",
  "",
  "global:",
  `  domain: ${PARAMS.domain}`,
  "  buildPlane: m1.example.com",
  "  master: m1.example.com",
  "  apiHost: 100.64.0.11",
  "  apiPort: 16443",
].join("\n") + "\n";

/** The MASTER's own cluster map: written when the master installed itself. mark-slave reads it to
 *  compose the SLAVE's map — a slave belongs to the same installation, so its build plane, unit
 *  apex, platform domain, alert recipients and catalog repository are the master's. */
export const MASTER_MARKING_YAML = [
  "stage: prod",
  "role: master",
  "booksCluster: m1.example.com",
  "",
  "global:",
  "  domain: m1.example.com",
  "  buildPlane: m1.example.com",
  "  unitApex: example.com",
  "  platformDomain: example.com",
  "  alertRecipients: ops@example.com",
  "  catalogUrl: https://github.com/acme/acme-catalog.git",
].join("\n") + "\n";

/** The version platform/versions.yaml pins for the binary, and the file that carries it — the ONE
 *  source place-ansiwise reads. Every harness seeds it on the trunk, because without it the step
 *  refuses and no run of any cluster run kind gets past its machine layer. */
export const ANSIWISE_PIN = "0.4.2";
export const VERSIONS_YAML = [
  "cliTools:",
  "  ansiwise:",
  `    version: "${ANSIWISE_PIN}"`,
  "  yq:",
  '    version: "v4.53.3"',
].join("\n") + "\n";

/** Where the scripted installation fetches that version from. `<version>` is what the step fills in,
 *  so the address in the placing script names the pin above and nothing else. */
export const ANSIWISE_DOWNLOAD_URL = "https://downloads.example.invalid/ansiwise/<version>/<name>-<version>-linux-x64";

/** WHICH repository the scripted installation reads its programs from — a second repository beside
 *  the platform one, which is the whole point: the platform checkout is the material the programs
 *  act on and carries no ansiwise/ tree. */
export const ANSIWISE_CATALOG_URL = "https://github.com/acme/acme-deploy.git";

const handles: DbHandle[] = [];
const dirs: string[] = [];

/** Call from afterEach: closes every harness db + removes its temp dir. */
export function disposeHarnesses(): void {
  for (const h of handles.splice(0)) h.sqlite.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

// FK-safe seeding (clusters.server_id → servers.id): servers + their ssh keys first.
// keystore: "keyfile" opens the crypto gate for tests that need a SECOND plan of the same slave
// (under plaintext the gate counts the first run's leftover planned row as a live slave).
export async function makeHarness(opts: { hosts?: HostsScript; keystore?: string; master?: boolean; marking?: string | false; ansiwiseServeCommand?: string; versionsYaml?: string } = {}): Promise<Harness> {
  const hosts = opts.hosts ?? scriptedHosts();
  const dir = mkdtempSync(join(tmpdir(), "ctrl-ds-"));
  dirs.push(dir);
  const db = openDb(join(dir, "c.db"));
  handles.push(db);
  const store = new CredentialStore({ db: db.db, logger });
  const platformRepo = new FakePlatformRepo();
  if (opts.marking !== false) platformRepo.seed(platformRepo.booksBranch, clusterMarkingPath(PARAMS.domain), opts.marking ?? SLAVE_MARKING_YAML);
  // The master's map rides along UNCONDITIONALLY (even when the slave's is scripted absent): a
  // master that installed itself carries one by construction, and mark-slave composes the slave's
  // map from it. A test about a master map without a field seeds over this.
  platformRepo.seed(platformRepo.booksBranch, clusterMarkingPath("m1.example.com"), MASTER_MARKING_YAML);
  // The pin both executables are placed at, on the trunk where the bootstrap reads it. A test about a
  // pin that is missing or malformed seeds over this.
  platformRepo.seed(PRODUCT_BRANCH, ANSIWISE_PIN_PATH, opts.versionsYaml ?? VERSIONS_YAML);
  const releases = new ScriptedReleases();
  const executor = new Executor({
    db: db.db, creds: store, bus: new RunEventBus(), logger,
    runDefinitions: buildRunDefinitions({
      db: db.db, platformRepo,
      ansiwiseDownloadUrl: ANSIWISE_DOWNLOAD_URL,
      releaseDownloads: releases,
      ...(opts.ansiwiseServeCommand !== undefined ? { ansiwiseServeCommand: opts.ansiwiseServeCommand } : {}),
    }),
    sshFactory: hostsFactory(hosts), actor: () => "op_system",
  });
  if (opts.keystore) {
    db.db.insert(meta).values({ key: "keystore.mode", value: opts.keystore })
      .onConflictDoUpdate({ target: meta.key, set: { value: opts.keystore } }).run();
  }
  db.db.insert(servers).values({
    // Three addresses, and the tests lean on all three being different: SSH goes to lanHost, the
    // master's in-cluster components dial tailnetHost, and host is the public fallback.
    id: SLAVE_ID, name: "s1", host: "s1.example.com", lanHost: "10.1.1.11", tailnetHost: "100.64.0.11",
    sshPort: 22, sshUser: "ubuntu", role: "slave", status: "ready",
  }).run();
  // publicKey rides the credential the way adopt seals it — deploy-host's operator_public_key
  // answer is read off exactly this line.
  await store.seal({ kind: "ssh_key", label: "slave key", plaintext: Buffer.from("fake-slave-key"), fingerprint: "SHA256:slave", serverId: SLAVE_ID, publicKey: SLAVE_PUBLIC_KEY });
  if (opts.master !== false) {
    db.db.insert(servers).values({
      id: MASTER_ID, name: "m1", host: "m1.example.com",
      sshPort: 22, sshUser: "m1", role: "master", status: "healthy",
      // The master requires a pinned host key (context.ts getSsh hard-fails an unpinned
      // master); the fake session reports "SHA256:fixture" as its host key.
      preflightJson: { hostKey: "SHA256:fixture" },
    }).run();
    await store.seal({ kind: "ssh_key", label: "master key", plaintext: Buffer.from("fake-master-key"), fingerprint: "SHA256:master", serverId: MASTER_ID });
  }
  return { db, executor, store, hosts, platformRepo, releases };
}

export function stepColumn(db: DbHandle, runId: string, name: string, column: "error" | "checkpoint_json"): string | null {
  const row = db.sqlite
    .prepare(`SELECT ${column} AS v FROM steps WHERE run_id = ? AND name = ?`)
    .get(runId, name) as { v: string | null } | undefined;
  return row?.v ?? null;
}

/** Under FAKE timers (vi.useFakeTimers must be active): yield microtasks until the run
 *  schedules its next sleep (the scripted hosts are pure microtasks, so the only timers are
 *  the bounded waits' poll sleeps). */
export async function drainToNextTimer(): Promise<void> {
  for (let i = 0; vi.getTimerCount() === 0; i++) {
    if (i > 50_000) throw new Error("the run never scheduled a retry sleep");
    await Promise.resolve();
  }
}

/** Under FAKE timers: drain to the verify-slave retry loop's first sleep, then advance the
 *  faked clock past the bounded window so the HARD gate expires deterministically — a verify
 *  drill runs without a single real wait. */
export async function drainToVerifyDeadline(): Promise<void> {
  await drainToNextTimer();
  await vi.advanceTimersByTimeAsync(VERIFY_SLAVE_TIMEOUT_MS + 60_000);
}

/** A minimal StepCtx for re-executing a LOCAL-ONLY step directly (register in the
 *  overwrite-idempotence test — exactly what a crash-resumed executor does). */
export function bareStepCtx(db: DbHandle, store: CredentialStore): StepCtx {
  return {
    runId: "run_bare",
    stepName: "register",
    db: db.db,
    creds: store,
    params: { ...PARAMS, tier: "rehearsal" },
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal,
    logger,
    ssh: () => Promise.reject(new Error("no ssh in bareStepCtx")),
    openPasswordSession: () => Promise.reject(new Error("no ssh in bareStepCtx")),
    closePasswordSession: () => undefined,
    attest: () => Promise.reject(new Error("no attest in bareStepCtx")),
    log: () => undefined,
    checkpoint: () => undefined,
    readCheckpoint: () => undefined,
    registerCleanup: () => undefined,
  };
}

/** A StepCtx wired to the scripted hosts — for driving ONE step directly (the verify gates under
 *  fake timers, mark-slave's map write) without the executor around it. ssh() routes exactly like
 *  the real context: no id ⇒ the slave on its LAN address, the master's id ⇒ its FQDN. */
export function hostedStepCtx(h: Harness, over: Partial<Pick<StepCtx, "secrets" | "log" | "checkpoint" | "readCheckpoint" | "registerCleanup">> = {}): StepCtx {
  const factory = hostsFactory(h.hosts);
  const session = (host: string): ReturnType<SshFactory> =>
    factory({ host, port: 22, username: "x", auth: { kind: "key", privateKey: Buffer.from("k") } });
  return {
    ...bareStepCtx(h.db, h.store),
    ssh: (serverId?: string) => session(serverId === MASTER_ID ? "m1.example.com" : "10.1.1.11"),
    ...over,
  };
}
