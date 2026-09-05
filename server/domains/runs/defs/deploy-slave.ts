import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Step, StepCtx, Cleanup, RunDefinition } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { STAGE, CLUSTER_TIER, isMasterRole } from "../../../../shared/enums.ts";
import { errValidation, errNotConfigured } from "../../../kernel/errors.ts";
import { execCapture, remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import { PREFLIGHT_SCRIPT, parsePreflightOutput, makeCheck, hardenPreflightForSlave, podCidrOverlapCheck, formatNicsLine } from "../preflight.ts";
import { hasHardFailure, type PreflightReport } from "../../../../shared/preflight.ts";
import {
  APP_SYNC_TIMEOUT_MS, APP_SYNC_POLL_MS,
  loadServer, loadMaster, masterFqdnOf, slaveApiHost, sleepUnlessAborted,
  removeSlaveMarkingCleanup, requirePlatformRepo, statedTarget,
  type DeploySlavePorts, type SlaveInstallInput, type SlaveTarget,
} from "./deploy-slave.kit.ts";
import {
  ansiwiseProgramStep, requireElevationPassword, ANSIWISE_ELEVATION_SECRET,
  type AnsiwisePorts, type ExtraAnswers,
} from "./ansiwise-run.kit.ts";
import {
  proveElevationStep, generateKeyStep, installKeyStep, verifyKeyLoginStep, enableNtpStep,
  removeSudoersStep, type FirstContactInput,
} from "./manager-key.kit.ts";
import { disablePasswordLoginStep, purgeBootstrapPasswordStep } from "./password-login.kit.ts";
import { placeAnsiwiseStep, enableAnsiwiseServiceStep } from "./place-ansiwise.step.ts";
import { declareTailnetAddressStep } from "./deploy-slave.address.ts";
import { SLAVE_API_PORT, DATA_DISK_COMMAND, HOST_ADDRESS_COMMAND, dataDiskFrom, hostAddressesFrom } from "./deploy-slave.remote.ts";
import { placeInputStep, dropInputStep } from "./deploy-slave.input.ts";
import { rejoinStep, joinIfAbsentStep, readMembershipStep } from "./tailnet.kit.ts";
import { createMgmtStep, removeSlaveCleanup } from "./deploy-slave.mgmt.ts";
import { clusterShortName, resolveClusterMarking, writeClusterMarking, projectClusterMarking, type ClusterMarking } from "../../inventory/cluster-marking.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { attestTargetStep } from "./deploy-slave.attest.ts";
import { verifySlaveStep, registerStep } from "./deploy-slave.verify.ts";
import { masterSlavePartSteps, masterSlavePartPlan } from "./deploy-slave.master.ts";

// "cluster-deploy-slave" — the Run that gives a server the SLAVE PART, over the deployment PROGRAMS
// of the machine's own catalogue (hostyour-deploy ansiwise/programs/), each driven over
// `ansiwise-rest serve` and proven by a dry run the machine's gate then admits the real run against.
//
// TWO ARMS, decided by the target's ROLE and by nothing an operator states, the way redeploy decides
// between its own — because giving a machine the slave part is a different set of acts on a machine
// that already carries the master part:
//   pure slave        the list below, over TWO HOSTS: the MASTER marks the slave in its books and
//                     takes its registration (register-slave); the SLAVE is built by the same three
//                     machine-layer programs every cluster is (deploy-host, deploy-cluster,
//                     deploy-platform-services), joins the private network with a credential the
//                     master mints, and emits the one credentials file the registration is made
//                     from. NO BRANCH IS CUT: a pure slave has none, its map stands on the books
//                     branch beside every other map of the installation, and its checkout stands on
//                     that same branch (deploy-branch names `master` alone in its own roles line).
//   master, master+   deploy-slave.master.ts, over ONE host: the machine takes the slave part by
//     slave           regenerating its OWN branch under the combined role. One machine, one branch,
//                     one cluster — no ordinal, no second cluster row, no per-slave management plane,
//                     and not one compensating action armed, because every one of them would act on
//                     the control host itself.
//
// IT STARTS ON A BARE MACHINE, and that is why first contact is the head of its step list rather
// than a run kind of its own. Holding a key for a machine is a STATE, not an act somebody performs
// once: this run establishes it where it does not exist and re-measures it where it does, so the
// same list carries a box this manager has never logged in to and a box it deployed yesterday. What
// a person is asked for is the password of the machine account, which raises every root command the
// run sends and, on a machine holding no key of this manager's, opens the first login too.
//
// Before the first of those programs, place-ansiwise puts the binary they are driven through, the
// catalogue they are read from and the platform checkout they act on onto the slave: a bare machine
// carries none of them, and every program step would otherwise open a conversation with a command
// that is not there. After the last of them and after the join,
// enable-ansiwise-service runs the SAME placement once more to switch the machine's own resident
// surface on — the fourth thing that placement places, and the one that needs an address the machine
// only holds once it is on the private network.
//
// mutating: true ⇒ the attest-target law (guards.ts assertGuardsArmed) requires
// steps()[0].name === "attest-target", and slaveCryptoGate restricts a plaintext-keystore install
// to the single rehearsal slave.
//
// The remaining remote scripts live in deploy-slave.remote.ts, the shared step-kit in
// deploy-slave.kit.ts, the credential handshake in deploy-slave.mgmt.ts, verify-slave + register
// in deploy-slave.verify.ts (the file-size doctrine, files ≤400 lines).

export const DeploySlaveParams = z.object({
  serverId: z.string().startsWith("srv_"),
  stage: z.enum(STAGE),
  /** The slave's FQDN == its install branch == clusters.domain (one branch per slave). */
  domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "must be a lowercase FQDN"),
  /** Defaults to rehearsal so the parsed params satisfy slaveCryptoGate's literal check
   *  (a `real` slave is refused until the keystore hardening lifts the gate). */
  tier: z.enum(CLUSTER_TIER).default("rehearsal"),
  /** Explicit ordinal — used by a retry after a failed run (it is never recycled) or to take on a
   *  slave provisioned by hand. Omitted ⇒ attest-target allocates max(slave_id)+1. */
  slaveId: z.number().int().positive().optional(),
});
export type DeploySlaveParams = z.infer<typeof DeploySlaveParams>;

export type { DeploySlavePorts };

/** What the DEFINITION takes beyond what its steps do: the inventory, for the one question that must
 *  be answered BEFORE the steps exist — which arm the target's ROLE earns. steps() is handed the
 *  persisted params and no database, so the db is a port of the def exactly as the platform repo is
 *  one, and it is not optional: an arm chosen off a port that may be absent would be an arm chosen by
 *  whether this manager is configured.
 *
 *  It stands here rather than on DeploySlavePorts for the reason redeploy states the same field on
 *  RedeployPorts (redeploy.ts): the step-level ports are what a STEP is handed, and no step of either
 *  arm reads a database through them — every one of them has ctx.db. */
export interface DeploySlaveDefPorts extends DeploySlavePorts, AnsiwisePorts {
  db: Db;
}

/** Register [cleanup] before the step runs — for a step whose body is a generic program step and
 *  cannot know which compensating action the RUN KIND arms around it. Registered before the first
 *  mutating act, because a step that dies halfway leaves a partial resource only the cleanup can
 *  compensate (every cleanup here tolerates already-absent state, so early registration is safe). */
function armed(cleanup: Cleanup, step: Step): Step {
  return {
    ...step,
    run: async (ctx) => {
      ctx.registerCleanup(cleanup);
      await step.run(ctx);
    },
  };
}

/** Answers the DEF is authoritative for on the machine-layer programs, read off the machine's OWN
 *  cluster map — the record mark-slave wrote earlier in the same run (and re-reads on a redeploy).
 *  books_fqdn is the master's domain (deploy-cluster/-gitops default it to the machine's own,
 *  which for a slave would install a second books keeper); build_plane_fqdn is the map's, whose
 *  self-naming form the programs read the same way as "this machine".
 *
 *  A MACHINE THAT KEEPS THE BOOKS ITSELF is answered by the same reading, and that is why the master
 *  arm (deploy-slave.master.ts) composes this one rather than a second copy: its map names no books
 *  cluster, so books_fqdn is omitted and the programs default to the machine's own — which for that
 *  machine is the right answer, because it IS where the books are kept. */
export function slaveMachineAnswers(target: SlaveTarget, ports: DeploySlavePorts): ExtraAnswers {
  return async (ctx) => {
    const { domain } = target.resolve(ctx.db);
    const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
    const books = marking.booksCluster ?? marking.master;
    // THE INSTALLATION'S ANSWERS STAND IN THE BOOKS-KEEPING CLUSTER'S MAP, not in this machine's.
    // A slave's map is written by mark-slave and says what THIS machine is; what the installation
    // registers with is written once, by the program that generated the master. Read off the slave it
    // was not there, and the machine layer was refused by name one step from the end of its work
    // (apps4, 2026-08-29).
    const installation = books !== undefined && books !== domain
      ? await resolveClusterMarking(requirePlatformRepo(ports), books).catch(() => undefined)
      : marking;
    return {
      ...(books !== undefined ? { books_fqdn: books } : {}),
      build_plane_fqdn: marking.buildPlaneFqdn,
      // THE INSTALLATION'S ANSWER AND NOT THIS MACHINE'S. One installation registers with one
      // authority and gives it one mailbox; asking a person for them again per machine is asking
      // for a second copy of something already written down, and two copies agree only until one is
      // typed differently. A map that predates them carries neither, and then the program refuses
      // by name, which is the sentence an operator can act on.
      ...(installation?.letsencryptEmail !== undefined ? { letsencrypt_email: installation.letsencryptEmail } : {}),
      ...(installation?.letsencryptServer !== undefined ? { letsencrypt_server: installation.letsencryptServer } : {}),
      ...(await dataDisk(ctx)),
    };
  };
}

/** deploy-host's operator_public_key: the public half of the key this manager holds for the machine
 *  (the newest ssh_key credential's stored public line, put on the host by `install-key`). The
 *  program re-installs it idempotently and proves sshd would accept it. A credential row carrying no
 *  public line sends nothing, and the program refuses the missing answer by name. */
/** deploy-host's two checkout answers: WHICH repository the platform tree comes from, and WHICH
 *  branch it stands on. The one extra a machine-layer program takes that nothing on the machine can
 *  answer, because the checkout it would be read from is what the program establishes.
 *
 *  THE BRANCH IS THE INSTALLATION'S, never the trunk. Every machine's live tree stands on the
 *  installation's one install branch — the books, named after the cluster carrying the master part.
 *  That is what its reconciler follows and what release-cluster and deploy-branch read the
 *  release out of. Answering `master` here would move the live tree onto the trunk — measured on
 *  apps3, whose tree stood on master for twelve hours while ArgoCD went on reconciling from origin,
 *  and whose release-cluster then refused because the file it records into was not there.
 *
 *  A machine being born as a master is the one case that takes `master`, and it is not this manager's
 *  case: it has no cluster row yet and is installed by ansiwise-client, which answers this itself. */
/** Everything deploy-host is owed that the machine cannot answer itself: the two checkout answers
 *  above and the public half of the key this manager reaches the machine with. ONE `extra`, because
 *  a program step takes one — and both run kinds that drive deploy-host owe the machine all three.
 *
 *  Note the DIFFERENT sources, which is why they are composed rather than read from one place: the
 *  repository is this installation's setting, the branch is the master's cluster row, and the key is
 *  a sealed credential. */
export function hostAnswers(serverId: string, ports: DeploySlavePorts): ExtraAnswers {
  const checkout = checkoutAnswers(ports);
  const key = operatorKeyAnswer(serverId);
  return async (ctx) => ({ ...(await checkout(ctx)), ...(await key(ctx)) });
}

export function checkoutAnswers(ports: DeploySlavePorts): ExtraAnswers {
  return async (ctx) => {
    const origin = ports.platformOrigin;
    if (origin === undefined || origin.length === 0) {
      throw errNotConfigured(
        "the platform repository is not named — deploy-host's git_clone row is answered with it as " +
        "owner/name, and a machine cannot read it off a checkout that does not exist yet. It is " +
        "built from GITHUB_OWNER + GITHUB_REPO, the same two settings this manager's own platform " +
        "repo stands on",
      );
    }
    // THE BOOKS BRANCH, WHICH IS THE ONLY INSTALL BRANCH AN INSTALLATION HAS. A machine carrying the
    // master part keeps a branch named after its own domain, and that branch IS the books; a machine
    // carrying only the slave part has none at all, and its checkout stands on the books branch
    // beside the master's, where its own cluster map is. Answering the machine's own domain here
    // would put a pure slave's checkout on a branch nothing ever cuts, and deploy-host's git_clone
    // row is where the run would stop.
    const masterFqdn = masterFqdnOf(ctx.db, loadMaster(ctx.db));
    return { platform_repo: origin, platform_branch: masterFqdn };
  };
}

export function operatorKeyAnswer(serverId: string): ExtraAnswers {
  return async (ctx) => {
    const key = (await ctx.creds.list({ serverId, kind: "ssh_key" })).at(-1);
    return key?.publicKey !== undefined ? { operator_public_key: key.publicKey } : {};
  };
}

/** The install step list BOTH cluster run kinds run: deploy-slave takes a machine from wherever it
 *  stands — a box nothing has touched included — through it, and redeploy re-runs it against a slave
 *  that is already live. `mode` decides two things. Per step, whether the compensating action that
 *  would UNDO it is armed — never on a redeploy, where every one of them undoes a WORKING slave, and
 *  where the redeploy definition implements none of them to be resolved against. And whether the ONE
 *  BIRTH act runs at all: the branch cut, which a slave gets once — the program's push takes no
 *  force, so re-cutting a standing branch is refused rather than rewritten.
 *
 *  THE TAILNET JOIN IS NOT A BIRTH ACT, and a list that treats it as one cannot finish a machine
 *  reinstalled at the hosting provider — which is the machine a redeploy is asked for (redeploy.ts).
 *  It is unconditional on a deployment, where the machine's membership is this platform's to
 *  establish whatever the box arrived carrying, and MEASURED on a redeploy, where a machine
 *  reinstalled at the hosting provider holds none and a live one must not be handed a fresh address
 *  for nothing. Which of the two runs is decided here; what the measured one reads and why it acts
 *  is written where it lives (tailnet.kit.ts joinIfAbsentStep).
 *
 *  THE FIRST-CONTACT STEPS RUN ON BOTH ARMS, and only their compensations are held back. Each of
 *  them measures before it acts, so on a live slave they read a key that is installed, a login that
 *  works and doors that are already shut, and each says so in a full sentence. A step left out of a
 *  list is a step nobody can see was considered; a step that reports finding nothing to do is a
 *  reading. */
export function deploySlaveSteps(input: SlaveInstallInput, ports: DeploySlavePorts & AnsiwisePorts): Step[] {
  const { target, mode } = input;
  const sid = target.serverId;
  const redeploying = mode === "redeploy";
  const machineAnswers = slaveMachineAnswers(target, ports);
  // The password every root command of this run is raised with is also what opens the first login on
  // a machine this manager holds no key for — one secret, named once, and the same one the machine's
  // own programs are driven with (ansiwise-run.kit.ts).
  const firstContact: FirstContactInput = { serverId: sid, secretName: ANSIWISE_ELEVATION_SECRET };
  return [
    attestTargetStep(input),
    // ---- FIRST CONTACT: the manager's own key onto the machine, and the machine's doors left the
    // way this platform keeps them. Every one of these steps is measure-then-act (manager-key.kit.ts),
    // so a machine that already carries all of it is read by every one of them, written to by none,
    // and reported on in a full sentence by each — which is what lets the same list run against a
    // bare box and against a live slave. They stand HERE, before the preflight, because the
    // preflight and everything after it reach the machine over ctx.ssh(), and ctx.ssh()
    // authenticates with the key install-key puts there and verify-key-login proves.
    proveElevationStep(firstContact),
    generateKeyStep(firstContact),
    // install-key is the one key step that leaves anything on the machine, and NOTHING TAKES IT BACK.
    // The key line is what every session after it is opened with, and this same list shuts the
    // daemon's password door and destroys the sealed bootstrap password — so an abort that removed
    // the line would leave a machine nothing can reach, on exactly the run that failed.
    installKeyStep(firstContact),
    verifyKeyLoginStep(firstContact),
    enableNtpStep(firstContact),
    // Last of the key steps, and it may only stand here because every root command this run sends
    // afterwards is raised with the password the run carries: the programs by their own engine, the
    // steps through the step-kit's `elevation`.
    removeSudoersStep(firstContact),
    {
      name: "slave-preflight",
      title: "Preflight the slave (hard policy)",
      run: async (ctx) => {
        // The machine's checks under the SLAVE-HARD policy: every severity becomes hard, and the
        // two ingress ports and a missing snapd — which the catalogue grades soft, because a box
        // carrying either is still a box — are promoted to failures, since a slave needs Traefik to
        // own 80/443 and MicroK8s arrives as a snap (preflight.ts SLAVE_FAIL_ON_WARN).
        //
        // It stands AFTER first contact, and that ordering is what makes it the one preflight this
        // machine gets: it is read over ctx.ssh(), which authenticates with the key the steps above
        // installed, and a machine whose account cannot reach root has already been refused by
        // prove-elevation, for the cost of one command rather than of a whole script.
        const server = loadServer(ctx.db, sid);
        const master = loadMaster(ctx.db);
        const masterFqdn = masterFqdnOf(ctx.db, master);
        const session = await ctx.ssh();
        const cap = await remoteScriptCapture(ctx, session, "slave-preflight", PREFLIGHT_SCRIPT, { timeoutMs: 60_000 });
        const parsed = parsePreflightOutput(cap.stdout);
        ctx.log("meta", formatNicsLine(parsed));
        const checks = hardenPreflightForSlave(parsed.checks);

        // Slave extra: the master's Vault must answer FROM THE SLAVE (the per-slave KV mount
        // lives there; slave-ESO authenticates against it). Reached over the Traefik
        // INGRESS (https://vault.<master>, :443) — the master's Vault is a ClusterIP with no
        // host-port/nodeport, so :8200 is unreachable off-cluster; only the ingress (/v1/**
        // IngressRoute) is externally reachable. curl WITHOUT -f on purpose: /v1/sys/health
        // answers 429/472/473/501/503 for standby/uninitialized/sealed — ANY http code proves
        // reachability; only a transport failure fails.
        const url = `https://vault.${masterFqdn}/v1/sys/health`;
        let httpCode = "";
        const vr = await session.exec(`curl -4 -sS -o /dev/null --max-time 10 -w '%{http_code}' ${url}`, {
          signal: ctx.signal,
          onStdout: (l) => {
            httpCode += l.trim();
            ctx.log("stdout", l);
          },
          onStderr: (l) => ctx.log("stderr", l),
        });
        const reachable = vr.code === 0 && /^[1-5]\d\d$/.test(httpCode);
        checks.push(makeCheck("vault.reachable", reachable ? "pass" : "fail",
          reachable ? `HTTP ${httpCode} from ${url}` : `no HTTP answer from ${url} (curl exit ${vr.code}${httpCode ? `, code ${httpCode}` : ""})`));

        // The pod (Calico) CIDR must be disjoint from the cluster LAN, or manager pods can't
        // route to the slave's LAN IP (the `dial …:16443 i/o timeout` blocker). Purely LOCAL — the
        // Manager already knows the cluster LAN (the /24 around the inventory lanHost) and the
        // installer's default pod CIDR; no probe. Reads `lanHost` and NOT the address the slave is
        // dialled on: this asks about the cluster network, and a slave dialled on its tailnet
        // address is out of a pod pool's reach by construction. Skipped (no check pushed) when
        // lanHost is unknown/not an IPv4 — a NAT/FQDN row yields no cluster LAN.
        const overlap = podCidrOverlapCheck(server.lanHost);
        if (overlap) checks.push(overlap);
        else ctx.log("meta", `pod-CIDR/cluster-LAN overlap check skipped — server ${server.name} has no IPv4 lanHost to derive the cluster LAN from`);

        const report: PreflightReport = { checkedAt: Date.now(), checks };
        // Merge under its own key, never replace the column: the same JSON holds `hostKey`, which is
        // the fingerprint every session to this machine is pinned on (executor/context.ts), and a
        // report written over it would take the pin off the row.
        const pf = (server.preflightJson as Record<string, unknown> | null) ?? {};
        localTx(ctx, (tx) => tx.update(servers).set({ preflightJson: { ...pf, slavePreflight: report } }).where(eq(servers.id, sid)).run());
        ctx.checkpoint({ checkCount: checks.length });

        if (hasHardFailure(report)) {
          const failed = report.checks.filter((c) => c.severity === "hard" && c.status === "fail");
          throw errValidation(
            `Slave preflight failed: ${failed.map((c) => `${c.title} — ${c.detail}${c.hint ? ` (${c.hint})` : ""}`).join("; ")}`,
          );
        }
      },
    },
    // ---- THE TWO IRREVERSIBLE ACTS, and they stand exactly here for a reason that is narrower than
    // "last": they run after everything that can fail WITHOUT this manager's own key. Shutting the
    // daemon's password door and destroying the stored bootstrap password each remove a way in, so
    // both wait until verify-key-login has proven the way in that stays — and a run that dies in the
    // machine layer below therefore leaves a machine reachable by key and by this manager alone,
    // which is the state a retry of this same run needs.
    //
    // AND THEY STAND AFTER `remove-sudoers`, WHICH IS THE ORDER THIS LIST IS BUILT ON. Each of the
    // three takes away one route, and the list is ordered so that the route the NEXT step needs is
    // still there when it runs:
    //   - `remove-sudoers` takes away the standing passwordless-root grant. What is left is the
    //     password this run carries, which every step after it raises its own commands with — the
    //     step's own condition on any list that contains it (defs/manager-key.kit.ts), and the
    //     reason `disable-password-login` ships its script raised whole rather than reaching root
    //     through a rule the step before it deleted.
    //   - `disable-password-login` takes away the daemon's password door, which is how a FIRST
    //     session is opened on a machine this manager holds no key for. Every step that may need
    //     one — the whole of first contact, through `openDoor` — has run by here, and everything
    //     after it reaches the machine over ctx.ssh(). Shutting that door does not touch how this
    //     run reaches root: `sudo -S` over the key session takes the same password it always did.
    //   - `purge-bootstrap-password` takes away the password sealed beside the row, and it goes last
    //     because it is the one thing no later step and no compensation could ask for again.
    // Run the list a second time and each of the three measures first and finds its work done, so
    // the order is a property of one pass rather than a state a retry has to be talked out of.
    //
    // NEVER ARMED, ON EITHER ARM. A shut password door is the state every later run kind of this
    // manager needs, so putting it back is not a repair of a failed install — it is undoing the one
    // act that install existed to perform, on a machine this manager can already reach with its own
    // key. The step keeps the option because the standalone run kind
    // `cluster-password-login-disable` DOES arm it (defs/password-login.kit.ts, defs/password-
    // login.ts): there the door is the subject of the run, and an abort of it owes the operator the
    // door they had.
    disablePasswordLoginStep(sid, { arm: false, secretName: firstContact.secretName }),
    // No compensation at all, on either arm: a destroyed credential cannot be put back, and this run
    // holds the operator's password in memory rather than a copy of the machine's sealed one.
    purgeBootstrapPasswordStep(sid),
    {
      name: "mark-slave",
      title: "Mark the slave in the cluster map on the books branch",
      run: async (ctx) => {
        const { domain, stage } = target.resolve(ctx.db);
        const server = loadServer(ctx.db, sid);
        const master = loadMaster(ctx.db);
        const masterFqdn = masterFqdnOf(ctx.db, master);
        const repo = requirePlatformRepo(ports);
        // The slave inherits the installation's own values from the MASTER's map: where it pulls
        // images from, the public apex its units serve under, the business domain, where alerts
        // go, and the catalog repository — a slave belongs to the SAME installation, so nothing
        // here is asked a second time.
        const masterMarking = await resolveClusterMarking(repo, masterFqdn);
        // The dial address, resolved by the ONE resolver create-mgmt also uses — the map's apiHost
        // and the api_server_url answer are two spellings of one resolution, never two sources.
        const apiHost = slaveApiHost(server);
        if (!/^[a-z0-9._:-]+$/i.test(apiHost)) {
          throw errValidation(`server ${server.name} has a malformed API address "${apiHost}" — fix the inventory row (tailnetHost, lanHost or host)`);
        }
        // THE INSTALLATION, WITH THIS MACHINE'S FACTS OVER IT. A slave's map used to be built from
        // a handful of fields copied by name, and everything not named was simply absent: of the
        // seventeen keys a master's map carries, a slave's had ten. What went missing were the
        // things every program on that machine reads — the address of the secret store among them,
        // which is why its own machine layer stopped at "is not on this host" (apps4, 2026-08-29).
        //
        // So the master's map is the ground and the overrides below are the whole of what differs.
        // A key added to a master's map from now on reaches a slave without anybody remembering to
        // copy it, which is the property a list of names could never have.
        // A RELEASE PIN IS NOT INHERITED: it says which release THAT cluster stands on, and this
        // machine stands on none until one is put there. Taken off here rather than overwritten,
        // because an optional property set to undefined is not the same as one that is not there.
        const { release: _theMastersRelease, ...installation } = masterMarking;
        const inherited = masterMarking.globalRest ?? {};
        const shortName = clusterShortName(domain);
        const holdsBuildPlane = masterMarking.buildPlaneFqdn === domain;
        // THIS MACHINE'S OWN ADDRESSES, read off this machine. Everything else below is inherited,
        // and this is the one global key that is a fact about the box rather than about the
        // installation. Its one reader is the gate sandbox's fence, and that chart carries
        // `runsOn: master` — the app generator matches it against the cluster's ROLE, so nothing on
        // a slave reads this key today and the wrong list cost nothing yet. What it did cost is the
        // truth of the file: clusters/active/<fqdn>.yaml is the ONE place an installation's answers
        // are written down, and a slave's said where the MASTER can be reached.
        const seen = await (await ctx.ssh()).exec(HOST_ADDRESS_COMMAND, { signal: ctx.signal, timeoutMs: 30_000 });
        const nodeCidrs = seen.code === 0 ? hostAddressesFrom(seen.stdoutTail) : [];
        // AN EMPTY READING IS NOT A READING. A machine carries at least one address or nothing
        // reached it — and a fence that names nothing to keep out reports itself drawn while
        // standing open, which is worse than a run that stops here saying so.
        if (nodeCidrs.length === 0) {
          throw errValidation(
            `${domain} lists no address of its own (\`${HOST_ADDRESS_COMMAND}\`), and global.nodeCidrs is what the gate sandbox draws its fence from — a map written without it would fence nothing`,
          );
        }
        // EVERY PART THE MACHINE CARRIES, never one of them. This run adds the slave part; a
        // machine that already carries the master part therefore becomes "master+slave" — the
        // union SERVER_ROLE declares for one server doing both jobs. A flat "slave" here would
        // demote the books-keeping cluster in its own map, and the projection below would then
        // write that word onto the server row, where every reader keyed on MASTER_ROLES stops
        // finding the master.
        const role = isMasterRole(server.role) ? "master+slave" as const : "slave" as const;
        const slaveMarking: ClusterMarking = {
          ...installation,
          // WHAT THIS MACHINE IS, and nothing else.
          fqdn: domain,
          name: shortName,
          stage,
          role,
          booksCluster: masterFqdn,
          buildPlane: holdsBuildPlane,
          buildPlaneFqdn: masterMarking.buildPlaneFqdn,
          master: masterFqdn,
          apiHost,
          apiPort: SLAVE_API_PORT,
          globalRest: {
            ...inherited,
            // Per cluster, both of them: the short name everything named per cluster carries, and
            // the secret store's auth mount, which is what tells two clusters of one installation
            // apart when they log in.
            clusterName: shortName,
            vaultKubernetesAuthPath: `kubernetes-${shortName}`,
            // Measured above, never inherited.
            nodeCidrs,
            // WHICH OF THE SHARED SERVICES STAND HERE. Two of the three follow from who keeps the
            // books, and a slave keeps none: one installation has ONE Vault and ONE observability
            // stack, both on the books-keeping cluster. Inherited from a master both said `true`,
            // and what that reaches today is the CoreDNS hairpin, which then emits a rewrite of
            // `vault.<this slave>` to this cluster's own Traefik — a name nothing dials, so the
            // wrong flag sits latent. It is still a map saying this cluster runs a store it does
            // not run, and the key exists so a chart can decide from it where to dial. The third
            // follows from where the build plane is, which may be this machine.
            servicesLocal: {
              ...(typeof inherited["servicesLocal"] === "object" && inherited["servicesLocal"] !== null
                ? (inherited["servicesLocal"] as Record<string, unknown>)
                : {}),
              registry: holdsBuildPlane,
              vault: false,
              observability: false,
            },
          },
        };
        // Armed BEFORE the write. Dropping the slave part again is the inverse: it takes the
        // cluster out of the master's slaves ApplicationSet, whose finalizer then cascades the
        // teardown of the management plane. NEVER armed on a redeploy — that cascade against a
        // LIVE slave is exactly what must not happen.
        if (!redeploying) ctx.registerCleanup(removeSlaveMarkingCleanup(ports));
        // ONE WRITE, ON THE BOOKS BRANCH. It is where an installation keeps its maps and where one
        // cluster reads about another — and, since a pure slave has no branch of its own, it is also
        // the tree standing beside the machine, which is where a machine reads ITS OWN map (a slave
        // whose map was missing there had its machine layer stop at "is not on this host" asking for
        // the secret store's address; apps4, 2026-08-29).
        const { changed } = await writeClusterMarking(repo, slaveMarking, ctx.runId);
        // THE ROW FOLLOWS THE MAP. The map is the writable place and the inventory columns are the
        // copy every role and stage decision in this process queries, so the act that rewrites the
        // map moves the copy in the same step — this is the code path that puts "master+slave" on
        // a server row when the slave part lands on a machine already carrying the master part.
        projectClusterMarking(ctx.db, slaveMarking, { actor: "system", runId: ctx.runId });
        ctx.log("meta", changed
          ? `${clusterMapPath(domain)} on ${repo.booksBranch} now marks ${slaveMarking.name}: role ${role}, stage ${stage}, ${apiHost}:${SLAVE_API_PORT}, build plane ${slaveMarking.buildPlaneFqdn}`
          : `${clusterMapPath(domain)} already states this marking — nothing to commit`);
        ctx.checkpoint({ branch: domain, apiHost, changed });
      },
    },
    // The binary every program act below is spoken to through, the catalogue those programs are read
    // from, and the platform checkout they act on. It stands FIRST among the machine-side acts
    // because none of them can run without all three: `ansiwise-rest serve` is a binary reading a
    // catalogue, and a machine at its first installation carries none of them. Idempotent by
    // measurement, which is what lets a redeploy run the same step against a machine that carries them.
    placeAnsiwiseStep(target, ports),
    // ---- the machine layer, exactly as every cluster gets it: the three deployment programs on
    // the slave's own surface, each dry-proven then run.
    //
    // deploy-host makes the box workable and stands FIRST of the three because it is also the ONE
    // WRITER of /srv/hostyour-cloud, the tree the two programs after it act on: its git_clone row
    // fetches the books branch and places the checkout on that branch's published tip, which is how
    // the cluster map mark-slave pushed earlier in this run reaches the machine. The programs after
    // it read that tree as it stands and deliberately fetch nothing themselves. Its own
    // install_packages row is what puts `git` on the machine for that row.
    ansiwiseProgramStep(target, "deploy-host", ports, { extra: hostAnswers(sid, ports) }),
    // The two values a cluster keeping no books reads off its machine, composed out of what this
    // manager already holds and put there for the length of the run. It stands HERE because the
    // first row that reads one of them is deploy-cluster's containerd mirror; drop-input below
    // takes it away once the last one has run, and a run that dies before drop-input leaves the file
    // for the next run of this list to overwrite.
    placeInputStep(target, ports),
    // Nothing is armed around it: taking MicroK8s off again is a destructive act whose only effect
    // on a retry is a second install of the same snap, and the step measures before it acts.
    ansiwiseProgramStep(target, "deploy-cluster", ports, { extra: machineAnswers }),
    // deploy-platform-services also declares elevation_password — the ENGINE fills that one from the
    // password the POST carries beside the answers; sending it as an answer is refused.
    ansiwiseProgramStep(target, "deploy-platform-services", ports, { extra: machineAnswers }),
    // Both programs that read them have run.
    dropInputStep(target),
    // THE JOIN, and WHICH join is the one thing this guard still decides. A deployment joins the
    // machine outright: mint on the master, carry the credential over the session, spend it in ONE
    // program run on the slave (the tailnet kit's own step, because a first join is the same act —
    // the program's logout-first is a no-op on a machine that was never on the network), and a
    // machine that arrived carrying somebody else's membership is REPLACED rather than left on it.
    // remove-slave is armed there, before the FIRST master-side per-slave state (the coordinator
    // user) exists; it also covers everything create-mgmt makes later, and it tolerates absent
    // state, so early registration is safe. A redeploy takes the measured form of the same act and
    // arms nothing: it joins a machine that holds no address and says what it read of one that
    // does (tailnet.kit.ts joinIfAbsentStep).
    ...(redeploying
      ? [joinIfAbsentStep(target, sid, ports)]
      : [armed(removeSlaveCleanup(ports), rejoinStep(target, sid, ports))]),
    // The reading that describes a managed slave, taken after whichever of the two ran — without it
    // the row carries no membership at all for the machine the master's ArgoCD and Vault are talking
    // to, and a redeploy would end showing the reading its own decision was made on rather than the
    // one the machine holds now.
    readMembershipStep(sid),
    // WHICH address the machine holds there, asked of the one that handed it out — before the step
    // below, because that step is the first thing to dial it, and on every deployment rather than
    // only after a fresh join: a join hands the machine a NEW address, and a run that joined nothing
    // is still the one that has to notice a row whose address went stale.
    declareTailnetAddressStep(target, sid, ports),
    // The machine's own surface, switched on. It stands HERE and not beside the placement at the
    // head of the list because it binds an address of the private network: the join above is what
    // measured that the machine holds one or put it back on the network, and the step right above is
    // what states which address that is. Everything before this reached the machine over a held-open
    // session; this is what makes the machine reachable without one, across a restart.
    enableAnsiwiseServiceStep(target, ports),
    createMgmtStep(target, ports),
    {
      name: "gitops-handoff",
      title: "Hand off to GitOps (wait for the master's slaves-appset to sync)",
      run: async (ctx) => {
        // The map's slave part IS the slave's management plane: wait — bounded, abortable — until
        // the master's ArgoCD has GENERATED (slaves-appset) and SYNCED Application <name>-apps.
        // The map landed BEFORE register-slave created the AppProject, so the generated
        // Application legitimately waits on that missing project and syncs once it exists.
        const { domain } = target.resolve(ctx.db);
        const master = loadMaster(ctx.db);
        const mSession = await ctx.ssh(master.id);
        const elevation = requireElevationPassword(ctx); // the master's cluster, raised the same way every other read of it is
        const appName = `${clusterShortName(domain)}-apps`;
        const deadline = Date.now() + APP_SYNC_TIMEOUT_MS;
        for (;;) {
          const read = await execCapture(ctx, mSession, `microk8s kubectl -n argocd get application ${appName} -o jsonpath={.status.sync.status}`, { timeoutMs: 30_000, elevation });
          const sync = read.out.trim();
          if (read.code === 0 && sync === "Synced") break;
          if (Date.now() >= deadline) {
            throw errValidation(`Application ${appName} did not reach Synced within ${APP_SYNC_TIMEOUT_MS / 60_000} min — check the master's ArgoCD (slaves-appset) and the pushed map ${clusterMapPath(domain)}`);
          }
          ctx.log("meta", `waiting for Application ${appName} to appear + sync (currently: ${sync || "absent"})`);
          await sleepUnlessAborted(APP_SYNC_POLL_MS, ctx.signal);
        }
        ctx.checkpoint({ appName });
        ctx.log("meta", `Application ${appName} is Synced — the ${clusterShortName(domain)} slave-ArgoCD now drives the slave from branch ${domain}`);
      },
    },
    // verify-slave (master+slave): HARD — the instance's ESO-materialized credentials Ready
    // in ns <name> (repo + cluster; with a force-sync kick against ESO error backoff), every
    // Application in ns <name> Synced/Healthy, every slave ESO SecretStore Ready (one bounded
    // retry window, with a rate-limited master-side diagnostic bundle while a gate fails);
    // SOFT — master Prometheus sees up{cluster="<fqdn>"}, slave ingress certs issued.
    verifySlaveStep(target, ports),
    // register (local tx, overwrite-idempotent): cluster→active + provisionedAt + planeState
    // ready + planeJson (ClusterPlaneV0, shared/plane.ts); server→healthy; plane facts logged.
    registerStep(target),
  ];
}

/** deploy-slave's own share of the shared step list: the operator stated the FQDN and the stage, so
 *  the target lookup is a constant, and the mode arms every compensating action. */
function installInput(params: DeploySlaveParams): SlaveInstallInput {
  return {
    target: statedTarget(params.serverId, params.domain, params.stage),
    mode: "deploy",
    slaveId: params.slaveId,
    tier: params.tier,
  };
}

/** Does this run's target already carry the MASTER part? The whole arm choice, asked of the
 *  inventory, because a role is a fact of the row and never something an operator states.
 *
 *  ONE predicate for both plan() and steps(), each handing it the database it has — the planner its
 *  own, and steps() the one the def holds as a port, because steps() is given the persisted params
 *  and no database. Two spellings of this question could disagree, and a plan whose card described
 *  one arm while its steps ran the other is exactly what that would look like.
 *
 *  A server the lookup does not resolve is answered NO and takes the pure-slave arm: that is the arm
 *  of a machine this manager has no row for yet, and it is also what the boot check needs, which
 *  calls steps({}) with no params at all purely to assert that step 0 is attest-target — a question
 *  the two arms answer alike. */
function carriesMasterPart(db: Db, serverId: string): boolean {
  const role = db.select({ role: servers.role }).from(servers).where(eq(servers.id, serverId)).get()?.role;
  return role !== undefined && isMasterRole(role);
}

export function makeDeploySlaveDef(ports: DeploySlaveDefPorts): RunDefinition<DeploySlaveParams> {
  return {
  kind: "cluster-deploy-slave",
  paramsSchema: DeploySlaveParams,
  mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted where the run definitions are assembled at boot
  plan: async (params, { db }) => {
    // WHICH ARM, asked before anything is composed. The master arm plans a run over ONE host and ONE
    // cluster, so it carries its own card, its own targets and its own locks rather than a branch
    // inside the ones below (deploy-slave.master.ts).
    if (carriesMasterPart(db, params.serverId)) return masterSlavePartPlan(params, ports, db);
    const slave = loadServer(db, params.serverId);
    const master = loadMaster(db);
    const stepDefs = deploySlaveSteps(installInput(params), ports);
    // The address the run will actually dial. Neither target below states a transport, so the slave
    // resolves the way every run always has — and the card must name the address the first connect
    // line in the log names, or an operator approves one address and gets the other.
    const dialled = resolveTransport(slave, "default");
    return {
      kind: "cluster-deploy-slave",
      targetKind: "server",
      targetId: params.serverId,
      // WHAT THE PASSWORD IS SPENT ON is part of the summary and not of the warnings, because the
      // approve card is what an operator reads before typing it (RunView carries a summary and no
      // warnings). It says all three things the password does on this run: it raises every root
      // command the run and the machine's own programs send, and where this manager holds no key for
      // the machine yet it also opens the very first login and installs one.
      summary:
        `Deploy "${slave.name}" (${dialled.host}) as ${params.stage} slave ${params.domain}` +
        `${params.slaveId !== undefined ? ` (slaveId ${params.slaveId})` : ""} [tier ${params.tier}]: ` +
        `${stepDefs.length} steps over two hosts — the slave (first contact, then the machine-layer programs on its own ` +
        `ansiwise surface) and the master "${master.name}" (the books and the registration). ` +
        `The password you enter raises every root command of this run, and where this manager holds no key for ` +
        `"${slave.name}" it also opens the first login and installs one. It is held in memory for the length of the run ` +
        `and stored nowhere. The machine is left taking key logins only, with the bootstrap password sealed beside its ` +
        `row destroyed and no standing passwordless-root grant of this manager's on it.`,
      steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
      // BOTH hosts are declared so ctx.ssh(slave) AND ctx.ssh(master) pass the plan gate;
      // only the slave is owned (server:<slave> lock derives from ownsHost).
      targets: [
        { serverId: slave.id, ownsHost: true, label: `${slave.name} (slave)` },
        { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
      ],
      // The locks beyond the derived server:<slave>: the ONE touched git branch — the books, which
      // is the master's own install branch, the branch the slave's checkout is brought onto and the
      // branch its map lands on — the master's Vault surface
      // (register-slave's mounts/policies/roles), and the master's kube-apiserver (the handoff
      // wait + verify reads). Key "m" and no per-cluster key, because the platform has ONE Vault
      // and it sits on the master: a second deploy-slave (or any other master-vault Run)
      // therefore serializes instead of interleaving Vault surgery.
      locks: [
        { resource: "git-branch", key: masterFqdnOf(db, master) },
        { resource: "master-vault", key: "m" },
        { resource: "master-kube", key: "m" },
      ],
      warnings: [
        `The machine layer installs over the slave's own ansiwise surface — the base install (deploy-cluster) runs ~25 minutes detached on the machine, and a retry of its step re-attaches instead of starting a second run.`,
      ],
      // The programs raise their commands to root with a password the CALLER hands over per run
      // (the installation's ansiwise.yaml: password_from_caller) — collected at approve, held in
      // memory, sent with each POST /runs, persisted nowhere. Nothing is asked beyond it: what the
      // machine-layer programs declare past the inventory stands in the master's own cluster map,
      // and slaveMachineAnswers reads it there.
      requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
    };
  },
  steps: (params) => carriesMasterPart(ports.db, params.serverId)
    ? masterSlavePartSteps(params, ports)
    : deploySlaveSteps(installInput(params), ports),
  // Every compensating action this run's steps may register, and each one has to be here: the
  // executor resolves the persisted __cleanups by NAME against this list, so a name it does not
  // carry ends an abort with a step that has no implementation. They run in reverse registration
  // order on an explicit abort-with-cleanup: remove-slave (armed by the join, before the first
  // master-side per-slave state exists) → remove-slave-marking (armed by mark-slave, before the map
  // write — by then remove-slave has already dropped the map's slave part itself, FIRST, which is
  // that program's own contract, so this one finds nothing left to drop).
  //
  // BOTH OF THEM ACT ON THE MASTER'S BOOKS, AND THAT IS THE WHOLE LIST. What a half-finished run
  // left on the SLAVE is finished by running the run again, which is the rule the master arm has
  // always stated (deploy-slave.master.ts) and the reason every step of this list is written
  // measure-then-act. A compensation that undid one of those acts would take away something the
  // retry needs and buy nothing:
  //   - the key line install-key appended is what every session after it is opened with, and this
  //     same list shuts the password door and destroys the sealed bootstrap password, so removing it
  //     leaves a machine nothing can reach;
  //   - the shut password door is the state every later run kind of this manager needs;
  //   - MicroK8s is reinstalled by the same program on the next run;
  //   - the input file is overwritten by place-input, which measures what the machine holds first.
  // So an aborted first install leaves a machine reachable by this manager's key and by nobody
  // else — the state its own retry starts from.
  //
  // remove-slave IS A ROOT ACT ON A MACHINE THAT GRANTS THIS MANAGER NOTHING WITHOUT A PASSWORD, so
  // the abort has to be given the run's password again (executor/executor.ts abortWithCleanup);
  // without it the cleanup refuses by name, which is the loud form of the same fact rather than a
  // master left half-registered.
  //
  // THE MASTER ARM REGISTERS NEITHER, so this list is the pure-slave arm's alone. The list stays
  // whole because the executor resolves persisted names against it, and a run of either arm may hold
  // names from a run of its own.
  cleanups: () => [removeSlaveCleanup(ports), removeSlaveMarkingCleanup(ports)],
  onTerminal: (status, { db, params }) => {
    if (status === "succeeded") return; // the register step set the terminal states
    const sid = String(params.serverId);
    const domain = String(params.domain);
    // Free the server (provisioning→ready; never clobber another status) and park the
    // cluster row back at `planned` KEEPING its allocated slaveId — the ordinal is never
    // recycled (clusters_slave_id_uq); a retry resumes the row (or passes slaveId explicitly).
    //
    // BOTH ARE NO-OPS AFTER A MASTER-ARM RUN, and by the status guards rather than by a branch: that
    // arm moves neither row, so its machine stands at `healthy` and its cluster at `active`
    // throughout, and neither WHERE clause below matches. A failed run therefore leaves a live
    // installation exactly as live as it found it.
    db.update(servers)
      .set({ status: "ready" })
      .where(and(eq(servers.id, sid), eq(servers.status, "provisioning")))
      .run();
    db.update(clusters)
      .set({ status: "planned" })
      .where(and(eq(clusters.domain, domain), eq(clusters.status, "provisioning")))
      .run();
  },
};
}

/** Asks the machine for its mount table and reads the data disk out of it. A machine that answers
 *  nothing readable is treated as one with no such disk: this decides WHERE volumes go and never
 *  WHETHER a run proceeds. */
async function dataDisk(ctx: StepCtx): Promise<Record<string, string>> {
  try {
    const session = await ctx.ssh();
    const seen = await session.exec(DATA_DISK_COMMAND, { signal: ctx.signal, timeoutMs: 30_000 });
    if (seen.code !== 0) return {};
    const disk = dataDiskFrom(seen.stdoutTail);
    if (disk === undefined) {
      ctx.log("meta", "this machine carries no separate data disk — the cluster's volumes stay where the snap puts them");
      return {};
    }
    ctx.log("meta", `the cluster's volumes go on ${disk.storage_mount}, under ${disk.storage_subdirectory}`);
    return disk;
  } catch {
    return {};
  }
}
