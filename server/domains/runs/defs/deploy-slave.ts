import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Step, StepCtx, Cleanup, RunDefinition } from "../../../executor/types.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { STAGE, CLUSTER_TIER } from "../../../../shared/enums.ts";
import { errValidation, errNotConfigured } from "../../../kernel/errors.ts";
import { execCapture, remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import { PREFLIGHT_SCRIPT, parsePreflightOutput, makeCheck, hardenPreflightForSlave, podCidrOverlapCheck, formatNicsLine } from "../preflight.ts";
import { hasHardFailure, type PreflightReport } from "../../../../shared/preflight.ts";
import {
  APP_SYNC_TIMEOUT_MS, APP_SYNC_POLL_MS,
  loadServer, loadMaster, masterFqdnOf, slaveApiHost, sleepUnlessAborted,
  microk8sResetSlaveCleanup, removeSlaveMarkingCleanup, requirePlatformRepo, statedTarget,
  type DeploySlavePorts, type SlaveInstallInput, type SlaveTarget,
} from "./deploy-slave.kit.ts";
import {
  ansiwiseProgramStep, requireElevationPassword, ANSIWISE_ELEVATION_SECRET,
  type AnsiwisePorts, type ExtraAnswers,
} from "./ansiwise-run.kit.ts";
import { placeAnsiwiseStep, enableAnsiwiseServiceStep } from "./place-ansiwise.step.ts";
import { declareTailnetAddressStep } from "./deploy-slave.address.ts";
import { masterCheckoutsScript, SLAVE_API_PORT } from "./deploy-slave.remote.ts";
import { refreshCheckoutStep } from "./live-cluster.kit.ts";
import { placeInputStep, dropInputStep, dropInputCleanup } from "./deploy-slave.input.ts";
import { rejoinStep, readMembershipStep } from "./tailnet.kit.ts";
import { createMgmtStep, removeSlaveCleanup } from "./deploy-slave.mgmt.ts";
import { clusterShortName, resolveClusterMarking, writeClusterMarking, type ClusterMarking, writeClusterMarkingOnBranch } from "../../inventory/cluster-marking.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { attestTargetStep } from "./deploy-slave.attest.ts";
import { verifySlaveStep, registerStep } from "./deploy-slave.verify.ts";

// "cluster-deploy-slave" — the Run that turns a READY (adopted) server into a live slave, over the
// deployment PROGRAMS of the machine's own catalogue (digita-deploy ansiwise/programs/), each
// driven over `ansiwise-rest serve` and proven by a dry run the machine's gate then admits the real run
// against. Two hosts: the MASTER cuts the slave's install branch (deploy-slave-branch) and takes
// its registration (register-slave); the SLAVE is built by the same three machine-layer programs
// every cluster is (deploy-host, deploy-cluster, deploy-platform-services), joins the private network with a
// credential the master mints, and emits the one credentials file the registration is made from.
//
// Before the first of those programs, place-ansiwise puts the binary they are driven through, the
// catalogue they are read from and the platform checkout they act on onto the slave: a machine
// adopted from bare metal carries none of them, and every program step would otherwise open a
// conversation with a command that is not there. After the last of them and after the join,
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
  /** Explicit ordinal — used by a retry after a failed run (it is never recycled) or to adopt
   *  a manually provisioned slave. Omitted ⇒ attest-target allocates max(slave_id)+1. */
  slaveId: z.number().int().positive().optional(),
});
export type DeploySlaveParams = z.infer<typeof DeploySlaveParams>;

export type { DeploySlavePorts };

/** The answers the machine-layer programs declare that neither the inventory nor the cluster map
 *  can state, asked for at approve and carried to the steps as `activation-input:<answer>`. All
 *  three may stay blank — a blank input is dropped at approve and the program's own default (or its
 *  refusal, by name) decides. Shared with redeploy's slave arm, which runs the same programs.
 *
 *  WHAT THE MAP STATES IS NOT ASKED FOR. The certificate authority and its mailbox stood here until
 *  2026-08-28 and were asked of a person for every machine, although one installation registers with
 *  one authority and the map had carried its answer since the master was installed. They come from
 *  slaveMachineAnswers now. What is left is what only THIS machine can say: the range it shares, and
 *  the storage bolted to it. */
export const SLAVE_MACHINE_INPUTS: { field: string; label: string }[] = [];

/** deploy-slave's own inputs: the machine-layer set plus the one answer only the branch cut takes. */
export const SLAVE_INSTALL_INPUTS = [...SLAVE_MACHINE_INPUTS];

/** Register [cleanup] before the step runs — for a step whose body is a generic program step and
 *  cannot know which compensating action the RUN KIND arms around it. Registered before the first
 *  mutating act, because a step that dies halfway leaves a partial resource only the cleanup can
 *  compensate (every cleanup here tolerates already-absent state, so early registration is safe). */
function armed(cleanup: Cleanup | undefined, step: Step): Step {
  if (!cleanup) return step;
  return {
    ...step,
    run: async (ctx) => {
      ctx.registerCleanup(cleanup);
      await step.run(ctx);
    },
  };
}

/** Answers the DEF is authoritative for on the machine-layer programs, read off the slave's OWN
 *  cluster map — the record mark-slave wrote earlier in the same run (and re-reads on a redeploy).
 *  books_fqdn is the master's domain (deploy-cluster/-gitops default it to the machine's own,
 *  which for a slave would install a second books keeper); build_plane_fqdn is the map's, whose
 *  self-naming form the programs read the same way as "this machine". */
/** What is asked of a machine to find the disk its volumes belong on. `findmnt` reads the kernel's
 *  own mount table, so what comes back is what is mounted and not what somebody meant to mount. */
/** The line separator, as a call rather than a literal. */
function chr10(): string { return String.fromCharCode(10); }

/** THE MACHINE DOES THE DISCARDING, AND THAT IS NOT AN OPTIMISATION. What comes back of a command
 *  is its TAIL, and a cluster's own mount table runs to hundreds of lines — every pod subpath the
 *  container runtime binds appears in it. Asked unfiltered, the one line that matters sits at the
 *  top and scrolls out: the same machine answered "/mnt/data" before its cluster was installed and
 *  "no separate data disk" minutes later, with the disk still mounted (apps4, 2026-08-29). What is
 *  left here is short whatever the machine runs, and the reading below judges it again. */
export const DATA_DISK_COMMAND =
  "findmnt -rno TARGET,SOURCE | grep ' /dev/' | grep -v -e '^/ ' -e '^/boot' -e '^/snap' -e '^/var/snap' | head -20";

/** WHERE THE VOLUMES OF A CLUSTER BELONG: the machine's separate disk, if it carries one.
 *
 *  THIS WAS ASKED OF A PERSON AND THEREFORE FORGOTTEN. The three rows that place the volumes —
 *  require_storage_mount, create_storage_directory, link_storage_path — each do nothing when the
 *  answer is empty, and empty is what a form gets when nobody types a path. Measured on a master on
 *  2026-08-29: 29 GB of cluster data on the 124 GB boot disk while a 1 TB disk sat mounted at
 *  /mnt/data with 2.1 MB on it. Nothing reported it, because nothing had been asked.
 *
 *  WHAT COUNTS AS THAT DISK: a mount of a real block device that is neither the root filesystem nor
 *  a place the system keeps for itself. The boot partition is not it, and neither are the mounts the
 *  container runtime makes under a snap's tree — those are the cluster's own volumes appearing as
 *  mounts, and taking one would point the storage at itself. The shallowest remaining one wins,
 *  because a machine built with one data disk has exactly one and a nested mount is a part of it.
 *
 *  A MACHINE WITH NO SUCH DISK IS ANSWERED WITH NOTHING, and the three rows then skip exactly as
 *  they did before this existed. */
export function dataDiskFrom(mountTable: string): { storage_mount: string; storage_subdirectory: string } | undefined {
  const candidates: string[] = [];
  for (const line of mountTable.split(chr10())) {
    const [target, source] = line.trim().split(/\s+/);
    if (target === undefined || source === undefined) continue;
    if (!source.startsWith("/dev/")) continue;
    if (target === "/" || target.startsWith("/boot") || target.startsWith("/var/snap") || target.startsWith("/snap")) continue;
    candidates.push(target);
  }
  if (candidates.length === 0) return undefined;
  const shallowest = candidates.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]!;
  // NAMED, NOT THE MOUNT ITSELF. The link the cluster follows points at a directory ON that disk, so
  // the disk keeps a name of its own and what the cluster wrote is told apart from what else is
  // there — a mount pointed at directly is one nobody can put anything else on.
  return { storage_mount: shallowest, storage_subdirectory: `${shallowest}/microk8s-storage` };
}

/** WHERE THIS MACHINE CAN BE REACHED, each address on its own as a `/32`.
 *
 *  THE MASTER'S ADDRESSES USED TO STAND IN A SLAVE'S MAP. `global.nodeCidrs` is what the gate
 *  sandbox draws its fence from, and a slave's whole map is composed from the master's — so the
 *  fence around a slave named the master's machine and left the slave's own outside it. Nothing
 *  reported it: the list was not empty, so the reader that refuses to render on an empty list had
 *  something to render.
 *
 *  THE SAME READING measure_host_addresses takes on a master, because the two write one file and a
 *  second lifting of the same fact must not read it a second way: every global-scope IPv4 address
 *  the kernel lists, as a `/32` and not as the prefix it was configured with, minus loopback and
 *  minus the interfaces a container network makes and renumbers on its own schedule.
 *
 *  A /32 and not the interface's prefix: a node configured 10.1.1.7/24 shares that /24 with every
 *  other host on the wire, and what a boundary needs is the machine, not the segment. */
export const HOST_ADDRESS_COMMAND = "ip -4 -o addr show scope global";

/** The beginnings of the names of interfaces that are not the machine's — the same nine
 *  deploy-branch's own measure_host_addresses row passes over. Matched as PREFIXES, because every
 *  one of these families numbers or hashes its own. */
export const NOT_THE_MACHINES_INTERFACES = [
  "cali", "vxlan.calico", "tunl", "flannel", "cni", "docker", "br-", "veth", "kube-ipvs",
];

/** The `/32`s in a listing, in the order the kernel gave them.
 *
 *  Read by POSITION FROM THE `inet` MARKER and not by a fixed index, because the fields in front of
 *  it differ between an interface with a label and one without. */
export function hostAddressesFrom(listing: string): string[] {
  const found: string[] = [];
  for (const line of listing.split(chr10())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const at = fields.indexOf("inet");
    if (at < 0 || at + 1 >= fields.length) continue;
    const device = fields[1]!;
    if (NOT_THE_MACHINES_INTERFACES.some((prefix) => device.startsWith(prefix))) continue;
    const address = fields[at + 1]!.split("/")[0]!;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue;
    // Loopback is every host's own and identifies none of them, so a fence that carved it out would
    // carve out the caller's too.
    if (address.startsWith("127.")) continue;
    const cidr = `${address}/32`;
    if (!found.includes(cidr)) found.push(cidr);
  }
  return found;
}

/** WHO THE BRANCH CUT COMMITS AS. One thing on every machine of this platform: `installer@` and the
 *  machine's own domain, which the run already holds — so it is composed rather than asked, and a
 *  person is not offered a field whose only right answer is the one thing already known.
 *
 *  It reaches git_identity's `email_answer`, and what it decides is the address in the log of the
 *  branch this run cuts. Nothing authenticates with it. */
export function slaveBranchAnswers(target: SlaveTarget): ExtraAnswers {
  return async (ctx) => {
    const { domain } = target.resolve(ctx.db);
    return { committer_email: `installer@${domain}` };
  };
}

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

/** deploy-host's operator_public_key: the public half of the key this manager installed at
 *  adopt (the newest ssh_key credential's stored public line). The program re-installs it
 *  idempotently and proves sshd would accept it. A row without one (an adopt from before the
 *  public line was stored) sends nothing, and the program refuses the missing answer by name. */
/** deploy-host's two checkout answers: WHICH repository the platform tree comes from, and WHICH
 *  branch it stands on. The one extra a machine-layer program takes that nothing on the machine can
 *  answer, because the checkout it would be read from is what the program establishes.
 *
 *  THE BRANCH IS THE CLUSTER'S OWN, never the trunk. Every machine's live tree stands on its
 *  installation branch: that is what its reconciler follows and what release-cluster and
 *  regenerate-branch read the release out of (`clusters/active/<fqdn>.yaml` exists on that branch and
 *  on no other). Answering `master` here would move the live tree onto the trunk — measured on apps3,
 *  whose tree stood on master for twelve hours while ArgoCD went on reconciling from origin, and whose
 *  release-cluster then refused because the file it records into was not there.
 *
 *  A machine being born as a master is the one case that takes `master`, and it is not this manager's
 *  case: it has no cluster row yet and is installed by ansiwise-client, which answers this itself. */
/** Everything deploy-host is owed that the machine cannot answer itself: the two checkout answers
 *  above and the public half of the key this manager reaches the machine with. ONE `extra`, because
 *  a program step takes one — and both run kinds that drive deploy-host owe the machine all three.
 *
 *  Note the DIFFERENT sources, which is why they are composed rather than read from one place: the
 *  repository is this installation's setting, the branch is the target cluster's row, and the key is
 *  a sealed credential. */
export function hostAnswers(target: SlaveTarget, serverId: string, ports: DeploySlavePorts): ExtraAnswers {
  const checkout = checkoutAnswers(target, ports);
  const key = operatorKeyAnswer(serverId);
  return async (ctx) => ({ ...(await checkout(ctx)), ...(await key(ctx)) });
}

export function checkoutAnswers(target: SlaveTarget, ports: DeploySlavePorts): ExtraAnswers {
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
    const { domain } = target.resolve(ctx.db);
    return { platform_repo: origin, platform_branch: domain };
  };
}

export function operatorKeyAnswer(serverId: string): ExtraAnswers {
  return async (ctx) => {
    const key = (await ctx.creds.list({ serverId, kind: "ssh_key" })).at(-1);
    return key?.publicKey !== undefined ? { operator_public_key: key.publicKey } : {};
  };
}

/** The install step list BOTH cluster run kinds run: deploy-slave takes a READY server through it, and
 *  redeploy re-runs it against a slave that is already live. `mode` decides two things. Per step,
 *  whether the compensating action that would UNDO it is armed — never on a redeploy, where every
 *  one of them undoes a WORKING slave. And whether the two BIRTH acts run at all: the branch cut
 *  (a slave's branch is cut once; the program's push takes no force, so re-cutting a standing
 *  branch is refused rather than rewritten) and the tailnet join (the join program deliberately
 *  discards the node key first, which on a LIVE slave would rotate the address the cluster map
 *  states — repairing a live slave's membership is the tailnet run kinds' own job). */
export function deploySlaveSteps(input: SlaveInstallInput, ports: DeploySlavePorts & AnsiwisePorts): Step[] {
  const { target, mode } = input;
  const sid = target.serverId;
  const redeploying = mode === "redeploy";
  const machineAnswers = slaveMachineAnswers(target, ports);
  return [
    attestTargetStep(input),
    {
      name: "slave-preflight",
      title: "Preflight the slave (hard policy)",
      run: async (ctx) => {
        // The adopt checks re-run under the SLAVE-HARD policy (an adoptable box may still be
        // un-deployable): every severity becomes hard, and bound 80/443 / missing snapd —
        // warnings at adopt time — are promoted to failures (preflight.ts SLAVE_FAIL_ON_WARN).
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
        // Merge under its own key — never clobber the adopt report (hostKey pins ctx.ssh!).
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
    ...(redeploying ? [] : ([
      {
        name: "prepare-checkouts",
        title: "Stand the master's two checkouts where the branch cut reads and cuts",
        run: async (ctx) => {
          // The two git states deploy-slave-branch reads and refuses to establish itself: the LIVE
          // checkout on the head of the master's own install branch (the program copies the
          // master's map out of its committed state — a stale tree hands every slave an old map),
          // and the WORK checkout standing on the product branch (the program's git_branch row
          // refuses a checkout standing anywhere else rather than moving it). Runs under the
          // git-branch lock on the master's own domain, which this run already claims.
          const { domain } = target.resolve(ctx.db);
          const master = loadMaster(ctx.db);
          const masterFqdn = masterFqdnOf(ctx.db, master);
          const mSession = await ctx.ssh(master.id); // the AUX target — declared in `targets`
          const cap = await remoteScriptCapture(ctx, mSession, "prepare-checkouts",
            masterCheckoutsScript({ masterFqdn, slaveFqdn: domain }), { timeoutMs: 5 * 60_000 });
          const live = /^LIVE_HEAD (\S+)$/m.exec(cap.stdout)?.[1];
          const work = /^WORK_HEAD (\S+)$/m.exec(cap.stdout)?.[1];
          if (cap.result.code !== 0 || !live || !work) {
            throw errValidation(
              `could not stand the master's checkouts for the branch cut (exit ${cap.result.code}) — the live tree must ` +
              `hold origin/${masterFqdn}'s head and the work tree the product branch; see the run log, fix the master's ` +
              "checkouts, then retry the run",
            );
          }
          ctx.checkpoint({ liveHead: live, workHead: work });
          ctx.log("meta", `master checkouts ready: live on ${masterFqdn} @ ${live}, work on the product branch @ ${work}`);
        },
      },
      // The cut itself: two answers (the slave's domain and its stage, both the inventory's),
      // everything else read from the master's books by the program — a value typed a second time
      // is a value that can disagree with itself. The optional committer identity rides approve.
      ansiwiseProgramStep(target, "deploy-slave-branch", ports, { onMaster: true, extra: slaveBranchAnswers(target) }),
    ] satisfies Step[])),
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
        const slaveMarking: ClusterMarking = {
          ...installation,
          // WHAT THIS MACHINE IS, and nothing else.
          fqdn: domain,
          name: shortName,
          stage,
          role: "slave",
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
        const { changed } = await writeClusterMarking(repo, slaveMarking, ctx.runId);
        // AND ON THE MACHINE'S OWN BRANCH, which is the one its checkout stands on. The books branch
        // is where an installation keeps its maps and where one cluster reads about another; a
        // machine reads ITS OWN out of the tree beside it, and a slave's was on the books alone —
        // its machine layer stopped at "is not on this host" asking for the secret store's address
        // (apps4, 2026-08-29). One map, written twice, from one value in one act.
        await writeClusterMarkingOnBranch(repo, slaveMarking, domain, ctx.runId);
        ctx.log("meta", changed
          ? `${clusterMapPath(domain)} on ${repo.booksBranch} now marks ${slaveMarking.name}: role slave, stage ${stage}, ${apiHost}:${SLAVE_API_PORT}, build plane ${slaveMarking.buildPlaneFqdn}`
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
    // the slave's own surface, each dry-proven then run. deploy-host makes the box workable (the
    // packages, the key proof) and must precede the checkout refresh, which needs git.
    ansiwiseProgramStep(target, "deploy-host", ports, { extra: hostAnswers(target, sid, ports) }),
    // The programs read /srv/hostyour-cloud as it stands and deliberately fetch nothing — this is
    // what brings the slave's checkout onto the branch the cut just pushed. The checkout itself was
    // placed above; this step is what moves it onto that branch's head.
    refreshCheckoutStep(target),
    // The two values a cluster keeping no books reads off its machine, composed out of what this
    // manager already holds and put there for the length of the run. It stands HERE because the
    // first row that reads one of them is deploy-cluster's containerd mirror; drop-input below
    // takes it away once the last one has run.
    placeInputStep(target, ports),
    armed(redeploying ? undefined : microk8sResetSlaveCleanup,
      ansiwiseProgramStep(target, "deploy-cluster", ports, { extra: machineAnswers })),
    // deploy-platform-services also declares elevation_password — the ENGINE fills that one from the
    // password the POST carries beside the answers; sending it as an answer is refused.
    ansiwiseProgramStep(target, "deploy-platform-services", ports, { extra: machineAnswers }),
    // Both programs that read them have run.
    dropInputStep(target),
    ...(redeploying ? [] : [
      // The join: mint on the master, carry the credential over the session, spend it in ONE
      // program run on the slave — the tailnet kit's own step, because a first join is the same
      // act (the program's logout-first is a no-op on a machine that was never on the network).
      // remove-slave is armed here, before the FIRST master-side per-slave state (the coordinator
      // user) exists; it also covers everything create-mgmt makes later, and it tolerates absent
      // state, so early registration is safe.
      armed(removeSlaveCleanup(ports), rejoinStep(target, sid, ports)),
      // The reading that describes a managed slave — without it the row keeps adopt's "no client"
      // reading about the machine the master's ArgoCD and Vault are talking to.
      readMembershipStep(sid),
    ]),
    // Which address that is, asked of the one that handed it out. It is OUTSIDE the guard above
    // because a redeploy does not join again and is still the run that has to notice an address
    // that moved — and it is before the step below because that step is the first thing to dial it.
    declareTailnetAddressStep(target, sid, ports),
    // The machine's own surface, switched on. It stands HERE and not beside the placement at the
    // head of the list because the address it binds is the one the join above gave the machine —
    // and on a redeploy the machine already holds it, so the step measures a standing service and
    // places nothing. Everything before this reached the machine over a held-open session; this is
    // what makes the machine reachable without one, across a restart.
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

export function makeDeploySlaveDef(ports: DeploySlavePorts & AnsiwisePorts): RunDefinition<DeploySlaveParams> {
  return {
  kind: "cluster-deploy-slave",
  paramsSchema: DeploySlaveParams,
  mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted where the run definitions are assembled at boot
  plan: async (params, { db }) => {
    const slave = loadServer(db, params.serverId);
    const master = loadMaster(db);
    if (master.id === slave.id) throw errValidation("the master cannot be deployed as a slave");
    const stepDefs = deploySlaveSteps(installInput(params), ports);
    // The address the run will actually dial. Neither target below states a transport, so the slave
    // resolves the way every run always has — and the card must name the address the first connect
    // line in the log names, or an operator approves one address and gets the other.
    const dialled = resolveTransport(slave, "default");
    return {
      kind: "cluster-deploy-slave",
      targetKind: "server",
      targetId: params.serverId,
      summary:
        `Deploy "${slave.name}" (${dialled.host}) as ${params.stage} slave ${params.domain}` +
        `${params.slaveId !== undefined ? ` (slaveId ${params.slaveId})` : ""} [tier ${params.tier}]: ` +
        `${stepDefs.length} steps over two hosts — the slave (the machine-layer programs on its own ansiwise surface) ` +
        `and the master "${master.name}" (branch cut + registration).`,
      steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
      // BOTH hosts are declared so ctx.ssh(slave) AND ctx.ssh(master) pass the plan gate;
      // only the slave is owned (server:<slave> lock derives from ownsHost).
      targets: [
        { serverId: slave.id, ownsHost: true, label: `${slave.name} (slave)` },
        { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
      ],
      // The locks beyond the derived server:<slave>: both touched git branches (the slave's
      // install branch is cut + refreshed onto; the master's branch is what the live checkout is
      // brought onto and the books branch the map lands on), the master's Vault surface
      // (register-slave's mounts/policies/roles), and the master's kube-apiserver (the handoff
      // wait + verify reads). Key "m" and no per-cluster key, because the platform has ONE Vault
      // and it sits on the master: a second deploy-slave (or any other master-vault Run)
      // therefore serializes instead of interleaving Vault surgery.
      locks: [
        { resource: "git-branch", key: params.domain },
        { resource: "git-branch", key: masterFqdnOf(db, master) },
        { resource: "master-vault", key: "m" },
        { resource: "master-kube", key: "m" },
      ],
      warnings: [
        `The machine layer installs over the slave's own ansiwise surface — the base install (deploy-cluster) runs ~25 minutes detached on the machine, and a retry of its step re-attaches instead of starting a second run.`,
      ],
      // The programs raise their commands to root with a password the CALLER hands over per run
      // (the installation's ansiwise.yaml: password_from_caller) — collected at approve, held in
      // memory, sent with each POST /runs, persisted nowhere.
      requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      requiredInputs: SLAVE_INSTALL_INPUTS,
    };
  },
  steps: (params) => deploySlaveSteps(installInput(params), ports),
  // The compensating actions the install steps register (resolved by NAME from the persisted
  // __cleanups, run in reverse registration order on an explicit abort-with-cleanup):
  // remove-slave (armed by the join, before the first master-side per-slave state) →
  // microk8s-reset-slave (deploy-cluster) → drop-input (place-input, which takes the two placed
  // values off a machine whose run died before drop-input could) → remove-slave-marking (mark-slave, armed first and so
  // run last — by then remove-slave has already dropped the map's slave part itself, FIRST, which
  // is that program's own contract, so the last cleanup finds nothing left to drop). attest-target,
  // slave-preflight and the checkout steps arm nothing: the install branch on the remote is the
  // operator's to keep, and the binary, the catalogue and the checkout place-ansiwise puts on the
  // machine are what a retry resumes onto — a cleanup that removed them would buy a second download
  // and two more clones.
  cleanups: () => [microk8sResetSlaveCleanup, removeSlaveCleanup(ports), removeSlaveMarkingCleanup(ports), dropInputCleanup],
  onTerminal: (status, { db, params }) => {
    if (status === "succeeded") return; // the register step set the terminal states
    const sid = String(params.serverId);
    const domain = String(params.domain);
    // Free the server (provisioning→ready; never clobber another status) and park the
    // cluster row back at `planned` KEEPING its allocated slaveId — the ordinal is never
    // recycled (clusters_slave_id_uq); a retry resumes the row (or passes slaveId explicitly).
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
