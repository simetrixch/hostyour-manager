import { z } from "zod";
import { and, eq, notInArray } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step, StepCtx } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { apps, clusters, servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx } from "../../../executor/stepkit.ts";
import { APP_SETTLED_STATUS, isMasterRole } from "../../../../shared/enums.ts";
import { CLUSTER_MAP_DIR, clusterMapPath } from "../../../../shared/cluster-values.ts";
import { consumerArgoAppName } from "../../../../shared/consumer.ts";
import { DnsZoneUnknownError, type DnsProvider } from "../../../adapters/dns/port.ts";
import { moveClusterMarking } from "../../inventory/cluster-marking.ts";
import { ClusterFqdn, deploySlaveSteps } from "./deploy-slave.ts";
import { activeClusterTarget, APP_SYNC_TIMEOUT_MS, loadMaster, masterFqdnOf, requirePlatformRepo, requireResolver, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { loadActiveCluster } from "./live-cluster.kit.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./ansiwise-run.kit.ts";

// `rename` — move a LIVE slave onto another FQDN, and adopt it there.
//
// WHAT MOVES AND WHAT STAYS. A cluster's FQDN is where it is reached; its NAME is what everything
// named after it carries — the per-slave ArgoCD instance and AppProject, the Vault mount, the tailnet
// user, every registration's `cluster` (cluster-marking.ts). The name is fixed at adoption and this
// run leaves it, so nothing ArgoCD generates for the slave is replaced and no unit is touched. What
// moves is exactly what names the FQDN: the cluster's map on the books branch (one commit), the
// cluster row and the server's host, every unit record that points at the old FQDN, and the old
// FQDN's own records, which go last. Between the moves stands the machine layer, reconciled under
// the new FQDN by redeploy's own steps — so the machine is ADOPTED at its new name the way a
// redeploy adopts a machine reinstalled at the provider.
//
// THE ORDER IS THE SAFETY. Nothing in git or DNS moves before the machine answering at the new FQDN
// has shown the host key and the machine identity this manager holds for it (attest-machine): a
// stranger answering at that name is refused while only the inventory row points at it, and an abort
// puts the row back. And the rename refuses outright under a slaves ApplicationSet that still works
// a slave's name out of its domain: under that one, moving the map would generate a second slave and
// prune the standing one with every workload on it.
//
// THE OLD FQDN IS A PARAM, stated by the page that asked. The plan holds it against the row, so a
// rename asked from a page that is out of date is refused, and every compensation of an abort goes
// back to it without reading anything the run itself moved.

const SLAVES_APPSET = "clusters/argocd/files/slaves-appset.yaml";
/** The slaves ApplicationSet line that names a slave by the name its map records. */
const NAMES_BY_CLUSTER_NAME = /cluster:\s*'\{\{\s*\.global\.clusterName\s*\}\}'/;

export const RenameSlaveParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The FQDN the slave stands at now, as the page that asked showed it. */
  fromFqdn: ClusterFqdn,
  /** The FQDN the slave is moved onto. */
  newFqdn: ClusterFqdn,
});
export type RenameSlaveParams = z.infer<typeof RenameSlaveParams>;

/** Every unit record of a cluster that points at `from`, pointed at `to` — the units domain's act
 *  (units/cluster-rename-records.ts), bound by the composition root. Answers the records moved. */
export type UnitRecordsRepointer = (ctx: StepCtx, input: { clusterId: string; from: string; to: string }) => Promise<string[]>;

export interface RenameSlavePorts extends DeploySlavePorts, AnsiwisePorts {
  db: Db;
  dns?: DnsProvider;
  unitRecords?: UnitRecordsRepointer;
}

function requireUnitRecords(ports: RenameSlavePorts): UnitRecordsRepointer {
  if (!ports.unitRecords) throw errValidation("renaming a slave repoints its units' records, and this manager has no DNS provider wired to do it (CLOUDFLARE_DNS_API_TOKEN unset)");
  return ports.unitRecords;
}

function clusterOf(db: Db, serverId: string): typeof clusters.$inferSelect {
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, serverId)).get();
  if (!cluster) throw errValidation(`server ${serverId} carries no cluster`);
  return cluster;
}

function attestRenameStep(p: RenameSlaveParams, ports: RenameSlavePorts): Step {
  return {
    name: "attest-target",
    title: "Attest the rename: the slave, the new FQDN, and the slaves ApplicationSet naming slaves by their name",
    run: async (ctx) => {
      const { server, cluster } = loadActiveCluster(ctx.db, p.serverId);
      if (isMasterRole(server.role)) throw errValidation(`${server.name} carries the master part — a rename moves a slave, and a master is named by its own installation`);
      if (cluster.domain === p.newFqdn && ctx.readCheckpoint() !== undefined) {
        ctx.log("meta", `${server.name} already stands at ${p.newFqdn} — this rename was attested before and has moved the row since`);
        return;
      }
      if (cluster.domain !== p.fromFqdn) throw errValidation(`${server.name} stands at ${cluster.domain}, not at ${p.fromFqdn} — the rename was asked from a page that is out of date; nothing has been changed`);
      const clash = ctx.db.select({ id: clusters.id }).from(clusters).where(eq(clusters.domain, p.newFqdn)).get();
      if (clash) throw errValidation(`${p.newFqdn} is already the FQDN of cluster ${clash.id}; nothing has been changed`);
      const repo = requirePlatformRepo(ports);
      await repo.withBranch(repo.booksBranch, async (books) => {
        if ((await books.listDir(CLUSTER_MAP_DIR)).includes(`${p.newFqdn}.yaml`)) {
          throw errValidation(`${clusterMapPath(p.newFqdn)} already stands on ${books.branch} — a cluster is marked at that FQDN; nothing has been changed`);
        }
        const appset = await books.readFile(SLAVES_APPSET);
        if (appset === null || !NAMES_BY_CLUSTER_NAME.test(appset)) {
          throw errValidation(
            `the slaves ApplicationSet on ${books.branch} (${SLAVES_APPSET}) does not name a slave by the clusterName its map records. ` +
              "It names the slave's Application, its AppProject and its per-slave plane, so under it a rename would generate a second slave " +
              "under a new name and prune the standing one with every workload on it. Release hostyour-cloud with the ApplicationSet that reads " +
              "global.clusterName onto this installation first; nothing has been changed",
          );
        }
      });
      ctx.checkpoint({ from: p.fromFqdn, to: p.newFqdn, name: cluster.name });
      ctx.log("meta", `${server.name} moves from ${p.fromFqdn} to ${p.newFqdn}; its name stays ${cluster.name}, so nothing named after it is replaced`);
    },
  };
}

function restoreIdentityCleanup(p: RenameSlaveParams): Cleanup {
  return {
    name: "restore-identity",
    title: "Point the inventory back at the old FQDN",
    run: async (ctx) => {
      localTx(ctx, (tx) => {
        tx.update(clusters).set({ domain: p.fromFqdn }).where(and(eq(clusters.serverId, p.serverId), eq(clusters.domain, p.newFqdn))).run();
        tx.update(servers).set({ host: p.fromFqdn }).where(and(eq(servers.id, p.serverId), eq(servers.host, p.newFqdn))).run();
      });
      ctx.log("meta", `the inventory points at ${p.fromFqdn} again`);
    },
  };
}

function repointIdentityStep(p: RenameSlaveParams): Step {
  return {
    name: "repoint-identity",
    title: "Point the inventory at the new FQDN: the cluster row, and the server's host where it named the old one",
    run: async (ctx) => {
      // ARMED BEFORE THE WRITE, so an abort after it finds its way back.
      ctx.registerCleanup(restoreIdentityCleanup(p));
      const moved = localTx(ctx, (tx) => {
        const server = tx.select().from(servers).where(eq(servers.id, p.serverId)).get();
        if (!server) throw errValidation(`server ${p.serverId} does not exist`);
        // THE HOST FOLLOWS WHERE IT NAMED THE OLD FQDN: every session of this run reaches the machine
        // there, and the machine answers at the new name now. A host stated some other way — an
        // address, a LAN name — is the operator's statement and stays as it was stated.
        const hostFollows = server.host === p.fromFqdn;
        tx.update(clusters).set({ domain: p.newFqdn }).where(and(eq(clusters.serverId, p.serverId), eq(clusters.domain, p.fromFqdn))).run();
        if (hostFollows) tx.update(servers).set({ host: p.newFqdn }).where(eq(servers.id, p.serverId)).run();
        return { hostFollows, host: hostFollows ? p.newFqdn : server.host };
      });
      ctx.checkpoint(moved);
      ctx.log("meta", `the cluster row stands at ${p.newFqdn}; ${moved.hostFollows ? `the server is reached at ${p.newFqdn}` : `the server is reached at ${moved.host}, as its row states`}`);
    },
  };
}

function ensureWildcardStep(p: RenameSlaveParams, ports: RenameSlavePorts): Step {
  return {
    name: "ensure-wildcard",
    title: "Point the new FQDN's wildcard at it, where this installation manages the zone",
    run: async (ctx) => {
      const name = `*.${p.newFqdn}`;
      if (!ports.dns) throw errValidation(`writing ${name} requires the DNS provider, and none is wired on this manager`);
      try {
        const standing = await ports.dns.readRecordContent({ name, type: "CNAME", signal: ctx.signal });
        if (standing === p.newFqdn) {
          ctx.log("meta", `${name} already points at ${p.newFqdn}`);
          return;
        }
        await ports.dns.upsertRecord({ name, type: "CNAME", content: p.newFqdn, signal: ctx.signal });
        ctx.log("meta", `${name} → CNAME ${p.newFqdn}${standing === null ? "" : ` (it pointed at ${standing})`} — every platform name under the slave answers what its own record answers`);
      } catch (err) {
        if (!(err instanceof DnsZoneUnknownError)) throw err;
        ctx.log("meta", `${name} is in no zone this installation manages, so it is not written here — the machine's attestation measures that it resolves`);
      }
    },
  };
}

function moveMapBackCleanup(p: RenameSlaveParams, ports: RenameSlavePorts): Cleanup {
  return {
    name: "move-map-back",
    title: "Move the cluster's map back onto the old FQDN",
    run: async (ctx) => {
      const { changed } = await moveClusterMarking(requirePlatformRepo(ports), p.newFqdn, p.fromFqdn, ctx.runId);
      ctx.log("meta", changed ? `the map stands at ${clusterMapPath(p.fromFqdn)} again` : `the map already stands at ${clusterMapPath(p.fromFqdn)}`);
    },
  };
}

function moveMapStep(p: RenameSlaveParams, ports: RenameSlavePorts): Step {
  return {
    name: "move-map",
    title: "Move the cluster's map onto the new FQDN on the books branch (one commit; the name stays)",
    run: async (ctx) => {
      ctx.registerCleanup(moveMapBackCleanup(p, ports));
      const repo = requirePlatformRepo(ports);
      const { changed, name } = await moveClusterMarking(repo, p.fromFqdn, p.newFqdn, ctx.runId);
      ctx.checkpoint({ changed });
      ctx.log("meta", changed
        ? `${clusterMapPath(p.fromFqdn)} is now ${clusterMapPath(p.newFqdn)} on ${repo.booksBranch} — the slaves ApplicationSet names the slave ${name} still, so its Application is the same one at a new domain`
        : `${clusterMapPath(p.newFqdn)} already stands on ${repo.booksBranch} — the move was made before`);
    },
  };
}

function repointRecordsBackCleanup(p: RenameSlaveParams, ports: RenameSlavePorts): Cleanup {
  return {
    name: "repoint-unit-records-back",
    title: "Point the unit records back at the old FQDN",
    run: async (ctx) => {
      const moved = await requireUnitRecords(ports)(ctx, { clusterId: clusterOf(ctx.db, p.serverId).id, from: p.newFqdn, to: p.fromFqdn });
      ctx.log("meta", `${moved.length} unit record(s) point at ${p.fromFqdn} again`);
    },
  };
}

function repointRecordsStep(p: RenameSlaveParams, ports: RenameSlavePorts): Step {
  return {
    name: "repoint-unit-records",
    title: "Point every unit record of the cluster from the old FQDN at the new one",
    run: async (ctx) => {
      ctx.registerCleanup(repointRecordsBackCleanup(p, ports));
      const moved = await requireUnitRecords(ports)(ctx, { clusterId: clusterOf(ctx.db, p.serverId).id, from: p.fromFqdn, to: p.newFqdn });
      ctx.checkpoint({ moved });
      ctx.log("meta", `${moved.length} unit record(s) now point at ${p.newFqdn}`);
    },
  };
}

function removeOldRecordsStep(p: RenameSlaveParams, ports: RenameSlavePorts): Step {
  return {
    name: "remove-old-records",
    title: "Take the old FQDN's own records away: its wildcard and its address",
    run: async (ctx) => {
      if (!ports.dns) throw errValidation(`removing the records of ${p.fromFqdn} requires the DNS provider, and none is wired on this manager`);
      for (const record of [{ name: `*.${p.fromFqdn}`, type: "CNAME" as const }, { name: p.fromFqdn, type: "A" as const }, { name: p.fromFqdn, type: "CNAME" as const }]) {
        try {
          const { deleted } = await ports.dns.deleteRecord({ name: record.name, type: record.type, signal: ctx.signal });
          ctx.log("meta", deleted > 0 ? `${record.type} ${record.name} removed — no name is left pointing where the slave was` : `no ${record.type} ${record.name} stands`);
        } catch (err) {
          if (!(err instanceof DnsZoneUnknownError)) throw err;
          ctx.log("meta", `${record.name} is in no zone this installation manages, so its records are not this installation's to remove — left as they stand`);
          return;
        }
      }
    },
  };
}

function verifyApplicationsStep(p: RenameSlaveParams, ports: RenameSlavePorts): Step {
  return {
    name: "verify-applications",
    title: "Hold the rename to the units: every consumer's Application stands and is Synced",
    run: async (ctx) => {
      const cluster = clusterOf(ctx.db, p.serverId);
      const { argoReader, argoNamespace } = await requireResolver(ports).resolve(cluster.id);
      const expected = ctx.db
        .select({ name: apps.name, stage: apps.stage })
        .from(apps)
        .where(and(eq(apps.clusterId, cluster.id), notInArray(apps.status, [...APP_SETTLED_STATUS])))
        .all()
        .map((a) => consumerArgoAppName(a.name, a.stage));
      const synced = (byName: ReadonlyMap<string, { sync: string }>): boolean => expected.every((n) => byName.get(n)?.sync === "Synced");
      const byName = expected.length === 0 ? new Map() : await argoReader.watchApplicationSet(argoNamespace, expected, synced, { timeoutMs: APP_SYNC_TIMEOUT_MS, signal: ctx.signal });
      // AN APPLICATION THAT IS NOT THERE reads Missing: the reader answers every expected name, and
      // one the namespace does not hold with the health Missing (kube-map.ts MISSING_APP_STATUS).
      const lost = expected.filter((n) => (byName.get(n)?.health ?? "Missing") === "Missing");
      const behind = expected.filter((n) => !lost.includes(n) && byName.get(n)?.sync !== "Synced");
      const all = await argoReader.listApplications(argoNamespace);
      ctx.log("meta", `${argoNamespace} holds ${all.length} Application(s), ${all.filter((a) => a.sync === "Synced").length} of them Synced`);
      if (lost.length > 0 || behind.length > 0) {
        throw errValidation(
          `the rename is not proven on its units: ${lost.length > 0 ? `no Application stands for ${lost.join(", ")}` : ""}${lost.length > 0 && behind.length > 0 ? "; " : ""}${behind.length > 0 ? `${behind.join(", ")} did not reach Synced within ${APP_SYNC_TIMEOUT_MS / 60_000} min` : ""} — read the slave's ArgoCD at ${argoNamespace} before anything else`,
        );
      }
      ctx.log("meta", `every one of the ${expected.length} consumer Application(s) of ${cluster.name} stands and is Synced at ${p.newFqdn}`);
    },
  };
}

function renameSteps(p: RenameSlaveParams, ports: RenameSlavePorts): Step[] {
  // THE MACHINE LAYER, AS A REDEPLOY RECONCILES IT, under the FQDN the row stands at by then. Its own
  // attestation runs under a name of its own right after the row moves: it opens the door at the new
  // host with the host key this manager pinned, measures the wildcard, and checks the machine
  // identity — before anything in git or DNS moves.
  const machine = deploySlaveSteps({ target: activeClusterTarget(p.serverId), mode: "redeploy" }, ports);
  const attestMachine = machine.find((s) => s.name === "attest-target");
  if (!attestMachine) throw new Error("deploy-slave's steps carry no attest-target — the rename cannot attest the machine");
  return [
    attestRenameStep(p, ports),
    repointIdentityStep(p),
    ensureWildcardStep(p, ports),
    { ...attestMachine, name: "attest-machine", title: "Attest the machine at the new FQDN (host key, machine identity, DNS wildcard)" },
    moveMapStep(p, ports),
    repointRecordsStep(p, ports),
    ...machine.filter((s) => s !== attestMachine),
    removeOldRecordsStep(p, ports),
    verifyApplicationsStep(p, ports),
  ];
}

export function makeRenameSlaveDef(ports: RenameSlavePorts): RunDefinition<RenameSlaveParams> {
  return {
    kind: "cluster-rename",
    paramsSchema: RenameSlaveParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      if (isMasterRole(server.role)) throw errValidation(`${server.name} carries the master part — a rename moves a slave`);
      if (cluster.domain !== params.fromFqdn) throw errValidation(`${server.name} stands at ${cluster.domain}, not at ${params.fromFqdn} — reload the page and ask again`);
      if (params.newFqdn === params.fromFqdn) throw errValidation(`${server.name} already stands at ${params.newFqdn}`);
      const clash = db.select({ id: clusters.id }).from(clusters).where(eq(clusters.domain, params.newFqdn)).get();
      if (clash) throw errValidation(`${params.newFqdn} is already the FQDN of cluster ${clash.id}`);
      const master = loadMaster(db);
      const stepDefs = renameSteps(params, ports);
      return {
        kind: "cluster-rename",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Move the slave "${server.name}" from ${params.fromFqdn} to ${params.newFqdn} and adopt it there. Its name stays ${cluster.name}, ` +
          `so its ArgoCD instance, its AppProject, its Vault mount, its tailnet user and every unit on it stay exactly as they are. ` +
          `What moves: the inventory row, the cluster's map (one commit on the books branch), every unit record that points at ${params.fromFqdn}, ` +
          `and last the records of ${params.fromFqdn} itself. Before git or DNS is touched, the machine answering at ${params.newFqdn} must show the ` +
          `host key and the machine identity this manager holds for ${server.name} — a stranger at that name is refused. ` +
          `${params.newFqdn} must resolve to the machine before you approve; its wildcard is written where this installation manages the zone. ` +
          `The machine layer is then reconciled as a redeploy does it, and the run ends by holding every consumer's Application on the slave to Synced. ` +
          `The password you enter raises every root command of this run and of the machine's own programs; it is held in memory for the length ` +
          `of the run and stored nowhere.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [
          { serverId: server.id, ownsHost: true, label: `${server.name} (slave)` },
          { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
        ],
        locks: [
          { resource: "git-branch", key: params.fromFqdn },
          { resource: "git-branch", key: params.newFqdn },
          { resource: "git-branch", key: masterFqdnOf(db, master) },
          { resource: "master-vault", key: "m" },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [
          `${params.fromFqdn} stops being this slave's name: its records are removed at the end, and every unit record points at ${params.newFqdn}.`,
          `The machine layer re-runs on ${server.name} — expect a brief kube-apiserver blip while kubelite restarts.`,
        ],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => renameSteps(params, ports),
    cleanups: (params) => [restoreIdentityCleanup(params), moveMapBackCleanup(params, ports), repointRecordsBackCleanup(params, ports)],
  };
}
