import { eq, and, sql } from "drizzle-orm";
import type { Step } from "../../../executor/types.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { clsId } from "../../../kernel/ids.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { clusterShortName } from "../../inventory/cluster-marking.ts";
import { dnsProbeScript } from "./deploy-slave.remote.ts";
import { loadServer, loadMaster } from "./deploy-slave.kit.ts";
import type { SlaveInstallInput } from "./deploy-slave.kit.ts";

// Step 0 of the shared slave install list — the fail-closed precondition pinned as the first step of
// every mutating run, and the one step that differs between the two verbs that run this list. It lives
// beside verify-slave/register (deploy-slave.verify.ts) rather than in the def, for the same reason
// they do: the 400-line file-size doctrine.
//
// What it establishes, in the order a failure is cheapest to discover:
//   1. the target is not the master, and the server NAME agrees with the domain's first label;
//   2. the cluster row is in a state this verb may start on — the ONE place deploy and redeploy
//      disagree, and the reason redeploy is a verb instead of a boolean;
//   3. the wildcard *.<domain> resolves, and the machine answering is the machine we adopted;
//   4. the ordinal is allocated and the rows flipped, in ONE transaction.

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
      const master = loadMaster(ctx.db);
      if (master.id === sid) throw errValidation("refusing: the target IS the master — a slave must be a different server");

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
      // slave. Under deploy-slave `redeploying` is false, so an active cluster is refused below.
      const redeployActive = redeploying && !!byDomain && byDomain.status === "active" && byDomain.serverId === sid;
      let resume: { clusterId: string; slaveId: number } | undefined;
      if (byDomain) {
        const startable = byDomain.status === "planned" || byDomain.status === "provisioning" || redeployActive;
        if (!startable) {
          throw errValidation(`cluster ${byDomain.id} for ${domain} is '${byDomain.status}' — deploy-slave starts on a planned/provisioning cluster${byDomain.status === "active" ? "; rebuilding the machine layer of a LIVE cluster in place is the redeploy verb" : ""}`);
        }
        if (byDomain.slaveId === null) throw errValidation(`cluster ${byDomain.id} has no slaveId — not a deploy-slave row; clean it up manually`);
        if (input.slaveId !== undefined && input.slaveId !== byDomain.slaveId) {
          throw errValidation(`slaveId mismatch: cluster ${byDomain.id} already holds slaveId ${byDomain.slaveId} (asked for ${input.slaveId}) — the ordinal is never recycled`);
        }
        resume = { clusterId: byDomain.id, slaveId: byDomain.slaveId };
      }
      // A live slave's server sits at 'healthy' (register step); a resuming one at ready/provisioning.
      const okStatuses = redeployActive ? ["healthy", "ready", "provisioning"] : resume ? ["ready", "provisioning"] : ["ready"];
      if (!okStatuses.includes(server.status)) throw errValidation(`server ${server.name} is '${server.status}' — must be ${okStatuses.join("/")} (adopt it first)`);

      // ---- DNS wildcard *.<domain> resolves — HARD at deploy time (soft at adopt).
      // Resolvable-check ONLY: see dnsProbeScript — a NAT slave's wildcard resolves to the
      // shared public ingress, not the slave's own IP, so we never compare addresses.
      const session = await ctx.ssh(); // the slave (the run's ownsHost target)
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
      // clusters_slave_id_uq guarantees the ordinal is never reused across rebuild cycles.
      const result = localTx(ctx, (tx) => {
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
      ctx.log("meta", redeployActive
        ? `re-reconciling LIVE slave ${server.name} in place (cluster ${result.clusterId}, slaveId ${result.slaveId} kept; status stays active) — idempotent re-run to pick up installer changes`
        : result.resumed
          ? `resuming cluster ${result.clusterId} for ${domain} (slaveId ${result.slaveId} kept — never re-allocated)`
          : `slave ${server.name} allocated ordinal ${result.slaveId} for ${domain} (cluster ${result.clusterId})`);
    },
  };
}
