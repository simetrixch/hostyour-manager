import { eq, and, sql } from "drizzle-orm";
import type { Step } from "../../../executor/types.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { clsId } from "../../../kernel/ids.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { clusterShortName } from "../../inventory/cluster-marking.ts";
import { dnsProbeScript } from "./deploy-slave.remote.ts";
import { openDoor } from "./manager-key.kit.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./ansiwise-run.kit.ts";
import { loadServer, loadMaster } from "./deploy-slave.kit.ts";
import type { SlaveInstallInput } from "./deploy-slave.kit.ts";

// Step 0 of the shared slave install list — the fail-closed precondition pinned as the first step of
// every mutating run, and the one step that differs between the run kinds that run this list. It lives
// beside verify-slave/register (deploy-slave.verify.ts) rather than in the def, for the same reason
// they do: the 400-line file-size doctrine.
//
// What it establishes, in the order a failure is cheapest to discover:
//   1. the server NAME agrees with the domain's first label;
//   2. the cluster row is in a state this run kind may start on — the ONE place the arms disagree,
//      and the reason redeploy is a run kind instead of a boolean;
//   3. the wildcard *.<domain> resolves, and the machine answering is the machine this manager
//      recorded — reached through the DOOR (manager-key.kit.ts), so a machine this manager holds no
//      key for is met with the run's own password instead of being unreachable at step 0;
//   4. the ordinal is allocated and the rows flipped, in ONE transaction.
//
// FOUR CONCERNS IN ONE STEP, AND THEY STAY IN ONE STEP. Executor.skipStep refuses to wave through
// exactly the step named `attest-target` on a mutating definition, and it recognises it by that
// literal name (executor/guards.ts ATTEST_TARGET_STEP). A machine-identity check moved into a second
// step would carry no such protection: the refusal that stops a stranger VM on a recycled IP would
// become skippable from the Run screen with a one-line reason, and nothing in this repository would
// notice. So the step stays whole, and its length is the price of that.

export function attestTargetStep(input: SlaveInstallInput): Step {
  const { target, mode } = input;
  const sid = target.serverId;
  const redeploying = mode === "redeploy";
  return {
    name: "attest-target",
    title: "Attest the target (cluster state, DNS wildcard, machine identity)",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, sid);
      // The one-master invariant, asserted at step 0 because everything a SLAVE install does on the
      // master side — the branch cut, the map, the registration — is meaningless without one. It
      // also decides which shape the row assertions below take: the master taking the SLAVE PART is
      // the one target whose machine already carries a cluster, and that cluster is the row this run
      // works on rather than one it allocates.
      const master = loadMaster(ctx.db);
      const takingSlavePart = master.id === sid;

      // ---- name/domain agreement (the split-brain guard). The run keys the master-side
      // resources it drives over SSH on server.name (project/AppProject <name>, ES paths
      // prod/app/<name>/*, verify ns, --slave-remove), while the installer and every GitOps
      // reader derive that name from the FIRST DNS LABEL of the install branch/domain. If
      // they disagree, --slave-add registers under one name and the Application looks for the
      // other — AppProject missing, sync refused, ES never Ready — and the run only dies at
      // step 5/6 after ~20 min. Fail HERE, before anything is allocated or mutated.
      const domainName = clusterShortName(domain);
      if (server.name !== domainName) {
        throw errValidation(
          `slave name mismatch: server "${server.name}" vs domain "${domain}" — the domain's first label ("${domainName}") ` +
          `must equal the server name, because the installer names every per-slave resource after the domain label while ` +
          `this run keys them on the server name; fix: rename the inventory server to "${domainName}", or deploy to a ` +
          `domain starting with "${server.name}."`,
        );
      }

      // ---- cluster-state assertions + the idempotence probe. The cluster row
      // is the resume marker: same domain + same server + planned/provisioning ⇒ resume
      // (a failed run's onTerminal parks the row at `planned`, KEEPING its slaveId).
      const byDomain = ctx.db.select().from(clusters).where(eq(clusters.domain, domain)).get();
      const byServer = ctx.db.select().from(clusters).where(eq(clusters.serverId, sid)).get();
      if (byServer && byServer.domain !== domain) {
        throw errValidation(`server ${server.name} already carries cluster ${byServer.id} for ${byServer.domain} (one VM = one cluster)`);
      }
      if (byDomain && byDomain.serverId !== sid) {
        throw errValidation(`domain ${domain} is already claimed by cluster ${byDomain.id} on another server`);
      }
      // The redeploy arm re-reconciles a LIVE slave (cluster 'active') in place — the row stays
      // active and the server healthy throughout, so a failed redeploy never demotes a running
      // slave. A deploy of a machine that is not the master finds `redeploying` false, and its
      // active cluster is refused below.
      const redeployActive = redeploying && !!byDomain && byDomain.status === "active" && byDomain.serverId === sid;
      // THE MASTER TAKING THE SLAVE PART works on the cluster it already keeps. `clusters_server_uq`
      // holds one cluster per machine and the master's own is that one, so this run allocates no
      // ordinal, inserts no row and moves no status: what it adds is the slave PART of a machine
      // that already runs the master part, on the master's own domain and stage. The row it is
      // added to is therefore the live one, and a master whose cluster is anything else is a master
      // this run has nothing to add the part to.
      let mastersCluster: typeof clusters.$inferSelect | undefined;
      let resume: { clusterId: string; slaveId: number } | undefined;
      if (takingSlavePart) {
        if (!byDomain) {
          throw errValidation(`${server.name} holds the master role and this manager records no cluster for ${domain} — the slave part is added to the master's OWN cluster, and there is none to add it to`);
        }
        if (byDomain.status !== "active") {
          throw errValidation(`cluster ${byDomain.id} for ${domain} is '${byDomain.status}' — the master takes the slave part on its own LIVE cluster, which is the one its platform already runs from`);
        }
        mastersCluster = byDomain;
      } else if (byDomain) {
        const startable = byDomain.status === "planned" || byDomain.status === "provisioning" || redeployActive;
        if (!startable) {
          throw errValidation(`cluster ${byDomain.id} for ${domain} is '${byDomain.status}' — deploy-slave starts on a planned/provisioning cluster${byDomain.status === "active" ? "; rebuilding the machine layer of a LIVE cluster in place is the redeploy run kind" : ""}`);
        }
        if (byDomain.slaveId === null) throw errValidation(`cluster ${byDomain.id} has no slaveId — not a deploy-slave row; clean it up manually`);
        if (input.slaveId !== undefined && input.slaveId !== byDomain.slaveId) {
          throw errValidation(`slaveId mismatch: cluster ${byDomain.id} already holds slaveId ${byDomain.slaveId} (asked for ${input.slaveId}) — the ordinal is never recycled`);
        }
        resume = { clusterId: byDomain.id, slaveId: byDomain.slaveId };
      }
      // WHICH SERVER STATES THIS RUN MAY START ON, per path. The master sits at 'healthy' — its own
      // platform is running. A live slave being re-reconciled sits there too, and a resuming one at
      // ready/provisioning. A FRESH install admits 'bare' beside 'ready', because first contact is a
      // step of this run: a machine this manager has never logged in to is exactly what the list
      // below establishes, and refusing it here would demand a preparation no run kind performs.
      const okStatuses = takingSlavePart
        ? ["healthy"]
        : redeployActive ? ["healthy", "ready", "provisioning"] : resume ? ["ready", "provisioning"] : ["bare", "ready"];
      if (!okStatuses.includes(server.status)) throw errValidation(`server ${server.name} is '${server.status}' — must be ${okStatuses.join("/")}`);

      // ---- THE DOOR, and not ctx.ssh(): this is the first command the run sends, and on a machine
      // this manager has never logged in to there is no key to send it with. openDoor offers the key
      // where one stands and the machine takes it, the run's own password where none does, and
      // refuses every credential where the host key on the row and the host key on the wire disagree
      // (manager-key.kit.ts). The session it hands back is the one both readings below are taken
      // over, so both describe the machine the door was actually opened to.
      const session = await openDoor(ctx, ANSIWISE_ELEVATION_SECRET); // the slave (the run's ownsHost target)

      // ---- DNS wildcard *.<domain> resolves — HARD, because a machine layer installed under a name
      // nothing resolves is a cluster no certificate authority and no client can reach.
      // Resolvable-check ONLY: see dnsProbeScript — a NAT slave's wildcard resolves to the
      // shared public ingress, not the slave's own IP, so we never compare addresses.
      const dns = await remoteScriptCapture(ctx, session, "dns-probe", dnsProbeScript(domain), { timeoutMs: 30_000 });
      const resolved = /^DNS_WILDCARD (\S+)/m.exec(dns.stdout)?.[1];
      if (!resolved || resolved === "none") {
        throw errValidation(`DNS wildcard *.${domain} does not resolve — create the record first (behind NAT it points at the shared public ingress IP)`);
      }
      ctx.log("meta", `DNS wildcard *.${domain} resolves (→ ${resolved})`);

      // ---- machine identity: record on first deploy, verify after —
      // a stranger VM on a recycled IP hard-fails here, before anything destructive.
      const outcome = await attestMachineId({ db: ctx.db, session, serverId: sid, signal: ctx.signal, log: (l) => ctx.log("meta", l) });

      // ---- one localTx: allocate the ordinal, insert/flip the cluster row, flip the server.
      // clusters_slave_id_uq guarantees the ordinal is never reused across rebuild cycles. The
      // master's path writes nothing at all — its row is the live one and stays exactly as it is —
      // so it takes no transaction rather than an empty one.
      const result = mastersCluster
        ? { clusterId: mastersCluster.id, slaveId: mastersCluster.slaveId, resumed: true }
        : localTx(ctx, (tx) => {
          if (redeployActive && resume) {
            // Live re-reconcile: leave cluster 'active' + server 'healthy' untouched (the
            // idempotent steps reconcile the infra; register re-affirms at the end). No status
            // churn ⇒ a failed redeploy never demotes the running slave (onTerminal only frees
            // 'provisioning' rows).
            return { ...resume, resumed: true };
          }
          if (resume) {
            tx.update(clusters).set({ status: "provisioning" }).where(eq(clusters.id, resume.clusterId)).run();
            tx.update(servers).set({ status: "provisioning" }).where(and(eq(servers.id, sid), eq(servers.status, "ready"))).run();
            return { ...resume, resumed: true };
          }
          const maxRow = tx.select({ max: sql<number | null>`MAX(${clusters.slaveId})` }).from(clusters).get();
          const slaveId = input.slaveId ?? (maxRow?.max ?? 0) + 1;
          const clusterId = clsId();
          // Conceptually planned→provisioning; inserted directly at provisioning inside the
          // same tx (planeState stays at its 'absent' default until create-mgmt).
          tx.insert(clusters).values({ id: clusterId, serverId: sid, stage, domain, status: "provisioning", tier: input.tier ?? "rehearsal", slaveId }).run();
          tx.update(servers).set({ status: "provisioning" }).where(eq(servers.id, sid)).run();
          return { clusterId, slaveId, resumed: false };
        });
      ctx.checkpoint({ ...result, machineId: outcome.machineId, machineIdAction: outcome.action });
      ctx.log("meta", mastersCluster
        ? `${server.name} holds the master role and keeps its own live cluster ${result.clusterId} for ${domain} — the slave part is added to that cluster, so no ordinal is allocated and no row is moved`
        : redeployActive
          ? `re-reconciling LIVE slave ${server.name} in place (cluster ${result.clusterId}, slaveId ${result.slaveId} kept; status stays active) — idempotent re-run to pick up installer changes`
          : result.resumed
            ? `resuming cluster ${result.clusterId} for ${domain} (slaveId ${result.slaveId} kept — never re-allocated)`
            : `slave ${server.name} allocated ordinal ${result.slaveId} for ${domain} (cluster ${result.clusterId})`);
    },
  };
}
