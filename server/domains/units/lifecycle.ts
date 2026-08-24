// Shared building blocks for the lifecycle Runs: the CONSUMER run kinds (offboard,
// suspend, resume — LifecyclePorts) and the TENANT run kinds (remove-app, tenant-suspend/-resume/
// -offboard — TenantLifecyclePorts). They need NO gate-runner — they move/remove/flip the pointer
// and wait for the master ArgoCD to reconcile — so they fit the standard synchronous plan() path.
// The Manager acts master-locally (pod on the master), so the clients ride in the *Ports type,
// injected by each run's factory. Every lifecycle run is mutating ⇒ attest-target is its first step
//; both formats' attest steps share assertDeployState (the fail-closed deploy-state gate).
import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps, clusters, tenants } from "../../db/schema/inventory.ts";
import { AppError, errNotFound } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { Registrations } from "./registrations.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { BuildRbacWriter, DeployState, ClusterKubeResolver, ClusterReader } from "../../adapters/kube/port.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";

// Every lifecycle run resolves the RIGHT kube clients + ArgoCD namespace for its target cluster at run
// time via `resolver.resolve(clusterId)`. The master path resolves to
// the master-local clients + argoNamespace "argocd" (behavior-identical to the pre-resolver wiring);
// a slave resolves to a per-slave clusterReader + argoNamespace "<slaveName>". The read/write
// kube clients therefore no longer ride in the *Ports — only the resolver does.
export interface LifecyclePorts {
  registrations: Registrations;
  resolver: ClusterKubeResolver;
  argoWatchTimeoutMs: number;
}

export interface AppCluster {
  name: string;
  domain: string;
  stage: Stage;
  clusterId: string;
}

export function loadAppCluster(db: Db, appId: string): AppCluster {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) throw errNotFound(`app ${appId}`);
  const cluster = db.select().from(clusters).where(eq(clusters.id, app.clusterId)).get();
  if (!cluster) throw errNotFound(`cluster ${app.clusterId} for app ${appId}`);
  return { name: app.name, domain: cluster.domain, stage: cluster.stage, clusterId: cluster.id };
}

/** Fail-closed deploy-state gate, shared by every consumer AND tenant attest-target step: the target
 *  cluster must still be a provisioned hostyour cluster (its deploy-state ConfigMap present) whose
 *  domain/stage agree with the unit's cluster row. `subject` names the unit in the mismatch message
 *  ("app" / "tenant"). Returns the (now-non-null) DeployState so the caller can log its generation. */
export function assertDeployState(state: DeployState | null, domain: string, stage: Stage, subject: string): DeployState {
  if (!state) throw errNotFound(`deploy-state for cluster ${domain} — refusing to act on an unprovisioned cluster`);
  if (state.domain !== domain || state.stage !== stage) {
    throw errNotFound(`deploy-state mismatch: cluster reports ${state.domain}/${state.stage}, ${subject} targets ${domain}/${stage}`);
  }
  return state;
}

/** attest-target, shared by every consumer lifecycle run: the target cluster must still be a
 *  provisioned hostyour cluster whose deploy-state agrees with the app's cluster row (fail-closed,
 *  step 0). Delegates the gate to assertDeployState (shared with the tenant attest step). */
export function attestTargetStep(ports: LifecyclePorts, appId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the target cluster (deploy-state fresh)",
    run: async (ctx) => {
      const ac = loadAppCluster(ctx.db, appId);
      // Read the deploy-state on the TARGET cluster (a slave over its own bearer, or the master), not the
      // master-local reader — a consumer on one slave must be attested against that slave.
      const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
      const state = assertDeployState(await clusterReader.readDeployState(), ac.domain, ac.stage, "app");
      ctx.log("meta", `target ${ac.domain} (${ac.stage}) attested for ${ac.name} — deploy-state generation ${state.generation}`);
    },
  };
}

/** Does the unit stay registered at another stage? Every teardown step whose object belongs to the UNIT
 *  rather than to the unit-in-a-stage has to ask before it removes anything, and both consumer removal
 *  run kinds (offboard, purge) ask through this one helper.
 *
 *  What is per stage, because a cluster carries exactly one stage and a unit's stages therefore sit on
 *  different clusters: the stage registration, the generated Application, the isolation AppProject, the
 *  ArgoCD repository credential, the admission policy, the namespace, the argo-sync grant, and the
 *  `<stage>/consumer/<name>/*` Vault entries. The public DNS record is per stage too, but NOT for that
 *  reason — its name `<name>.<unitApex>` states no cluster and two clusters may share an apex. It is per
 *  stage because provisionUnitDns (unit-dns.ts) refuses to onboard a stage onto a host another cluster's
 *  address already answers, so a unit reaches a second stage only where the two apexes differ and the two
 *  stages then own two different names. What is per UNIT, one copy shared by every stage: the
 *  `<name>-build` namespace with its EventListener and manager-read grants, the repo PAT at
 *  `secret/build/<name>/repo-pat`, the ONE build webhook on the consumer repo, and the release kit
 *  committed into that repo. Removing any of the second group while another stage stands leaves that
 *  stage unable to build, release or deploy.
 *
 *  The registration tree answers it: `registrations/<unit>/` still holding another `<stage>.yaml` means
 *  the unit stays registered — the same rule removeRegistration applies to build.yaml, asked of the same
 *  branch. It is read at the moment of the decision rather than carried from an earlier step, so a
 *  resumed run and a purge that found no registration of its own both get the true answer.
 *
 *  Returns true ⇒ the caller must keep its object, and the skip is already logged with the stages that
 *  kept it. `subject` names the object in that line.
 *
 *  `unit.stage` is the stage this run is removing, and it is discounted because the run's own
 *  registration may or may not still stand when the step acts. It is ABSENT for a caller that registers
 *  no stage of its own — the build-only onboard's abort cleanup — where every standing stage belongs to
 *  another run and none may be discounted. */
export async function unitStaysRegistered(
  ctx: StepCtx,
  registrations: Registrations,
  unit: { name: string; stage?: Stage },
  subject: string,
): Promise<boolean> {
  const elsewhere = (await registrations.readUnitStages(unit.name)).filter((standing) => standing !== unit.stage);
  if (elsewhere.length === 0) return false;
  ctx.log(
    "meta",
    `${subject} for ${unit.name} kept — the unit stays registered at ${elsewhere.join(", ")}, and there is one per unit, not one per stage; it goes with the unit's last stage`,
  );
  return true;
}

/** Take the relocation mark off the unit's namespaces — the FIRST thing every removal run kind does, on
 *  the cluster it is about to strip, before it removes the registration.
 *
 *  A move writes CLAIM_RELOCATING_ANNOTATION on the SOURCE namespaces at repoint, and while it stands
 *  the service-provisioner keeps a ServiceClaim's databases instead of dropping them
 *  (apps/service-provisioner/templates/configmap.yaml). Only two things ever take it off again: a
 *  later move ARRIVING on that cluster, and the source namespace being deleted by clear-source. A move
 *  that dies between repoint and clear-source and is then abandoned therefore leaves it standing — and
 *  a mark standing on a cluster is a removal run kind's problem, because the prune that a registration
 *  removal sets off runs the very teardown the mark disarms: offboard and purge would report success
 *  while every database of the unit stayed on the cluster, with nothing recording that it did.
 *
 *  Clearing here rather than reading and refusing is right because a mark this run kind finds is stale by
 *  construction: a move and a removal of the same unit cannot run at once (both claim the master-kube
 *  lock and the registration branch), so no live move is relying on it.
 *
 *  An absent namespace is the normal case for a teardown (a re-run, a purge of an orphan that never
 *  got one), so NOT_FOUND is swallowed — the opposite of the repoint, where marking nothing must never
 *  read as success. */
export async function clearRelocationHold(ctx: StepCtx, clusterReader: ClusterReader, namespaces: readonly string[], unit: string): Promise<void> {
  const cleared: string[] = [];
  for (const ns of namespaces) {
    try {
      await clusterReader.annotateNamespace(ns, { [CLAIM_RELOCATING_ANNOTATION]: null });
      cleared.push(ns);
    } catch (err) {
      if (!(err instanceof AppError && err.code === "NOT_FOUND")) throw err;
    }
  }
  ctx.log(
    "meta",
    cleared.length
      ? `${CLAIM_RELOCATING_ANNOTATION} cleared on ${cleared.join(", ")} — the patch runs whether or not one stood there, it is not a finding; a mark an abandoned move left behind would make this teardown keep ${unit}'s databases`
      : `no namespace of ${unit} stands on this cluster — no ${CLAIM_RELOCATING_ANNOTATION} mark to clear`,
  );
}

// ---- Tenant lifecycle (multi-app fan-out) — the tenant analogue of the consumer helpers above ----

/** The ports a tenant lifecycle run drives: the TenantRegistrations (sole writer of tenants/**, NOT the
 *  consumer Registrations), the per-cluster kube resolver (which yields the projectWriter offboard
 *  needs to delete the isolation AppProject), plus the catalog repo URL the renderer pins
 *  sourceRepos to. The only shape difference from LifecyclePorts is registrations + repoURL. */
export interface TenantLifecyclePorts {
  registrations: TenantRegistrations;
  /** Per-cluster kube resolver: the steps resolve the target cluster's
   *  clusterReader (smoke/attest), argoReader (watch), projectWriter (AppProject) + argoNamespace at
   *  run time. Replaces the single argo/cluster/projects clients that used to ride here. */
  resolver: ClusterKubeResolver;
  catalogRepoUrl: string;
  argoWatchTimeoutMs: number;
  /** The tenant's ONE wildcard DNS record `*.<subdomain>.<unitApex>`: tenant-offboard and
   *  tenant-purge remove it. Optional but UNCONDITIONALLY needed by those steps — absent ⇒ they fail
   *  loud, never a silent skip. */
  dns?: DnsProvider;
  /** Deletes the tenant's argo-sync grant beside its member AppProjects. Optional and skipped when
   *  absent: the writer is what PROVISIONED the grant, so a removal running without it has none to
   *  take back — the same shape the consumer offboard's grant delete has. */
  buildRbac?: BuildRbacWriter;
  /** The public apex (global.unitApex) of a cluster, read off its values chain on the platform repo
   *  — the tenant registrations's own repo is catalog, so the apex arrives as a resolver, the same
   *  shape the cluster-stage boundary uses. */
  resolveUnitApex: (domain: string, stage: Stage) => Promise<string>;
  /** Destroys the tenant's crypto entry `<stage>/tenants/<guid>` — the purge inverse of the seed
   *  create-tenant does. Optional and skipped when absent, the same shape buildRbac has: the seeder is
   *  what WROTE the entry, so a purge running without one has nothing it could take back. The step
   *  says which of the two happened rather than passing over it. */
  seeder?: VaultSeeder;
}

/** A tenant + its cluster context, resolved from the tenants row (tnt_) and its clusters row. The
 *  guid is the sole tenant identity (namespace == AppProject == <guid>). The tenant analogue of
 *  AppCluster. */
export interface TenantCluster {
  tenantId: string;
  guid: string;
  subdomain: string;
  stage: Stage;
  domain: string;
  clusterId: string;
  /** The tenant's standing member names and which of them is its IdP, as recorded on its row. Every
   *  caller of this that names a namespace, an AppProject or the tenant's auth host needs them, and a
   *  constant `auth` plus an implied trio stood here instead. */
  members: string[];
  identityProvider: string;
}

export function loadTenantCluster(db: Db, tenantId: string): TenantCluster {
  const tenant = db.select().from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!tenant) throw errNotFound(`tenant ${tenantId}`);
  const cluster = db.select().from(clusters).where(eq(clusters.id, tenant.clusterId)).get();
  if (!cluster) throw errNotFound(`cluster ${tenant.clusterId} for tenant ${tenantId}`);
  return {
    tenantId: tenant.id,
    guid: tenant.guid,
    subdomain: tenant.subdomain,
    stage: tenant.stage,
    domain: cluster.domain,
    clusterId: cluster.id,
    members: tenant.members,
    identityProvider: tenant.identityProvider,
  };
}

/** attest-target for every tenant lifecycle run (remove-app / tenant-suspend / -resume / -offboard):
 *  the target cluster's deploy-state must still agree with the tenant's cluster row (fail-closed,
 *  step 0 — the FIRST step of every mutating tenant run). Reuses the shared assertDeployState. */
export function attestTenantTargetStep(ports: TenantLifecyclePorts, tenantId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the target cluster (deploy-state fresh)",
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, tenantId);
      // Attest the TARGET cluster (tenants only ever land on slaves, POLICY) over its own reader.
      const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
      const state = assertDeployState(await clusterReader.readDeployState(), tc.domain, tc.stage, "tenant");
      ctx.log("meta", `target ${tc.domain} (${tc.stage}) attested for ${tc.guid} — deploy-state generation ${state.generation}`);
    },
  };
}
