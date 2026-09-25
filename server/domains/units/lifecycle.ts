// Shared building blocks for the lifecycle Runs: the CONSUMER run kinds (offboard,
// suspend, resume — LifecyclePorts) and the TENANT run kinds (remove-app, tenant-suspend/-resume/
// -offboard — TenantLifecyclePorts). They need NO gate-runner — they move/remove/flip the pointer
// and wait for the master ArgoCD to reconcile — so they fit the standard synchronous plan() path.
// The Manager acts master-locally (pod on the master), so the clients ride in the *Ports type,
// injected by each run's factory. Every lifecycle run is mutating ⇒ attest-target is its first step
//; both formats' attest steps share assertDeployState (the fail-closed deploy-state gate,
// plugins/unit/server/lifecycle.ts).
import { eq } from "drizzle-orm";
import type { Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps, clusters, tenants } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import type { MemberRouting, Stage } from "../../../shared/enums.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { BuildRbacWriter, ClusterKubeResolver } from "../../adapters/kube/port.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import type { ObjectStore } from "../../adapters/object-store/port.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";

// Every lifecycle run resolves the RIGHT kube clients + ArgoCD namespace for its target cluster at run
// time via `resolver.resolve(clusterId)`. The master path resolves to
// the master-local clients + argoNamespace "argocd";
// a slave resolves to a per-slave clusterReader + argoNamespace "<slaveName>". The read/write
// kube clients therefore do not ride in the *Ports — only the resolver does.
export interface LifecyclePorts {
  registrations: Registrations;
  resolver: ClusterKubeResolver;
  argoWatchTimeoutMs: number;
  /** The platform's GitHub App: a cleanup reaching a unit's repository resolves the owner's identity
   *  with it (repo-identity.ts unitRepoCredentialId, #226). */
  githubApp?: GitHubApp;
}

export interface AppCluster {
  name: string;
  /** The public host label the row attests — what the unit's address is composed from, never the name. */
  host: string;
  domain: string;
  /** The cluster's name, fixed at its adoption (cluster-marking.ts header). */
  clusterName: string;
  stage: Stage;
  clusterId: string;
}

/** The consumer's own facts off its row: its name and STAGE are the row's, the domain is its
 *  cluster's. The cluster's `stage` column is the platform's and is not read here. */
export function loadAppCluster(db: Db, appId: string): AppCluster {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) throw errNotFound(`app ${appId}`);
  const cluster = db.select().from(clusters).where(eq(clusters.id, app.clusterId)).get();
  if (!cluster) throw errNotFound(`cluster ${app.clusterId} for app ${appId}`);
  return { name: app.name, host: app.host, domain: cluster.domain, clusterName: cluster.name, stage: app.stage, clusterId: cluster.id };
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
      const state = assertDeployState(await clusterReader.readDeployState(), ac.domain, "app");
      ctx.log("meta", `target ${ac.domain} attested for ${ac.name} at ${ac.stage} — deploy-state generation ${state.generation}`);
    },
  };
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
   *  run time. */
  resolver: ClusterKubeResolver;
  catalogRepoUrl: string;
  argoWatchTimeoutMs: number;
  /** The tenant's ONE DNS record (the wildcard or the zone, as its routing names it): tenant-offboard
   *  and tenant-purge remove it, tenant-set-routing moves it. Optional but UNCONDITIONALLY needed by
   *  those steps — absent ⇒ they fail loud, never a silent skip. */
  dns?: DnsProvider;
  /** Deletes the tenant's argo-sync grant beside its member AppProjects. Optional and skipped when
   *  absent: the writer is what PROVISIONED the grant, so a removal running without it has none to
   *  take back — the same shape the consumer offboard's grant delete has. */
  buildRbac?: BuildRbacWriter;
  /** The public apex (global.unitApex) of a cluster, read off its values chain on the platform repo
   *  — the tenant registrations's own repo is catalog, so the apex arrives as a resolver, the same
   *  shape the build-plane FQDN arrives in. */
  resolveUnitApex: (domain: string, stage: Stage) => Promise<string>;
  /** Destroys the tenant's crypto entry `<stage>/tenants/<guid>` — the purge inverse of the seed
   *  create-tenant does. Optional and skipped when absent, the same shape buildRbac has: the seeder is
   *  what WROTE the entry, so a purge running without one has nothing it could take back. The step
   *  says which of the two happened rather than passing over it. */
  seeder?: VaultSeeder;
  /** Withdraws the tenant's bucket keys — the purge inverse of the mint create-tenant does. Optional
   *  and skipped when absent, the same shape seeder has: the store is what MINTED the keys, so a
   *  purge running without one has none it could take back, and the step says so. */
  objectStore?: ObjectStore;
  /** The platform's GitHub App — what created a tenant's apps repository. It deletes nothing
   *  (#241): the repository stands when the tenant goes. */
  githubApp?: GitHubApp;
  /** The build registrations (registrations/<unit>/build.yaml) the bundle's build-only onboarding
   *  wrote — its removal goes with the tenant's last app, and the orphan purge (#241) reads them to
   *  say which one nothing accounts for. Optional and said when absent. */
  buildRegistrations?: Pick<Registrations, "removeBuildRegistration" | "readBuildRegistration" | "readUnitStages" | "listBuildRegistrations" | "branch">;
  /** The units the catalog's `tenant.buildRepos` names, read off its books branch — what accounts
   *  for a build-only registration beside a tenant's own apps bundle (#241: the first purge listed
   *  the catalog's own build units as orphaned and took three of the customer's repositories). */
  catalogBuildUnits?: (signal?: AbortSignal) => Promise<string[]>;
}

/** A tenant + its cluster context, resolved from the tenants row (tnt_) and its clusters row. The
 *  guid and the STAGE are the row's own (every member is named `<guid>-<member>-<stage>`); the domain
 *  is the cluster's. The tenant analogue of AppCluster. */
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
  /** How the tenant's members are addressed below its zone, as recorded on its row: what its DNS
   *  record is named and where its IdP answers (plugins/unit/shared/unit-host.ts). */
  routing: MemberRouting;
  /** The tenant's own domain, or "" where it is reached at its zone (plugins/unit/shared/unit-host.ts). */
  ownDomain: string;
  /** The hosts that redirect to the own domain; empty without one. */
  ownDomainRedirects: string[];
  /** The image tags approved for this tenant alone, per app and build (shared/tenant.ts). */
  approvedTags: Record<string, Record<string, string>>;
  /** The owner the tenant was onboarded under — what a bundle created later is onboarded under too. */
  owner: string;
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
    routing: tenant.routing,
    ownDomain: tenant.ownDomain,
    ownDomainRedirects: tenant.ownDomainRedirects,
    approvedTags: tenant.approvedTags,
    owner: tenant.owner ?? tenant.subdomain,
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
      const state = assertDeployState(await clusterReader.readDeployState(), tc.domain, "tenant");
      ctx.log("meta", `target ${tc.domain} attested for ${tc.guid} at ${tc.stage} — deploy-state generation ${state.generation}`);
    },
  };
}
