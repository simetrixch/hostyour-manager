// tenant-line-move: move a standing tenant to a newer engine line. Its bundle and the platform part that
// carries the bundle's engine are written for one line, and every writer refuses them on two, so the run
// writes both in one registration commit (readLineMove picks the pairing), after an online backup that is
// the way back once the new line has run on the tenant's data.
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step, Cleanup, Plan } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { listBackups } from "../../db/unit-backups.ts";
import { STAGE } from "../../../shared/enums.ts";
import { approvedImageTag, guid as guidSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { errNotFound, errValidation, errInternal } from "../../kernel/errors.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { discardGenerationCleanup, takeOnlineGeneration } from "#unit/server/relocation.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { rendersApproval, sameApprovals } from "./tenant-versions.ts";
import { readLineMove } from "./tenant-line-move.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

export type TenantLineMovePorts = TenantOnboardPorts & { relocation: TenantRelocationPorts };

const LINE = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "a line is x.y");
const Pairing = z.object({
  appsImageTag: approvedImageTag,
  approvedTags: z.record(z.string(), z.record(z.string(), approvedImageTag)),
});
type Pairing = z.infer<typeof Pairing>;

export const TenantLineMoveRequest = z.object({ tenantId: z.string().min(1), line: LINE });

export const TenantLineMoveParams = z.object({
  tenantId: z.string().min(1),
  guid: guidSchema,
  stage: z.enum(STAGE),
  clusterId: z.string().min(1),
  domain: z.string().min(1),
  fromLine: LINE,
  line: LINE,
  members: z.array(z.string().min(1)).min(1),
  expectedApps: z.array(z.string().min(1)).min(1),
  previous: Pairing,
  target: Pairing,
  /** The registration already carried the target pairing when the run was planned: it only waits. */
  standing: z.boolean(),
});
export type TenantLineMoveParams = z.infer<typeof TenantLineMoveParams>;

const carries = (entry: TenantRegistration, pairing: Pairing): boolean =>
  entry.appsImageTag === pairing.appsImageTag && sameApprovals(entry.approvedTags, pairing.approvedTags);

/** Whether a member Application's last comparison renders the bundle at `tag`. */
function rendersBundle(status: ArgoAppStatus | undefined, deployRepoUrl: string, tag: string): boolean {
  const charts = (status?.syncSources ?? []).filter((src) => src.repoURL === deployRepoUrl && src.path);
  return charts.length > 0 && charts.every((src) => (src.valuesObject?.["tenant"] as { appsImageTag?: unknown } | undefined)?.appsImageTag === tag);
}

/** Whether the member Application renders every build its member holds in `pairing`, and its bundle. */
function rendersMemberPairing(status: ArgoAppStatus | undefined, deployRepoUrl: string, member: string, pairing: Pairing): boolean {
  return rendersBundle(status, deployRepoUrl, pairing.appsImageTag)
    && Object.entries(pairing.approvedTags[member] ?? {}).every(([build, tag]) => rendersApproval(status, deployRepoUrl, member, build, tag));
}

/** Every member Application Synced + Healthy, each rendering the target pairing. */
function rendersPairing(p: TenantLineMoveParams, deployRepoUrl: string): (byName: ArgoAppStatusMap) => boolean {
  const synced = syncedAt(p.expectedApps);
  return (byName) => synced(byName) && p.members.every((m, i) => rendersMemberPairing(byName.get(p.expectedApps[i]!), deployRepoUrl, m, p.target));
}

/** Whether any member Application renders a part of the target pairing the previous one did not carry:
 *  from then on the new line may have run on the tenant's data. */
function rendersAnyOfTarget(p: TenantLineMoveParams, deployRepoUrl: string, byName: ArgoAppStatusMap): boolean {
  return p.members.some((m, i) => {
    const status = byName.get(p.expectedApps[i]!);
    const newBundle = p.target.appsImageTag !== p.previous.appsImageTag && rendersBundle(status, deployRepoUrl, p.target.appsImageTag);
    const newBuild = Object.entries(p.target.approvedTags[m] ?? {}).some(([build, tag]) => p.previous.approvedTags[m]?.[build] !== tag && rendersApproval(status, deployRepoUrl, m, build, tag));
    return newBundle || newBuild;
  });
}

/** The tenant's newest verified line-move generation, the way back once the new line has run. */
function lineMoveGeneration(db: Db, p: TenantLineMoveParams): string | undefined {
  return listBackups(db, { kind: "tenant", unit: p.guid, stage: p.stage })
    .filter((b) => b.trigger === "line-move" && b.state === "ok")
    .map((b) => b.generation)
    .sort()
    .at(-1);
}

/** On abort: write back the pairing the registration carried before this run, only while it still
 *  carries this run's own. A pairing a Restore or another run wrote since is theirs, and stays. */
function restorePairingCleanup(ports: TenantLineMovePorts, p: TenantLineMoveParams): Cleanup {
  return {
    name: "restore-pairing",
    title: `Write the line-${p.fromLine} bundle and platform part back into the registration`,
    run: async (ctx) => {
      const current = await ports.registrations.readTenant(p.stage, p.guid);
      if (!current || !carries(current.entry, p.target)) {
        ctx.log("meta", `tenant ${p.guid}'s registration does not carry the pairing this run writes — this run never wrote it, or a Restore or another run wrote another since; left as it is`);
        return;
      }
      // Asked again right before the write, as the abort's check is a moment earlier: a member that
      // started the new line since must not get the old pairing on data the new one may have changed.
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, () => true, { timeoutMs: 1, labelSelector: `platform/tenant=${p.guid}` });
      if (rendersAnyOfTarget(p, ports.deployRepoUrl, byName)) {
        throw errValidation(`a member of tenant ${p.guid} renders line ${p.line} by now, so the line-${p.fromLine} pairing is not written back; the way back is the Restore of the line-move generation this run took`);
      }
      const { commit } = await ports.registrations.setLinePairing(p.stage, p.guid, p.previous, ctx.runId);
      ctx.db.update(tenants).set({ approvedTags: p.previous.approvedTags, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
      ctx.log("meta", `tenant ${p.guid} back on its line-${p.fromLine} pairing (${commit})`);
    },
  };
}

/** Refuses the abort while the registration carries this run's pairing and a member already renders a
 *  part of it: line `p.line` may have changed the tenant's data, and the line-`p.fromLine` pairing would
 *  put older code on it. The Restore of the backup is the way back; once it wrote the old pairing, the
 *  registration no longer carries this run's, and the abort closes the run. */
async function assertLineMoveAbortable(ports: TenantLineMovePorts, p: TenantLineMoveParams, db: Db): Promise<void> {
  if (p.standing) return;
  const current = await ports.registrations.readTenant(p.stage, p.guid);
  if (!current || !carries(current.entry, p.target)) return;
  const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
  const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, () => true, { timeoutMs: 1, labelSelector: `platform/tenant=${p.guid}` });
  if (!rendersAnyOfTarget(p, ports.deployRepoUrl, byName)) return;
  const generation = lineMoveGeneration(db, p);
  throw errValidation(
    `a member of tenant ${p.guid} already renders line ${p.line}, so writing the line-${p.fromLine} pairing back would put line-${p.fromLine} code on data line ${p.line} may have changed. ` +
    `The way back is the Restore of ${generation ? `generation ${generation}` : "the line-move generation this run took"}; once it has written the old pairing, this abort closes the run.`,
  );
}

function tenantLineMoveSteps(ports: TenantLineMovePorts, p: TenantLineMoveParams): Step[] {
  const attest: Step = {
    name: "attest-target",
    title: "Attest the target cluster (deploy-state fresh)",
    run: async (ctx) => {
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const state = assertDeployState(await clusterReader.readDeployState(), p.domain, "tenant");
      ctx.log("meta", `target ${p.domain} attested for ${p.guid} at ${p.stage} — deploy-state generation ${state.generation}`);
    },
  };
  const watch: Step = {
    name: "watch-pairing",
    title: `Wait until every member is Synced + Healthy rendering line ${p.line}`,
    run: async (ctx) => {
      // The pairing this run wrote, and no other: after a Restore the members are healthy on the old
      // line, and a wait on whatever stands would settle the move green for a tenant that did not move.
      const current = await ports.registrations.readTenant(p.stage, p.guid);
      if (!current || !carries(current.entry, p.target)) {
        throw errValidation(`tenant ${p.guid}'s registration no longer carries the line-${p.line} pairing this run wrote — a Restore or another run wrote another since; abort this run to close it`);
      }
      const until = rendersPairing(p, ports.deployRepoUrl);
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, until, {
        timeoutMs: ports.argoWatchTimeoutMs,
        signal: ctx.signal,
        labelSelector: `platform/tenant=${p.guid}`,
      });
      if (!syncedAt(p.expectedApps)(byName)) throw errValidation(`tenant ${p.guid} fan-out did not converge — ${describeUnsynced(p.expectedApps, byName)}`);
      if (!until(byName)) {
        const stale = p.members.filter((m, i) => !rendersMemberPairing(byName.get(p.expectedApps[i]!), ports.deployRepoUrl, m, p.target));
        throw errValidation(`${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} Synced + Healthy but ArgoCD has not rendered line ${p.line} yet — retry this step once it has`);
      }
      ctx.log("meta", `tenant ${p.guid}: ${p.expectedApps.length} member Application(s) Synced + Healthy on line ${p.line}`);
    },
  };
  if (p.standing) return [attest, watch];
  return [
    attest,
    {
      name: "backup",
      title: "Take an online backup of the tenant, the way back from the move",
      run: async (ctx) => {
        const w = await tenantWorld(ports.relocation, p.tenantId)(ctx);
        const g = await takeOnlineGeneration(ports.relocation, ctx, w, "line-move");
        ctx.checkpoint({ generation: g.generation });
        ctx.log("meta", `generation ${g.generation} of tenant ${p.guid} taken online and verified — once a member renders line ${p.line}, its Restore is the way back`);
      },
    },
    {
      name: "write-pairing",
      title: `Write the bundle and the platform part on line ${p.line} into the registration, in one commit`,
      run: async (ctx) => {
        const current = await ports.registrations.readTenant(p.stage, p.guid);
        if (!current) throw errNotFound(`tenant ${p.guid} is not onboarded (no registration at ${p.stage})`);
        // The plan's facts, asked again: another run may have moved the tenant since. A resume finds
        // its own write already standing, and writing it again commits nothing.
        if (!carries(current.entry, p.previous) && !carries(current.entry, p.target)) {
          throw errValidation(`tenant ${p.guid}'s bundle or versions changed since this run was planned — plan it again`);
        }
        ctx.registerCleanup(restorePairingCleanup(ports, p));
        const { commit } = await ports.registrations.setLinePairing(p.stage, p.guid, p.target, ctx.runId);
        ctx.db.update(tenants).set({ approvedTags: p.target.approvedTags, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${p.guid}: bundle ${p.target.appsImageTag} and its platform part on line ${p.line} written in one commit (${commit})`);
      },
    },
    watch,
  ];
}

export function makeTenantLineMoveDef(ports: TenantLineMovePorts): RunDefinition<TenantLineMoveParams> {
  return {
    kind: "tenant-line-move",
    paramsSchema: TenantLineMoveParams,
    mutating: true,
    plan: () => {
      throw errInternal("tenant-line-move is planned via planStream (the streaming entrypoint), not plan()");
    },
    planStream: async (rawParams, ctx) => {
      const req = TenantLineMoveRequest.parse(rawParams);
      const tc = loadTenantCluster(ctx.db, req.tenantId);
      const row = ctx.db.select({ status: tenants.status, suspended: tenants.suspended }).from(tenants).where(eq(tenants.id, req.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run first`);
      if (row?.status === "offboarded" || row?.status === "purged") throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing serves it`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its members render no workloads, so the wait could never end; resume it first`);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      const registryHost = registryHostFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage));
      const reading = await readLineMove(ports, { stage: tc.stage, entry: current.entry, registryHost, line: req.line, log: ctx.log, signal: ctx.signal });
      if (reading.line === null || reading.refusals.length > 0 || reading.target === null) {
        const why = reading.refusals.length > 0 ? reading.refusals.join("; ") : `no release of its bundle that ${tc.stage} takes declares line ${req.line}`;
        return { outcome: "rejected", summary: `tenant ${tc.subdomain} cannot move to line ${req.line}: ${why}`, planJson: reading };
      }
      const target = reading.target;
      const members = current.entry.members.map((m) => m.name);
      const params: TenantLineMoveParams = {
        tenantId: tc.tenantId,
        guid: tc.guid,
        stage: tc.stage,
        clusterId: tc.clusterId,
        domain: tc.domain,
        fromLine: reading.line,
        line: target.line,
        members,
        expectedApps: members.map((m) => memberApplication(tc.guid, m, tc.stage)),
        previous: { appsImageTag: current.entry.appsImageTag ?? "", approvedTags: current.entry.approvedTags },
        target: { appsImageTag: target.appsImageTag, approvedTags: target.approvedTags },
        standing: reading.standing,
      };
      const steps = tenantLineMoveSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-line-move",
        targetKind: "tenant",
        targetId: tc.tenantId,
        summary: reading.standing
          ? `Tenant ${tc.guid} on ${tc.domain} (${tc.stage}) already carries the pairing of line ${target.line}: bundle ${target.appsImageTag}, ${target.part} (${target.builds.join(", ")}) at ${target.partTag}. ` +
            `Nothing is written or backed up; the run waits until every member renders it.`
          : `Move tenant ${tc.guid} on ${tc.domain} (${tc.stage}) from line ${reading.line} to line ${target.line}: ` +
            `the bundle ${params.previous.appsImageTag} → ${target.appsImageTag} (release ${target.bundleRelease}), and ${target.part} (${target.builds.join(", ")}) → ${target.partTag}. ` +
            `First an online backup of the tenant, then both are written in one registration commit, then every member must render them. No other tenant changes.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: reading.standing ? [] : [
          `the backup is taken online, as fits the seeded showcases: a write during the dump may be missing from it, and the tenant serves on line ${reading.line} until the switch, so a restore drops those minutes. ` +
            `A tenant with business data needs its quiesced Backup held until the pairing is written, which this run does not do.`,
          `once a member renders line ${target.line}, line ${target.line} may change the tenant's data, and writing the line-${reading.line} pairing back is no way back: the Restore of this run's line-move generation is, and the abort is refused from then on. ` +
            `That generation is kept like every other: it goes once 7 newer verified generations of the tenant stand, whatever took them, unless it is the newest of its week.`,
        ],
        requiredSecrets: [],
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => tenantLineMoveSteps(ports, params),
    cleanups: (params) => (params.standing ? [] : [discardGenerationCleanup(ports.relocation, tenantWorld(ports.relocation, params.tenantId)), restorePairingCleanup(ports, params)]),
    assertAbortable: (params, deps) => assertLineMoveAbortable(ports, params, deps.db),
  };
}
