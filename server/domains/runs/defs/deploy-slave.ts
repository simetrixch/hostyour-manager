import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Step, StepCtx, Cleanup, RunDefinition } from "../../../executor/types.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { STAGE, CLUSTER_TIER } from "../../../../shared/enums.ts";
import { errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { readAnsiwisePin } from "../../inventory/ansiwise-pin.ts";
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
import { placeAnsiwise, isServiceAddress, VERSION_PLACEHOLDER, ANSIWISE_SERVICE_PORT } from "./place-ansiwise.ts";
import { masterCheckoutsScript, SLAVE_API_PORT } from "./deploy-slave.remote.ts";
import { refreshCheckoutStep } from "./cluster-release.kit.ts";
import { rejoinStep, readMembershipStep } from "./tailnet.kit.ts";
import { createMgmtStep, removeSlaveCleanup } from "./deploy-slave.mgmt.ts";
import {
  clusterShortName, clusterMarkingPath, resolveClusterMarking, writeClusterMarking,
  type ClusterMarking,
} from "../../inventory/cluster-marking.ts";
import { attestTargetStep } from "./deploy-slave.attest.ts";
import { verifySlaveStep, registerStep } from "./deploy-slave.verify.ts";

// "deploy-slave" — the Run that turns a READY (adopted) server into a live slave, over the
// deployment PROGRAMS of the machine's own catalogue (digita-deploy ansiwise/programs/), each
// driven over `ansiwise serve` and proven by a dry run the machine's gate then admits the real run
// against. Two hosts: the MASTER cuts the slave's install branch (deploy-slave-branch) and takes
// its registration (register-slave); the SLAVE is built by the same three machine-layer programs
// every cluster is (deploy-host, deploy-cluster, deploy-gitops), joins the private network with a
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

/** The answers the machine-layer programs declare and neither the inventory nor the cluster map
 *  can state, asked for at approve and carried to the steps as `activation-input:<answer>`. The
 *  four optional ones may stay blank — a blank input is dropped at approve and the program's own
 *  default (or its refusal, by name) decides. Shared with redeploy's slave arm, which runs the
 *  same machine-layer programs. */
export const SLAVE_MACHINE_INPUTS = [
  { field: "letsencrypt_email", label: "The mailbox the certificate authority writes to before a certificate expires" },
  { field: "letsencrypt_server", label: "The ACME directory this installation registers with (staging to rehearse, production to serve)" },
  { field: "lan_cidr", label: "The IPv4 range this machine shares with the other clusters — blank when it shares none" },
  { field: "storage_path", label: "Where the machine's separate storage is mounted — blank when it has none" },
  { field: "storage_directory", label: "The directory under that mount for the cluster's volumes — blank for the snap's default" },
];

/** deploy-slave's own inputs: the machine-layer set plus the one answer only the branch cut takes. */
export const SLAVE_INSTALL_INPUTS = [
  { field: "committer_email", label: "The mailbox the slave's generated branch commits are made under — blank for the program's own placeholder" },
  ...SLAVE_MACHINE_INPUTS,
];

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
 *  books_cluster is the master's domain (deploy-cluster/-gitops default it to the machine's own,
 *  which for a slave would install a second books keeper); build_plane is the map's, whose
 *  self-naming form the programs read the same way as "this machine".
 *
 *  Shared with release's slave arm, which drives the same two machine-layer programs against the same
 *  slave and owes them the same two answers — two readings of one map is how the run kinds would come
 *  to hand one slave different books. */
export function slaveMachineAnswers(target: SlaveTarget, ports: DeploySlavePorts): ExtraAnswers {
  return async (ctx) => {
    const { domain } = target.resolve(ctx.db);
    const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
    const books = marking.booksCluster ?? marking.master;
    return {
      ...(books !== undefined ? { books_cluster: books } : {}),
      build_plane: marking.buildPlaneFqdn,
    };
  };
}

/** deploy-host's operator_public_key: the public half of the key this controller installed at
 *  adopt (the newest ssh_key credential's stored public line). The program re-installs it
 *  idempotently and proves sshd would accept it. A row without one (an adopt from before the
 *  public line was stored) sends nothing, and the program refuses the missing answer by name. */
function operatorKeyAnswer(serverId: string): ExtraAnswers {
  return async (ctx) => {
    const key = (await ctx.creds.list({ serverId, kind: "ssh_key" })).at(-1);
    return key?.publicKey !== undefined ? { operator_public_key: key.publicKey } : {};
  };
}

/** WHERE the machine fetches the pinned binary from. Which release surface an installation takes its
 *  binary from is the installation's decision, exactly as the command that serves the programs is;
 *  the VERSION never is — the placement fills `<version>` in from the pin. */
function requireDownloadUrl(ports: AnsiwisePorts): string {
  if (!ports.ansiwiseDownloadUrl) {
    throw errNotConfigured(
      "ANSIWISE_DOWNLOAD_URL is not configured — this step places the ansiwise binary on the machine, and where a " +
      `version of it is fetched from is the installation's decision. Set ANSIWISE_DOWNLOAD_URL to that address with ` +
      `${VERSION_PLACEHOLDER} standing where the version goes, e.g. ` +
      `https://example.invalid/ansiwise/${VERSION_PLACEHOLDER}/ansiwise-linux-amd64`,
    );
  }
  return ports.ansiwiseDownloadUrl;
}

/** WHICH REPOSITORY the programs come from. It is not the platform repository and cannot be derived
 *  from it — the two trees are named apart in the file that pins this platform's versions — so an
 *  installation states it, the way it states where the binary is fetched from. */
function requireCatalogUrl(ports: AnsiwisePorts): string {
  if (!ports.ansiwiseCatalogUrl) {
    throw errNotConfigured(
      "ANSIWISE_CATALOG_URL is not configured — this step places the program catalogue on the machine, and which " +
      "repository carries it is the installation's decision. It is NOT the platform repository: that one is the " +
      "material the programs act on and carries no ansiwise/ tree. Set ANSIWISE_CATALOG_URL to the clone address of " +
      "the installation repository holding ansiwise.yaml and ansiwise/programs/, e.g. " +
      "https://github.com/example/example-deploy.git",
    );
  }
  return ports.ansiwiseCatalogUrl;
}

/** The address the machine clones the platform checkout from. Built where the platform repo port is
 *  built, from the same two settings, so the tree the manager writes and the tree the machine reads
 *  are one repository stated once. */
function requirePlatformRepoUrl(ports: DeploySlavePorts): string {
  if (!ports.platformRepoUrl) {
    throw errNotConfigured(
      "the platform repo is not configured — this step clones the platform checkout onto the machine, and without it " +
      "the deployment programs have nothing to act on. GITHUB_REPO names that repository",
    );
  }
  return ports.platformRepoUrl;
}

/** `place-ansiwise` — the binary, the catalogue and the platform checkout on a machine reached by
 *  THIS MANAGER. The placement itself (place-ansiwise.ts) takes a machine and values and is the same
 *  act wherever a machine is reached from; what stands here is the half only a manager can do —
 *  resolving a SlaveTarget into those values. The install branch comes off the cluster the target
 *  names, the account off the server row (`loadServer` refuses a server id this manager does not
 *  carry), the version off platform/versions.yaml on the trunk, and the three addresses off the
 *  installation's settings, each refused BY NAME while nothing has been asked of the machine yet.
 *
 *  A machine at its FIRST installation stands in no server row, so it cannot start THIS step, and
 *  nothing else places the CATALOGUE or the platform checkout on it: this and
 *  `enableAnsiwiseServiceStep` below are the only callers of `placeAnsiwise` there are.
 *  ansiwise-client places the BINARY on a bare machine of its own
 *  (session_transport.dart:63-71) and places neither of the other two.
 *  Keeping the resolution out here is what makes the placement itself demand nothing such a machine
 *  cannot state — the shape a first-install placement would have to satisfy, not one that runs. */
export function placeAnsiwiseStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-ansiwise",
    title: "Place the ansiwise binary and the program catalogue on the machine",
    run: async (ctx) => {
      const server = loadServer(ctx.db, target.serverId);
      await runPlacement(ctx, target, ports, server);
    },
  };
}

/** `enable-ansiwise-service` — the SAME placement, run again once the machine has the two facts a
 *  bare one has not got: an address in the tailnet to stand on, and the token file deploy-gitops
 *  wrote. It composes nothing: `placeAnsiwise` invokes `ansiwise install-service`, which is the one
 *  thing that knows the command the unit starts (place-ansiwise.ts, THE SERVICE COMPOSES NOTHING).
 *
 *  WHY IT IS A SECOND STEP AND NOT THE FIRST ONE, and the reason is about the MACHINE and not about
 *  the row. A machine cannot bind an address it does not hold, and it holds no tailnet address until
 *  the rejoin above put it on the network; the binary refuses every other one (`--listen` outside
 *  100.64.0.0/10). Nothing about the ROW changes in between: `tailnetHost` is typed on the inventory
 *  row when the server is created and is never probed (inventory/write.ts, "Stated here, never
 *  probed"), and `read-membership` writes `tailnetState` and `tailnetJson` and nothing else
 *  (runs/tailnet-probe.ts `recordTailnetReading`). The placement is measured, so everything the first
 *  step left standing is found standing and only the service is placed.
 *
 *  THE ADDRESS IS THE ONE THE MANAGER WILL DIAL, stated here and bound there: the server row's
 *  tailnetHost with ANSIWISE_SERVICE_PORT after it, which is exactly what an `{ kind: "address" }`
 *  wire (adapters/ansiwise/port.ts) is opened on. Reading it off the machine instead would make the
 *  address the service stands on and the address the manager dials two readings of one value. What
 *  the placement DOES read off the machine is the address the standing unit already starts on, and it
 *  reads it to find out whether it has to install again — never to decide where the surface goes. */
export function enableAnsiwiseServiceStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "enable-ansiwise-service",
    title: "Enable the machine's own ansiwise service, so the surface outlives the session",
    run: async (ctx) => {
      const server = loadServer(ctx.db, target.serverId);
      if (!server.tailnetHost) {
        throw errValidation(
          `server ${server.name} carries no tailnet address, and the resident ansiwise service may stand on no other ` +
          "one — the manager presents its token in a plain HTTP header. tailnetHost is TYPED on the inventory row when " +
          "the server is created and no run ever writes it, so re-running the join or the membership reading cannot " +
          `fill it: put ${server.name}'s address in 100.64.0.0/10 on its row, then start this again`,
        );
      }
      // The shape, refused HERE because this is where the field is, and the field carries none of its
      // own: tailnetHost is `z.string().min(1)` (inventory/write.ts) and its other reader takes a
      // name (`mark-slave` below, an apiHost). The binary reads this one as four numbers, so a
      // MagicDNS name is legal on the row and refused on the machine — and the operator is told which
      // of the two he wrote.
      const listen = `${server.tailnetHost}:${ANSIWISE_SERVICE_PORT}`;
      if (!isServiceAddress(listen)) {
        throw errValidation(
          `server ${server.name} carries the tailnet address "${server.tailnetHost}", and the resident ansiwise service ` +
          "stands on four numbers or on nothing: ServiceInstallation reads the host as four numbers and refuses " +
          "everything outside 100.64.0.0/10 (ansiwise-cli lib/service_installation.dart), so a MagicDNS name is refused " +
          `on the machine after this has reached it. Put ${server.name}'s ADDRESS on its row — the cluster map's ` +
          "apiHost, which reads the same column, takes a name and is why one was accepted there",
        );
      }
      await runPlacement(ctx, target, ports, server, listen);
    },
  };
}

/** The manager's half of both steps: a SlaveTarget resolved into the values the placement takes, and
 *  the run's cached session made into the machine it reaches. `listen` is what tells the two apart —
 *  absent is a placement that leaves the unit alone, stated is one that leaves it running. */
async function runPlacement(
  ctx: StepCtx,
  target: SlaveTarget,
  ports: DeploySlavePorts & AnsiwisePorts,
  server: typeof servers.$inferSelect,
  listen?: string,
): Promise<void> {
  const { domain } = target.resolve(ctx.db);
  const request = {
    version: await readAnsiwisePin(requirePlatformRepo(ports)),
    downloadUrl: requireDownloadUrl(ports),
    catalogUrl: requireCatalogUrl(ports),
    ...(ports.ansiwiseCatalogToken !== undefined ? { catalogToken: ports.ansiwiseCatalogToken } : {}),
    repoUrl: requirePlatformRepoUrl(ports),
    branch: domain,
    user: server.sshUser,
    elevationPassword: requireElevationPassword(ctx),
    ...(listen !== undefined ? { listen } : {}),
  };
  const session = await ctx.ssh();
  const verdict = await placeAnsiwise({
    name: server.name,
    runScript: async (name, script, o) => {
      const cap = await remoteScriptCapture(ctx, session, name, script, o);
      return { code: cap.result.code, stdout: cap.stdout };
    },
    log: (line) => ctx.log("meta", line),
  }, request);
  ctx.checkpoint(verdict);
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

        // The pod (Calico) CIDR must be disjoint from the cluster LAN, or controller pods can't
        // route to the slave's LAN IP (the `dial …:16443 i/o timeout` blocker). Purely LOCAL — the
        // Controller already knows the cluster LAN (the /24 around the inventory lanHost) and the
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
      ansiwiseProgramStep(target, "deploy-slave-branch", ports, { onMaster: true }),
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
        const slaveMarking: ClusterMarking = {
          fqdn: domain,
          // Derived, never stored — the same rule the module states for every map.
          name: clusterShortName(domain),
          stage,
          role: "slave",
          // The slaves ApplicationSet SELECTS on this key — a slave map without it is invisible
          // to the generator, and the handoff below would wait on an Application that never comes.
          booksCluster: masterFqdn,
          // A slave pulls its images from wherever its master does. `buildPlane` is the derived
          // "is that me?", which for a slave whose build plane is its master is false — and true in
          // the one case the master IS the build plane and this slave shares its machine under a
          // second fqdn, where the two fqdns are still different names.
          buildPlane: masterMarking.buildPlaneFqdn === domain,
          buildPlaneFqdn: masterMarking.buildPlaneFqdn,
          master: masterFqdn,
          apiHost,
          apiPort: SLAVE_API_PORT,
          ...(masterMarking.unitApex !== undefined ? { unitApex: masterMarking.unitApex } : {}),
          ...(masterMarking.platformDomain !== undefined ? { platformDomain: masterMarking.platformDomain } : {}),
          ...(masterMarking.alertRecipients !== undefined ? { alertRecipients: masterMarking.alertRecipients } : {}),
          ...(masterMarking.catalogRepo !== undefined ? { catalogRepo: masterMarking.catalogRepo } : {}),
        };
        // Armed BEFORE the write. Dropping the slave part again is the inverse: it takes the
        // cluster out of the master's slaves ApplicationSet, whose finalizer then cascades the
        // teardown of the management plane. NEVER armed on a redeploy — that cascade against a
        // LIVE slave is exactly what must not happen.
        if (!redeploying) ctx.registerCleanup(removeSlaveMarkingCleanup(ports));
        const { changed } = await writeClusterMarking(repo, slaveMarking, ctx.runId);
        ctx.log("meta", changed
          ? `${clusterMarkingPath(domain)} on ${repo.booksBranch} now marks ${slaveMarking.name}: role slave, stage ${stage}, ${apiHost}:${SLAVE_API_PORT}, build plane ${slaveMarking.buildPlaneFqdn}`
          : `${clusterMarkingPath(domain)} already states this marking — nothing to commit`);
        ctx.checkpoint({ branch: domain, apiHost, changed });
      },
    },
    // The binary every program act below is spoken to through, the catalogue those programs are read
    // from, and the platform checkout they act on. It stands FIRST among the machine-side acts
    // because none of them can run without all three: `ansiwise serve` is a binary reading a
    // catalogue, and a machine at its first installation carries none of them. Idempotent by
    // measurement, which is what lets a redeploy run the same step against a machine that carries them.
    placeAnsiwiseStep(target, ports),
    // ---- the machine layer, exactly as every cluster gets it: the three deployment programs on
    // the slave's own surface, each dry-proven then run. deploy-host makes the box workable (the
    // packages, the key proof) and must precede the checkout refresh, which needs git.
    ansiwiseProgramStep(target, "deploy-host", ports, { extra: operatorKeyAnswer(sid) }),
    // The programs read /srv/hostyour-cloud as it stands and deliberately fetch nothing — this is
    // what brings the slave's checkout onto the branch the cut just pushed. The checkout itself was
    // placed above; this step is what moves it onto that branch's head.
    refreshCheckoutStep(target),
    armed(redeploying ? undefined : microk8sResetSlaveCleanup,
      ansiwiseProgramStep(target, "deploy-cluster", ports, { extra: machineAnswers })),
    // deploy-gitops also declares elevation_password — the ENGINE fills that one from the
    // password the POST carries beside the answers; sending it as an answer is refused.
    ansiwiseProgramStep(target, "deploy-gitops", ports, { extra: machineAnswers }),
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
        const appName = `${clusterShortName(domain)}-apps`;
        const deadline = Date.now() + APP_SYNC_TIMEOUT_MS;
        for (;;) {
          let sync = "";
          const r = await mSession.exec(`sudo -n microk8s kubectl -n argocd get application ${appName} -o jsonpath={.status.sync.status}`, {
            signal: ctx.signal,
            timeoutMs: 30_000,
            onStdout: (l) => {
              sync += l.trim();
              ctx.log("stdout", l);
            },
            onStderr: (l) => ctx.log("stderr", l),
          });
          if (r.code === 0 && sync === "Synced") break;
          if (Date.now() >= deadline) {
            throw errValidation(`Application ${appName} did not reach Synced within ${APP_SYNC_TIMEOUT_MS / 60_000} min — check the master's ArgoCD (slaves-appset) and the pushed map ${clusterMarkingPath(domain)}`);
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
    verifySlaveStep(target),
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
  kind: "deploy-slave",
  paramsSchema: DeploySlaveParams,
  mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted at registry boot
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
      kind: "deploy-slave",
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
  // microk8s-reset-slave (deploy-cluster) → remove-slave-marking (mark-slave, armed first and so
  // run last — by then remove-slave has already dropped the map's slave part itself, FIRST, which
  // is that program's own contract, so the last cleanup finds nothing left to drop). attest-target,
  // slave-preflight and the checkout steps arm nothing: the install branch on the remote is the
  // operator's to keep, and the binary, the catalogue and the checkout place-ansiwise puts on the
  // machine are what a retry resumes onto — a cleanup that removed them would buy a second download
  // and two more clones.
  cleanups: () => [microk8sResetSlaveCleanup, removeSlaveCleanup(ports), removeSlaveMarkingCleanup(ports)],
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
