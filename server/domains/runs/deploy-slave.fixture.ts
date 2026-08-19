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
import { buildRegistry } from "./registry.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { servers } from "../../db/schema/inventory.ts";
import { meta } from "../../db/schema/meta.ts";
import { ExecFailedError } from "../../adapters/ssh/port.ts";
import type { SshFactory, SshSession, SshTarget, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import { VERIFY_SLAVE_TIMEOUT_MS } from "./defs/deploy-slave.verify.ts";

// The deploy-slave test fixture (shared by deploy-slave.test.ts — plan/guards/failure modes —
// and deploy-slave.journey.test.ts — the green paths + lifecycle): a scripted two-host setup,
// the harness wiring, and the fake-timer helper that expires verify-slave's bounded retry
// window without ever waiting real minutes.

export const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent",
    CONTROLLER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

export const SLAVE_ID = "srv_slave1";
export const MASTER_ID = "srv_master1";
export const PARAMS = { serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com" };
export const STEP_NAMES = [
  "attest-target", "slave-preflight", "prepare-branch", "mint-join-key", "install-microk8s",
  "create-mgmt", "gitops-handoff", "verify-slave", "register",
];

// What the platform Vault answers when the run auto-sources GITOPS_REPO_PAT on the master
// (fetchRepoPatScript's stdout contract: the PAT and NOTHING else) — the run's ONLY PAT
// source (the manual override run secret was removed). Deliberately NOT shaped like a real
// GitHub token (ghp_/github_pat_): the generic redact PATTERNS must not be what hides it —
// the negative assertions must prove the fetch path's redactor registration.
export const VAULT_PAT = "dc-vault-sourced-readonly-pat-9876543210";

// The --tailnet-mint-join-key blob fixture (the installer's join-credential stdout contract).
// A pre-auth key puts a machine of the holder's choosing on the private network, so the
// redaction test asserts it appears NOWHERE in the persisted run surface — same class as the
// two management tokens below, and deliberately not shaped like anything the generic redact
// PATTERNS would catch on their own.
export const MINT_AUTHKEY = "dc-tailnet-preauth-SECRET-0003-abcdef";
export const MINT_KEY_JSON = JSON.stringify({ authkey: MINT_AUTHKEY }, null, 2);

// What the client reports once the join has gone through — the reading the run records on the
// server row right after it. The default for every scripted host, because a slave that reached the
// end of the join step IS on the network: the installer fails the step otherwise.
export const TAILNET_ADDRESS = "100.71.4.9";
export const TAILNET_COORDINATOR = "https://tailnet.m1.example.com";
export const TAILNET_PROBE_JOINED = [
  "TAILNET client present",
  "TAILNET version 1.80.2",
  "TAILNET backend Running",
  `TAILNET address ${TAILNET_ADDRESS}`,
  `TAILNET coordinator ${TAILNET_COORDINATOR}`,
].join("\n");

// The --emit-mgmt-credentials blob fixture (the installer's slave-management stdout contract).
// The two tokens are the crown jewels of the run — the redaction test asserts they appear
// NOWHERE in the persisted run surface. Pretty-printed like jq -n's real multi-line output.
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
// its FQDN — which lets the tests assert multi-target routing end to end. Every remote
// leg of steps 0-7 (and the three cleanups) has a scripted answer; putFile deliveries (the
// GIT_ASKPASS helper, the creds blob, uploaded scripts) are recorded for inspection.
export interface HostsScript {
  machineId: string;
  dnsOut: string;
  preflightOut: string;
  vaultCode: string;
  vaultExit: number;
  prepareOut: string;
  prepareExit: number;
  microk8sProbeExit: number; // step 3 probe: non-zero = phase not complete yet
  cloneTestExit: number;     // standalone clone check: non-zero = ~/hostyour-cloud missing
  cloneExit: number;
  repoPatOut: string;        // step 3 Vault auto-source (master): the PAT (sole stdout)
  repoPatExit: number;
  repoUrlOut: string;
  setupExit: number;
  masterRefreshOut: string;  // mint-join-key, first leg (master): CHECKOUT_HEAD <old> <new>
  masterRefreshExit: number;
  mintOut: string;           // the join-credential blob (master, sole stdout) — asked twice
  mintExit: number;
  tailnetJoinExit: number;   // install-microk8s tail (slave): --tailnet-join
  tailnetProbeOut: string;   // install-microk8s tail (slave): what the joined client reports back
  mintedKeyOut: string;      // tailnet-rejoin (master): what `cat` of the mint program's key file answers
  mintedKeyExit: number;
  emitOut: string;
  emitExit: number;
  slaveAddExit: number;
  appSyncOut: string;        // "Synced" ends step 5's wait immediately
  externalSecretsOut: string; // step 6 HARD gate 0 (master): `name|Ready|reason` rows in ns <name>
  diagOut: string;           // step 6 diagnostic bundle (master, runs only while a gate is failing)
  argoAppsOut: string;       // step 6 HARD gate 1 (master): `name|sync|health` rows in ns <name>
  secretStoresOut: string;   // step 6 HARD gate 2 (slave): `ns/name|Ready` rows
  promOut: string;           // step 6 SOFT (master): PROM_CHECK data|empty|skipped
  certsOut: string;          // step 6 SOFT (slave): `ns/name|Ready` rows
  /** One-shot exec fault injections: the FIRST exec whose command contains `match` REJECTS
   *  with Error(`message`) and the entry is consumed — e.g. a transport-level
   *  "(SSH) Channel open failure" mid-verify (the MaxSessions incident). */
  execFaults: { match: string; message: string }[];
  /** What answers an openChannel CONVERSATION (SshSession.openChannel) — a test that drives the
   *  ansiwise program steps hands back a Duplex carrying the REAL `ansiwise serve` (a socket to
   *  its listener). The default refuses: the scripted hosts hold no conversations. */
  openConversation: (command: string) => Promise<Duplex>;
  log: { host: string; command: string }[];
  files: { host: string; path: string; content: string }[];
}

export function scriptedHosts(overrides: Partial<HostsScript> = {}): HostsScript {
  return {
    machineId: "abc123def4567890abc123def4567890",
    dnsOut: "DNS_WILDCARD 198.51.100.10",
    preflightOut: HEALTHY_SLAVE_PREFLIGHT,
    vaultCode: "200",
    vaultExit: 0,
    prepareOut: "SECRETS_PATH /home/m1/slave-work/s1.example.com/base/secrets/secrets.prod",
    prepareExit: 0,
    microk8sProbeExit: 1,
    cloneTestExit: 1,
    cloneExit: 0,
    repoPatOut: VAULT_PAT,
    repoPatExit: 0,
    repoUrlOut: "REPO_URL https://github.com/simetrixch/hostyour-cloud.git",
    setupExit: 0,
    masterRefreshOut: "CHECKOUT_HEAD aaa1111 bbb2222",
    masterRefreshExit: 0,
    mintOut: MINT_KEY_JSON,
    mintExit: 0,
    tailnetJoinExit: 0,
    tailnetProbeOut: TAILNET_PROBE_JOINED,
    mintedKeyOut: MINT_AUTHKEY,
    mintedKeyExit: 0,
    emitOut: EMIT_CREDS_JSON,
    emitExit: 0,
    slaveAddExit: 0,
    appSyncOut: "Synced",
    externalSecretsOut: "cluster-slave|True|SecretSynced\nrepo-hostyour-cloud|True|SecretSynced",
    diagOut: "==== verify-slave diagnostics (ns s1) ====",
    argoAppsOut: "root-applications|Synced|Healthy\nplatform-apps-prod|Synced|Healthy",
    secretStoresOut: "external-secrets/vault-backend|True\nredis/vault-backend|True",
    promOut: "PROM_CHECK data",
    certsOut: "redis/redis-tls|True",
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
      f.log.push({ host, command });
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
      if (command.includes("dc-prepare-branch-")) { emit(f.prepareOut); return done(f.prepareExit); }
      // ---- install-microk8s (the slave's own legs)
      if (command.includes("microk8s status --wait-ready")) return done(f.microk8sProbeExit);
      if (command === 'test -d "$HOME/hostyour-cloud/.git"') return done(f.cloneTestExit);
      if (command.includes("dc-fetch-repo-pat-")) { emit(f.repoPatOut); return done(f.repoPatExit); }
      if (command.includes("dc-repo-url-")) { emit(f.repoUrlOut); return done(); }
      if (command.includes("dc-clone-slave-")) return done(f.cloneExit);
      if (command.includes("kubectl wait --for=condition=Ready node")) return done();
      if (command.includes("clusterissuers")) return done();
      // ---- the master's checkout refresh (mint-join-key here, its own step in cluster-release)
      if (command.includes("dc-refresh-checkout-")) { emit(f.masterRefreshOut); return done(f.masterRefreshExit); }
      // ---- the flagged setup.sh calls, ALL of them before the plain one below.
      // The mint answers for both askers: mint-join-key and install-microk8s's join leg.
      if (command.includes("--tailnet-mint-join-key")) { emit(f.mintOut); return done(f.mintExit); }
      if (command.includes("--tailnet-join")) return done(f.tailnetJoinExit);
      // The mint PROGRAM's key file on the master (tailnet.kit.ts readMintedKey): the cat answers
      // with the credential, the rm that follows matches the same marker and answers silently.
      if (command.startsWith("cat ") && command.includes("ansiwise-tailnet-join-key-")) { emit(f.mintedKeyOut); return done(f.mintedKeyExit); }
      if (command.includes("ansiwise-tailnet-join-key-")) return done();
      if (command.includes("dc-tailnet-probe-")) { emit(f.tailnetProbeOut); return done(); }
      if (command.includes("--emit-mgmt-credentials")) { emit(f.emitOut); return done(f.emitExit); }
      if (command.includes("--slave-add")) return done(f.slaveAddExit);
      if (command.includes("--slave-remove")) return done();
      if (command.includes("./setup.sh")) return done(f.setupExit);
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
      putFile: async (path, content) => {
        f.files.push({ host, path, content: content.toString("utf8") });
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
  /** The platform repo deploy-slave marks the slave reachable in. Pre-seeded with the slave's map as
   *  install.sh leaves it (fqdn/stage/role/build-plane, no slave part yet), so a test can assert what
   *  the run committed on top of it. */
  platformRepo: FakePlatformRepo;
}

/** The slave's cluster map exactly as install.sh leaves it on master during prepare-branch —
 *  identity plus the slave part that makes the master's slaves ApplicationSet able to dial it.
 *  `build-plane` names the master: s1's images are built centrally on the master. The Controller
 *  never writes this file; it reads it back and drops the slave part again on an abort. */
export const SLAVE_MARKING_YAML = [
  `fqdn: ${PARAMS.domain}`,
  `stage: ${PARAMS.stage}`,
  "role: slave",
  "master: m1.example.com",
  "build-plane: m1.example.com",
  "apiHost: 100.64.0.11",
  "apiPort: 16443",
].join("\n") + "\n";

/** The MASTER's own cluster map: install.sh wrote it when the master installed itself.
 *  prepare-branch reads it to compose the SLAVE's map — a slave belongs to the same installation,
 *  so its build plane, unit apex, platform domain, alert recipients and catalog repository are the
 *  master's. `catalog-repo` is the one that must be present: set-role.sh runs on the slave's own
 *  branch and dies outright without it, so a slave attached past that point would fail there with
 *  its branch already pushed. */
export const MASTER_MARKING_YAML = [
  "fqdn: m1.example.com",
  "stage: prod",
  "role: master",
  "build-plane: m1.example.com",
  "unit-apex: example.com",
  "platform-domain: example.com",
  "alert-recipients: ops@example.com",
  "catalog-repo: acme/acme-catalog",
].join("\n") + "\n";

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
export async function makeHarness(opts: { hosts?: HostsScript; keystore?: string; master?: boolean; marking?: string | false; ansiwiseServeCommand?: string } = {}): Promise<Harness> {
  const hosts = opts.hosts ?? scriptedHosts();
  const dir = mkdtempSync(join(tmpdir(), "ctrl-ds-"));
  dirs.push(dir);
  const db = openDb(join(dir, "c.db"));
  handles.push(db);
  const store = new CredentialStore({ db: db.db, logger });
  const platformRepo = new FakePlatformRepo();
  if (opts.marking !== false) platformRepo.seed(platformRepo.booksBranch, clusterMarkingPath(PARAMS.domain), opts.marking ?? SLAVE_MARKING_YAML);
  // The master's map rides along UNCONDITIONALLY (even when the slave's is scripted absent): a
  // master that installed itself carries one by construction, and prepare-branch reads post-url
  // off it. A test about a master map without the field seeds over this.
  platformRepo.seed(platformRepo.booksBranch, clusterMarkingPath("m1.example.com"), MASTER_MARKING_YAML);
  const executor = new Executor({
    db: db.db, creds: store, bus: new RunEventBus(), logger,
    registry: buildRegistry({ db: db.db, platformRepo, ...(opts.ansiwiseServeCommand !== undefined ? { ansiwiseServeCommand: opts.ansiwiseServeCommand } : {}) }),
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
  await store.seal({ kind: "ssh_key", label: "slave key", plaintext: Buffer.from("fake-slave-key"), fingerprint: "SHA256:slave", serverId: SLAVE_ID });
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
  return { db, executor, store, hosts, platformRepo };
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
 *  faked clock past the bounded window so the HARD gate expires deterministically — the
 *  whole 0→6 journey drains without a single real wait. */
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
