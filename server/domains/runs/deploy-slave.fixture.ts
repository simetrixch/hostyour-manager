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
import { buildRunDefinitions, type RunDefinitionsPorts } from "./run-definitions.ts";
import type { AnyRunDefinition, Step } from "../../executor/types.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { ANSIWISE_PIN_PATH } from "../inventory/ansiwise-pin.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { meta } from "../../db/schema/meta.ts";
import { AuthFailedError, ExecFailedError } from "../../adapters/ssh/port.ts";
import type { SshFactory, SshSession, SshTarget, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";
import { answerPlacementCommand, ScriptedReleases } from "./deploy-slave.placement.fixture.ts";
import { FakeMetricsQuery } from "../../adapters/metrics/testing/fake.ts";
import type { FakeMasterArgoReader, FakeClusterReader, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
// What the master's ArgoCD holds, beside the harness rather than inside it — a suite that drives a
// gate reads what stands there off this, and the harness only wires it in.
export { MASTER_ARGO_NS, SLAVE_ARGO_NS, argoRow, externalSecretRow } from "./deploy-slave.kube.fixture.ts";
import { masterKubeFakes } from "./deploy-slave.kube.fixture.ts";
import type { StepCtx } from "../../executor/types.ts";
import { VERIFY_SLAVE_TIMEOUT_MS } from "./defs/deploy-slave.verify.ts";
import { HOST_ADDRESS_COMMAND } from "./defs/deploy-slave.remote.ts";
// The maps this harness seeds, beside the harness rather than inside it — a fixture map is read
// by suites that never touch a harness, and it is the one thing here that states a real file.
export { SLAVE_MARKING_YAML, MASTER_MARKING_YAML } from "./cluster-maps.fixture.ts";
import { SLAVE_MARKING_YAML, MASTER_MARKING_YAML, SLAVE_FQDN, MASTER_FQDN, FIXTURE_STAGE } from "./cluster-maps.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";
// The first-contact half of the scripted machine — the state it holds, the answers it gives, and
// the password it answers a root command for — beside the harness for the reason the placement half
// is: it is one machine, and a caller that drives the composed run reads what first contact left off
// the same object.
export { IMAGE_KEY_LINE, ELEVATION_PASSWORD } from "./deploy-slave.first-contact.fixture.ts";
import { answerFirstContactCommand, answerRootCommand, firstContactDefaults, takesManagerKey, ELEVATION_PASSWORD, type FirstContactScript } from "./deploy-slave.first-contact.fixture.ts";

// The deploy-slave test fixture (shared by deploy-slave.test.ts — plan/guards/failure modes —
// and deploy-slave.ansiwise.suite.ts — the journeys over the REAL `ansiwise-rest serve`): a scripted
// two-host setup, the harness wiring, and the fake-timer helper that expires verify-slave's
// bounded retry window without ever waiting real minutes. The deployment programs themselves are
// NOT scripted here: every program act goes over a serve conversation (openConversation), which
// the non-serve tests leave refusing and the serve suites wire to the real binary.

export const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    MANAGER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

export const SLAVE_ID = "srv_slave1";
export const MASTER_ID = "srv_master1";
export const PARAMS = { serverId: SLAVE_ID, stage: FIXTURE_STAGE, domain: SLAVE_FQDN };
/** The deployment programs this manager clones a machine's catalogue from, and the auth of its own
 *  pull document. The pull auth is a secret: every case that reads the run's surface asserts it is
 *  nowhere in it, which is only a statement if it is a recognisable string. The origin is not one —
 *  the repository it names is public. */
export const CATALOGUE_ORIGIN_URL = "https://github.com/acme/acme-deploy.git";
export const PULL_AUTH = "cHVsbGVyOnB1bGwtcGFzc3dvcmQ=";

/** The document the manager's own mounted pull configuration is narrowed to for ONE registry
 *  address — what `pullConfiguration` below answers, spelled once so a test asserting where the
 *  value may and may not stand compares the same bytes the harness composes. */
export function pullDocumentFor(registryHost: string): string {
  return Buffer.from(JSON.stringify({ auths: { [registryHost]: { auth: PULL_AUTH } } }), "utf8").toString("base64");
}

/** The address every fixture cluster map names as the registry this installation pulls through
 *  (cluster-maps.fixture.ts `endpoints.registry.host`, on the master's map and on the slave's). */
export const FIXTURE_REGISTRY_HOST = "zot.m1.example.com";

/** The whole of what deploying a slave is, in order: the attest, then the six FIRST-CONTACT steps,
 *  then the preflight, then the two doors the run shuts, and then the machine layer over the
 *  deployment programs. This run kind takes a machine from wherever it stands — a box this manager
 *  has never logged in to included — so establishing the key it reaches the machine with is the head
 *  of this list rather than a run kind of its own (defs/deploy-slave.ts).
 *
 *  ORDER IS BEHAVIOUR HERE, not layout, and two rules decide it — each one asserted by its own test
 *  in deploy-slave.test.ts rather than only by this list's shape:
 *    - `remove-sudoers` before `disable-password-login`, because the step that takes the standing
 *      passwordless-root grant away may only run where every root command after it is raised with
 *      the run's own password;
 *    - `verify-key-login` before both irreversible acts, because shutting the daemon's password
 *      door and destroying the sealed bootstrap password each remove a way in, and the way in that
 *      stays has to be proven first. */
export const STEP_NAMES = [
  "attest-target",
  "prove-elevation", "generate-key", "install-key", "verify-key-login", "enable-ntp", "remove-sudoers",
  "slave-preflight", "disable-password-login", "purge-bootstrap-password",
  "mark-slave",
  "place-ansiwise", "run-deploy-host", "run-deploy-cluster", "run-deploy-platform-services",
  "rejoin", "read-membership", "declare-tailnet-address", "create-mgmt",
  "gitops-handoff", "verify-slave", "register",
];
/** The redeploy slave arm: the SAME list, with the outright join in the MEASURED form that reads the
 *  machine's membership and puts a machine holding none back on the network (`join-if-absent`).
 *
 *  NOTHING IS SUBTRACTED ANY MORE, and that is what dropping the slave branch left behind: the one
 *  birth act this list used to hold was the branch cut with its checkout preparation, and a pure
 *  slave has no branch to cut. Neither first contact nor the membership read was ever subtracted
 *  either, because neither is a birth act: every first-contact step measures before it acts, so on a
 *  live slave they read a key that is installed, a login that works and doors that are already shut,
 *  and each says so; and a redeploy owes the card a reading of the membership as much as a
 *  deployment does. What a redeploy holds back is their compensations, which
 *  redeploy.ansiwise.test.ts asserts off the run's own checkpoints. */
export const REDEPLOY_STEP_NAMES = STEP_NAMES.map((n) => n === "rejoin" ? "join-if-absent" : n);

// The public half of the key `install-key` puts on the machine — deploy-host's operator_public_key answer is read
// off the newest ssh_key credential's stored public line.
//
// THE BLOB IS THE LENGTH A REAL ONE IS, because the authorized-keys reading parses what the machine
// hands back and a shorter blob is not a key line at all to it (shared/operator-keys.ts BLOB_RE) —
// so a stand-in that looked like one here would be counted as a line this manager could not read
// rather than as its own installed key, and the reading after install-key would say the opposite of
// what happened.
export const SLAVE_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISlaveTestKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAA hostyour:s1";

/** The same for the master, whose own machine layer the redeploy arm now runs too: its deploy-host
 *  is owed the public half of the key this manager reaches it with, exactly as a slave's is. */
export const MASTER_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMasterTestKeyAAAAAAAAAAAAAAAAAAAAAAAAAAA hostyour:m1";

/** The platform repository as owner/name, the way this installation names it. */
export const PLATFORM_ORIGIN = "acme/platform";

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

// A healthy slave preflight: the catalogue's checks + the slave musts (80/443 free, snapd present).
export const HEALTHY_SLAVE_PREFLIGHT = [
  "CHECK os.arch PASS x86_64",
  "CHECK port.22 PASS sshd listening",
  // The ingress ports ship their two readings and are judged in portCheck: nothing listening and
  // every connection refused is the bare machine a slave may be deployed onto.
  "PORT 80 listener=no connect=no",
  "PORT 443 listener=no connect=no",
  "CHECK net.egress PASS github.com reachable",
  "CHECK snapd.present PASS snap present",
  "CHECK time.sync PASS clock synced",
  "PUBLIC_IP 203.0.113.7",
].join("\n");

// A scripted two-host setup (mutable, so a test can change behavior between runs). Sessions
// are keyed by target.host — the slave answers on its LAN address (10.1.1.11), the master on
// its FQDN — which lets the tests assert multi-target routing end to end. Every remote exec leg
// of the steps has a scripted answer; the PROGRAM conversations go through openConversation.
//
// The FIRST-CONTACT half of the machine is declared and answered beside it
// (deploy-slave.first-contact.fixture.ts): what the machine holds there is read and written by the
// acts this manager sends, so its state and its answers stay in one place.
export interface HostsScript extends FirstContactScript {
  machineId: string;
  dnsOut: string;
  preflightOut: string;
  vaultCode: string;
  vaultExit: number;
  credsOut: string;       // create-mgmt (slave): what `cat` of the emitted credentials file answers
  credsExit: number;
  mintedKeyOut: string;   // the join (master): what `cat` of the mint program's key file answers
  mintedKeyExit: number;
  /** What the client on this machine reports about its own membership, to every probe of a run. A
   *  LIST is a machine the run itself changes: one reading is handed out per probe and the last one
   *  stands for every probe after it — which is what a machine that comes in off the network and is
   *  joined answers, and the only way its two readings can differ, since the join happens inside a
   *  program run the scripted host never sees. */
  tailnetProbeOut: string | string[];
  /** What the probe EXITS with, absent (0) on every machine that answers it at all — the one script
   *  of this manager whose every branch exits 0 and prints what it found, so a non-zero here is a
   *  machine that never took the reading rather than one that reports being off the network. */
  tailnetProbeExit?: number;
  /** WHAT `headscale nodes list -o json` PRINTS ON THE MASTER — declare-tailnet-address reads the
   *  address it puts on the row out of this, and out of nothing on the slave. The default lists the
   *  fixture slave under its own name with the address the slave row carries, so every suite that
   *  drives the whole list keeps the address it already leaned on. */
  coordinatorNodesOut: string;
  coordinatorNodesExit: number;
  /** WHAT `headscale nodes delete` ANSWERS ON THE MASTER. A join clears what an earlier life of the
   *  machine left at the coordinator before it mints, so this is the second thing that invocation is
   *  asked. Non-zero is the case where the coordinator will not let go — the run has to stop there,
   *  because joining anyway puts a second node under one name. */
  coordinatorDeleteExit: number;
  diagOut: string;         // verify diagnostic bundle (master, runs only while a gate is failing)
  secretStoresOut: string; // verify HARD gate 2 (slave): `ns/name|Ready` rows
  certsOut: string;        // verify SOFT (slave): `ns/name|Ready` rows
  /** WHAT `ip -4 -o addr show scope global` PRINTS ON THIS MACHINE — what mark-slave reads the
   *  machine's own addresses from, and the one global key of a slave's map that is not inherited.
   *  The default carries three lines on purpose: the machine's own, the loopback every host has,
   *  and an address a container network made — so the reading is proven to take the first and pass
   *  over the other two. */
  hostAddressesOut: string;
  hostAddressesExit: number;
  // ---- what the machine carries of the BOOTSTRAP (place-ansiwise). Every one of these is written
  // by a file transfer and read back by asking the file — so a second run of a step measures what
  // the first one left, and a double-run assertion is about idempotence rather than about a value
  // the test changed in between.
  /** The catalogue checkout at /srv/ansiwise-catalog, as the machine holds it. `catalogueBranch`
   *  undefined is a machine that carries NO catalogue — `test -d` answers no and nothing else about
   *  the checkout is asked. `catalogueRemoteHead` is what origin/<branch> stands on, so a reset
   *  MOVES the head to it and the reading after the reset answers the moved value: a caller that
   *  fetched and did not stand the tree on what it fetched is answered by a machine that did not
   *  move. The DEFAULT is a machine that carries a catalogue one commit behind its origin, because
   *  that is every machine these suites drive programs on.
   *
   *  A machine with no catalogue answers no program at all, so this is deliberately not the default:
   *  it is the shape a bare machine has, and it is asserted by the test that is about a bare one. */
  catalogueBranch: string | undefined;
  /** The branch a clone leaves the checkout standing on — the remote's own head, which is why this
   *  manager names none: which branch a catalogue is read from belongs to the installation. */
  catalogueClonesOnto: string;
  /** What a clone exits with. Non-zero is a machine with no route to the repository, or an address
   *  that names none — the repository itself is public, so there is no credential to be wrong. */
  catalogueCloneExit: number;
  catalogueHead: string;
  catalogueRemoteHead: string;
  /** What `git fetch origin <branch>` answers in the catalogue — non-zero is a machine whose own
   *  read credential no longer opens its origin, or a tree git refuses as somebody else's. */
  catalogueFetchExit: number;
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
    ...firstContactDefaults(),
    machineId: "abc123def4567890abc123def4567890",
    dnsOut: "DNS_WILDCARD 198.51.100.10",
    preflightOut: HEALTHY_SLAVE_PREFLIGHT,
    vaultCode: "200",
    vaultExit: 0,
    credsOut: EMIT_CREDS_JSON,
    credsExit: 0,
    mintedKeyOut: MINT_AUTHKEY,
    mintedKeyExit: 0,
    tailnetProbeOut: TAILNET_PROBE_JOINED,
    coordinatorNodesOut: JSON.stringify([{
      id: 1,
      name: clusterShortName(SLAVE_FQDN),
      given_name: clusterShortName(SLAVE_FQDN),
      user: { id: 1, name: clusterShortName(SLAVE_FQDN), created_at: { seconds: 1, nanos: 0 } },
      ip_addresses: ["100.64.0.11", "fd7a:115c:a1e0::11"],
      online: true,
    }]),
    coordinatorNodesExit: 0,
    coordinatorDeleteExit: 0,
    diagOut: "==== verify-slave diagnostics (ns s1) ====",
    secretStoresOut: "external-secrets/vault-backend|True\nredis/vault-backend|True",
    certsOut: "redis/redis-tls|True",
    hostAddressesOut: [
      "1: lo    inet 127.0.0.1/8 scope host lo",
      "2: eth0    inet 198.51.100.11/24 brd 198.51.100.255 scope global eth0",
      "4: cni0    inet 10.1.32.1/24 brd 10.1.32.255 scope global cni0",
    ].join(String.fromCharCode(10)),
    hostAddressesExit: 0,
    // A slave as deploy-slave meets it: adopted, and carrying neither executable yet.
    catalogueBranch: "main",
    catalogueClonesOnto: "main",
    catalogueCloneExit: 0,
    catalogueHead: "aaa1111",
    catalogueRemoteHead: "bbb2222",
    catalogueFetchExit: 0,
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
    // THE KEY DOOR, answered before anything else, because it decides whether there is a session to
    // send a command over at all (takesManagerKey, deploy-slave.first-contact.fixture.ts). The
    // refusal arrives as AuthFailedError and never as a bare Error: those two mean different things
    // to the door, and only one of them may end in the operator's password being offered
    // (adapters/ssh/port.ts).
    if (target.auth.kind === "key" && !takesManagerKey(f)) {
      return Promise.reject(new AuthFailedError(target.username, new Error("All configured authentication methods failed")));
    }
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
      // HOW THIS MACHINE ANSWERS A ROOT COMMAND, and what it answers of FIRST CONTACT — both from
      // the module that holds the state each of them is judged against, because the rule and the
      // fact it reads may not live apart (deploy-slave.first-contact.fixture.ts). Asked before
      // anything else is matched on, because it is the machine's answer and not the manager's
      // intention.
      const refusal = answerRootCommand(f, command, o.stdin);
      if (refusal !== undefined) return { code: 1, stdoutTail: "", stderrTail: refusal };
      const firstContact = answerFirstContactCommand(f, command);
      if (firstContact !== undefined) { emit(firstContact.out); return done(firstContact.code); }
      if (command === "cat /etc/machine-id") { emit(f.machineId); return done(); }
      if (command.includes("dc-dns-probe-")) { emit(f.dnsOut); return done(); }
      if (command.includes("dc-slave-preflight-")) { emit(f.preflightOut); return done(); }
      if (command.startsWith("curl") && command.includes("/v1/sys/health")) { emit(f.vaultCode); return done(f.vaultExit); }
      // ---- the bootstrap every program act stands on. Every
      // answer is read off what the file transfer actually wrote (deploy-slave.placement.fixture.ts),
      // so a step that transferred nothing is answered by a machine carrying nothing.
      const placement = answerPlacementCommand(f, host, command);
      if (placement !== undefined) {
        emit(placement.out);
        return done(placement.code);
      }
      // ---- the two credential files the manager reads over the session and removes
      if (command.startsWith("cat ") && command.includes("ansiwise-cluster-credentials")) { emit(f.credsOut); return done(f.credsExit); }
      if (command.includes("ansiwise-cluster-credentials")) return done();
      if (command.startsWith("cat ") && command.includes("ansiwise-tailnet-join-key-")) { emit(f.mintedKeyOut); return done(f.mintedKeyExit); }
      if (command.includes("ansiwise-tailnet-join-key-")) return done();
      // ---- the client's account of its own membership, one reading per probe where the field is a
      // list (tailnetProbeOut): a run that puts the machine back on the network reads it twice.
      if (command.includes("dc-tailnet-probe-")) { const p = f.tailnetProbeOut; emit(typeof p === "string" ? p : (p.length > 1 ? p.shift() : p[0]) ?? ""); return done(f.tailnetProbeExit); }
      // ---- declare-tailnet-address's one reading, and it answers on the MASTER: the coordinator is
      // a workload of the master's cluster, and the machine being deployed is never asked.
      if (command.includes("headscale") && command.includes("nodes list")) { emit(f.coordinatorNodesOut); return done(f.coordinatorNodesExit); }
      if (command.includes("headscale") && command.includes("nodes delete")) return done(f.coordinatorDeleteExit);
      // ---- verify-slave. The master-side gates send this machine nothing at all now: they read
      // the master's ArgoCD and its ExternalSecrets through the kube port (the resolver below).
      // What is left on a session is the diagnostic bundle and the two SLAVE-side reads.
      if (command.includes("dc-slave-diag-")) { emit(f.diagOut); return done(); }
      if (command.includes("secretstores.external-secrets.io")) { emit(f.secretStoresOut); return done(); }
      if (command.includes("certificates.cert-manager.io")) { emit(f.certsOut); return done(); }
      // ---- mark-slave's own reading of the machine. Answered on stdoutTail and not through `emit`,
      // because that is where the step reads it: a measurement is read back whole, not followed line
      // by line as a program run is.
      if (command === HOST_ADDRESS_COMMAND) return { code: f.hostAddressesExit, stdoutTail: f.hostAddressesOut, stderrTail: "" };
      // ---- cleanups. The reset MEASURES before it acts, and the machine answers `snap list` as one
      // that carries the snap: the compensation is armed by deploy-cluster, which is the step that
      // installs it, so by the time an abort can run this the snap is there. Answered here rather
      // than by falling through, because it is what decides whether the destructive half runs at all.
      if (command === "snap list microk8s") return done();
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
  /** The ports the executor was given, so a step driven directly (stepOf) is driven through the
   *  same ones — a step built from a narrower set proves a manager nobody ships. */
  runPorts: RunDefinitionsPorts;
  /** The release surface the bootstrap reads both executables off — every address it was asked for,
   *  and where a test puts something other than the asset an address names. */
  releases: ScriptedReleases;
  /** The query API verify-slave's SOFT metrics check asks: every query it was ASKED, and where a
   *  test says what comes back. undefined is a manager that was given NO address — the outcome that
   *  must never read like an address that answered nothing (makeHarness `metrics: false`). */
  metrics?: FakeMetricsQuery;
  /** WHAT THE THREE ARGOCD STEPS READ THROUGH. gitops-handoff, verify-slave's two master-side gates
   *  and argocd-follow reach the master's ArgoCD over the Manager pod's own kube access, so a test
   *  scripts what the master HOLDS here rather than what a `microk8s kubectl` line printed.
   *  `argo` and `cluster` are the master-local pair the resolver hands back for every cluster of
   *  this harness; `resolver` records which cluster ids were resolved. */
  argo: FakeMasterArgoReader;
  cluster: FakeClusterReader;
  resolver: FakeClusterKubeResolver;
}


/** The version clusters/platform/versions.yaml pins for the binary, and the file that carries it — the ONE
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
// keystore: which mode the meta row is seeded with, for a case that reads what the Clusters page
// reports about the keystore. No plan is decided by it.
export async function makeHarness(opts: { hosts?: HostsScript; keystore?: string; master?: boolean; marking?: string | false; ansiwiseServeCommand?: string; versionsYaml?: string; metrics?: FakeMetricsQuery | false; withoutCarriedValues?: boolean } = {}): Promise<Harness> {
  const hosts = opts.hosts ?? scriptedHosts();
  const dir = mkdtempSync(join(tmpdir(), "mgr-ds-"));
  dirs.push(dir);
  const db = openDb(join(dir, "c.db"));
  handles.push(db);
  const store = new CredentialStore({ db: db.db, logger });
  const platformRepo = new FakePlatformRepo();
  if (opts.marking !== false) platformRepo.seed(platformRepo.booksBranch, clusterMapPath(PARAMS.domain), opts.marking ?? SLAVE_MARKING_YAML);
  // The master's map rides along UNCONDITIONALLY (even when the slave's is scripted absent): a
  // master that installed itself carries one by construction, and mark-slave composes the slave's
  // map from it. A test about a master map without a field seeds over this.
  platformRepo.seed(platformRepo.booksBranch, clusterMapPath("m1.example.com"), MASTER_MARKING_YAML);
  // The pin both executables are placed at, on the trunk where the bootstrap reads it. A test about a
  // pin that is missing or malformed seeds over this.
  platformRepo.seed(PRODUCT_BRANCH, ANSIWISE_PIN_PATH, opts.versionsYaml ?? VERSIONS_YAML);
  const releases = new ScriptedReleases();
  // What the master's ArgoCD and its ExternalSecrets hold, beside the harness (the file-size
  // doctrine, and the same shape the placement and first-contact halves take).
  const { argo, cluster, resolver } = masterKubeFakes();
  // A manager that WAS given a query address, because that is every deployed one; `metrics: false`
  // is the manager that was not, and its whole point is that the check says so rather than passing.
  const metrics = opts.metrics === false ? undefined : opts.metrics ?? new FakeMetricsQuery();
  // THE PORT SET, built once and kept on the harness: a step driven directly (stepOf) has to be
  // driven through the same ports the executor was given, or a test proves a manager nobody ships.
  const runPorts = {
    db: db.db, platformRepo, resolver,
    // What deploy-host's git_clone row is answered with, as the composition root builds it from
    // GITHUB_OWNER + GITHUB_REPO. A machine cannot read it off a checkout that does not exist yet.
    platformOrigin: PLATFORM_ORIGIN,
    ansiwiseDownloadUrl: ANSIWISE_DOWNLOAD_URL,
    releaseDownloads: releases,
    ...(opts.ansiwiseServeCommand !== undefined ? { ansiwiseServeCommand: opts.ansiwiseServeCommand } : {}),
    ...(metrics ? { metricsQuery: metrics } : {}),
    // A WINDOW A TEST CAN WATCH CLOSE. A deployment gives a fresh slave two minutes to
    // push its first series; a test that waited them would be a test nobody runs.
    metricsFirstSeriesMs: 20,
    // WHAT THIS MANAGER HOLDS FOR A MACHINE THAT KEEPS NO BOOKS: the address it clones a catalogue
    // from, and its own pull document narrowed to one address. Both are the composition root's
    // (wire.ts). `withoutCarriedValues` is the manager that holds neither, whose whole point is that
    // the deploy-cluster step refuses by name rather than letting the machine install a cluster with
    // no mirror and pull from the public registry with nothing saying so.
    ...(opts.withoutCarriedValues ? {} : {
      catalogueOrigin: { repoURL: CATALOGUE_ORIGIN_URL },
      pullConfiguration: async (registryHost: string) => pullDocumentFor(registryHost),
    }),
  };
  const executor = new Executor({
    db: db.db, creds: store, bus: new RunEventBus(), logger,
    runDefinitions: buildRunDefinitions(runPorts),
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
  // publicKey rides the credential the way `generate-key` seals it — deploy-host's operator_public_key
  // answer is read off exactly this line, and the FINGERPRINT is the one that line really has, because
  // that is the only thing the authorized-keys reading has to tell this manager's own installed key
  // from a stranger's (domains/runs/operator-keys-probe.ts classifies by fingerprint and never by the
  // marker comment). A credential sealed under a made-up fingerprint would make the run's own key read
  // as foreign on the machine it was just installed on.
  await store.seal({ kind: "ssh_key", label: "slave key", plaintext: Buffer.from("fake-slave-key"), fingerprint: fingerprintPublicKey(SLAVE_PUBLIC_KEY), serverId: SLAVE_ID, publicKey: SLAVE_PUBLIC_KEY });
  if (opts.master !== false) {
    db.db.insert(servers).values({
      id: MASTER_ID, name: "m1", host: "m1.example.com",
      sshPort: 22, sshUser: "m1", role: "master", status: "healthy",
      // The master requires a pinned host key (context.ts getSsh hard-fails an unpinned
      // master); the fake session reports "SHA256:fixture" as its host key.
      preflightJson: { hostKey: "SHA256:fixture" },
    }).run();
    await store.seal({ kind: "ssh_key", label: "master key", plaintext: Buffer.from("fake-master-key"), fingerprint: fingerprintPublicKey(MASTER_PUBLIC_KEY), serverId: MASTER_ID, publicKey: MASTER_PUBLIC_KEY });
  }
  return { db, executor, store, hosts, platformRepo, releases, runPorts, argo, cluster, resolver, ...(metrics ? { metrics } : {}) };
}

/** The MASTER's own cluster row, as `seedMaster` writes it at boot on every real installation.
 *
 *  A step that reads the master's ArgoCD resolves through THIS row (defs/deploy-slave.kit.ts
 *  masterClusterId), so a world that leaves it out is a world where those steps refuse by name. It
 *  is not seeded by `makeHarness` itself because several suites seed a master cluster of their own,
 *  in a status their case is about, and two inserts would clash on clusters_server_uq. */
export function seedMasterCluster(h: Harness): void {
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: FIXTURE_STAGE, domain: MASTER_FQDN, status: "active",
  }).run();
}

/** One step out of the deploy-slave definition's own list, for driving it directly.
 *
 *  BUILT WITH THE HARNESS'S OWN PORTS and not with a second, smaller set. A step built here without
 *  the metrics port would report that check SKIPPED whatever the harness was given, and telling that
 *  outcome apart from the others is exactly what the suites use this for. */
export function stepOf(h: Harness, name: string): Step {
  const def = buildRunDefinitions(h.runPorts).get("cluster-deploy-slave") as AnyRunDefinition;
  const step = def.steps({ ...PARAMS }).find((candidate: Step) => candidate.name === name);
  if (!step) throw new Error(`no step ${name}`);
  return step;
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
    params: { ...PARAMS },
    // The one secret every cluster run kind carries from approve through to its last step: the
    // password its steps raise a root command with. A context answering nothing here would make
    // every such step refuse before it ran, and the refusal would be about the fixture.
    secrets: {
      get: (name) => (name === ANSIWISE_ELEVATION_SECRET ? Buffer.from(ELEVATION_PASSWORD, "utf8") : undefined),
      wipe: () => undefined,
    },
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
