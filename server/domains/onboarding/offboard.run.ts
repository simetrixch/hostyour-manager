import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { apps } from "../../db/schema/inventory.ts";
import { AppError, errNotFound } from "../../kernel/errors.ts";
import { consumerArgoAppName } from "../../../shared/consumer.ts";
import { consumerAdmissionPolicyName } from "./admission-policy.ts";
import { renderBuildRbac, renderConsumerArgoSync, renderSmtpOpsGrant } from "./build-rbac.ts";
import { localTx } from "../../executor/stepkit.ts";
import { attestTargetStep, clearRelocationHold, loadAppCluster, unitStaysRegistered, type LifecyclePorts } from "./lifecycle.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { VaultSeeder } from "./vault-seeder.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import type { ConsumerRepo } from "../../adapters/git/port.ts";
import type { BuildRbacWriter, RepoCredentialWriter } from "../../adapters/kube/port.ts";
import { removeConsumerWebhook } from "./onboard-webhook.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { removeUnitDns, consumerUnitHost } from "./unit-dns.ts";
import { unitApexFromChain } from "./admission-policy.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { removeReleaseKit } from "./onboard-release-kit.ts";
import { assertNoOrphans } from "./offboard-orphans.ts";

// offboard: remove the consumers/** pointer, wait for the master ArgoCD to
// prune, delete the isolation AppProject, delete the (now-empty) target-cluster namespace, destroy
// the Vault secrets, and mark the row offboarded. No gate-runner — it fits the standard synchronous
// plan() path. mutating: true ⇒ attest-target is the first step. A settled consumer row is
// NEVER hard-deleted — offboard flips its status to "offboarded" (a soft, re-onboardable state).
// The row is soft, but the SECRETS are not: offboard destroys this stage's Vault entries outright,
// because "re-onboardable" is only honest if a re-onboard mints fresh secrets. The seed is cas=0
// create-only, so anything left behind would be inherited by the next consumer of that name rather
// than replaced — see remove-app-secrets.
//
// SCOPE — offboard removes ONE STAGE of a unit, so each step has to know whether its object belongs to
// the stage or to the whole unit. Per stage: the registration, the Application, the AppProject, the
// repository credential, the admission policy, the namespace, the argo-sync grant and the
// <stage>/consumer/<name>/* Vault entries — a cluster carries exactly one stage, so a unit's stages sit
// on different clusters and each of those exists once per stage. The DNS record is per stage too, on a
// different ground: its name <name>.<unitApex> states no cluster and two clusters can share an apex, so
// what separates the stages' records is that provision-dns REFUSES a host another cluster's address
// already answers (unit-dns.ts) — a unit reaches a second stage only under a second apex. Per unit: the
// <name>-build namespace's two grants, secret/build/<name>/repo-pat, the ONE build webhook on the
// consumer repo and the release kit in it. The per-unit steps ask unitStaysRegistered (lifecycle.ts) and
// keep their object while another <stage>.yaml stands, so offboarding prod leaves a unit that still
// stands at dev able to build, release and deploy there.

export const OffboardParams = z.object({ appId: z.string().startsWith("app_") });
export type OffboardParams = z.infer<typeof OffboardParams>;

/** offboard deletes the isolation AppProject via the resolved projectWriter,
 *  deletes the target-cluster namespace via the resolved clusterReader (the namespace ArgoCD's
 *  CreateNamespace=true created but never prunes), and additionally removes the consumer's
 *  Vault entries — the consumer-tier ceremony secrets of this stage, plus the build-tier repo PAT once no
 *  other stage stands — so on top of the lifecycle set it carries the VaultSeeder (the same adapter
 *  onboard's seed-repo-pat and seed-secrets write through). */
export type OffboardPorts = LifecyclePorts & {
  seeder: VaultSeeder;
  /** The GitHub consumer client — offboard removes the consumer's build webhook with the unit's LAST
   *  stage (self-contained, fail-soft). Optional: absent ⇒ the remove-webhook step logs + skips (never
   *  blocks offboard). */
  github?: GitHubConsumer;
  /** The consumer-repo writer — offboard git-rm's the release-kit (release/ + the workflow) from the
   *  consumer repo with the unit's LAST stage (self-contained, fail-soft). Optional: absent ⇒ the
   *  remove-release-kit step logs + skips (never blocks offboard). */
  consumerRepo?: ConsumerRepo;
  /** The build-grant writer — offboard deletes this stage's argo-sync Role + RoleBinding, and the
   *  `<name>-build` pair with the unit's LAST stage (fail-soft), then READS the same grants back in
   *  assert-no-orphans. Optional: absent ⇒ the delete-build-rbac step logs + skips (never blocks
   *  offboard) and the scan reports that it could not look. */
  buildRbac?: BuildRbacWriter;
  /** The repository-credential writer — offboard deletes the unit's ArgoCD repository Secret (the
   *  inverse of provision-repo-credential) and reads it back in assert-no-orphans. Fail-soft like the
   *  grants: absent ⇒ log + skip. */
  repoCredential?: RepoCredentialWriter;
  /** The unit's public DNS record — offboard removes it (remove-dns) and reads it back in
   *  assert-no-orphans. Fail-CLOSED unlike the repo-side teardown, in both steps: an address left
   *  pointing nowhere is exactly what the rule forbids, so an unwired provider or an API failure
   *  fails the run. */
  dns?: DnsProvider;
};

function offboardSteps(ports: OffboardPorts, params: OffboardParams): Step[] {
  const appId = params.appId;
  return [
    attestTargetStep(ports, appId),
    {
      name: "remove-registration",
      title: "Remove the consumer registration (GitOps un-deploy)",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, appId);
        // The relocation mark goes FIRST, because the removal below is what sets off the prune, and
        // the prune is what deletes the ServiceClaims this offboard means to deprovision.
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        await clearRelocationHold(ctx, clusterReader, [ac.name], ac.name);
        // Read first, remove only when present — removeRegistration REFUSES an absent file, and on a
        // resume the absence is the normal case: a crash between this step's git commit and its `ok`
        // write re-runs the whole step, which must converge instead of failing on its own earlier
        // commit forever (purge's remove-registration and the tenant twin make the same read).
        if ((await ports.registry.readRegistration(ac.stage, ac.name)) === null) {
          ctx.log("meta", `registration for ${ac.name} at ${ac.stage} already removed — skipping (resume)`);
          return;
        }
        const { commit, unitRemoved } = await ports.registry.removeRegistration(ac.stage, ac.name, ctx.runId);
        ctx.checkpoint({ commit, unitRemoved });
        ctx.log(
          "meta",
          `registration for ${ac.name} (${ac.stage}) removed (${commit}) — the ArgoCD on ${ac.domain} will now prune the app` +
            (unitRemoved ? "; it was the unit's last stage, so its build.yaml went too" : "; the unit stays registered at its other stages"),
        );
      },
    },
    {
      name: "watch-removal",
      title: "Wait for ArgoCD to prune the app",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, appId);
        // The GENERATED Application is named `<name>-<stage>` (consumers appset) — watching the
        // bare name would read Missing immediately and falsely pass while the app still exists.
        const appName = consumerArgoAppName(ac.name, ac.stage);
        const gone = (s: { health: string }): boolean => s.health === "Missing";
        const { argoReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
        const status = await argoReader.watchApplication(argoNamespace, appName, gone, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
        if (!gone(status)) {
          throw errNotFound(`Application ${appName} was not pruned — last seen health=${status.health}${status.message ? ` (${status.message})` : ""}; the pointer is removed but the workloads linger, check the master ArgoCD`);
        }
        ctx.log("meta", `Application ${appName} pruned — the consumer is no longer deployed`);
      },
    },
    {
      name: "delete-admission-policy",
      title: "Delete the per-consumer admission policy",
      run: async (ctx) => {
        // The inverse of apply-admission-policy. It runs on the TARGET cluster (the policy is
        // cluster-scoped and was armed there), and BEFORE the namespace delete for the same reason
        // the project delete does: nothing is left fencing a unit that no longer exists.
        const ac = loadAppCluster(ctx.db, appId);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        const { deleted } = await clusterReader.deleteAdmissionPolicy(consumerAdmissionPolicyName(ac.name));
        ctx.checkpoint({ admissionPolicy: consumerAdmissionPolicyName(ac.name), deleted });
        ctx.log("meta", deleted ? `admission policy for ${ac.name} deleted` : `no admission policy for ${ac.name} — already absent`);
      },
    },
    {
      name: "delete-appproject",
      title: "Delete the per-consumer isolation AppProject",
      run: async (ctx) => {
        // After the Application is pruned, the isolation project has no more consumer Application
        // referencing it — delete it. Idempotent: an already-absent project resolves deleted:false.
        const ac = loadAppCluster(ctx.db, appId);
        const { projectWriter, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
        const { deleted } = await projectWriter.deleteAppProject(argoNamespace, ac.name);
        ctx.checkpoint({ appProject: ac.name, deleted });
        ctx.log(
          "meta",
          deleted
            ? `AppProject ${ac.name} deleted from ${argoNamespace} — the consumer's isolation project is removed`
            : `AppProject ${ac.name} was already absent in ${argoNamespace} — nothing to delete`,
        );
      },
    },
    {
      name: "delete-repo-credential",
      title: "Delete the ArgoCD repository credential",
      run: async (ctx) => {
        // The inverse of provision-repo-credential, and it goes with the AppProject: both are per-unit
        // objects the Controller wrote into the ArgoCD namespace outside any chart. Fail-soft like the
        // grants — what would be left behind is a credential Secret ArgoCD no longer uses for any
        // Application, surfaced for hand-removal rather than blocking the teardown.
        const ac = loadAppCluster(ctx.db, appId);
        if (!ports.repoCredential) {
          ctx.log("meta", `no repository-credential writer wired — the ArgoCD repo Secret for ${ac.name} is left as it is`);
          return;
        }
        try {
          const { argoNamespace } = await ports.resolver.resolve(ac.clusterId);
          const { deleted } = await ports.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(ac.name));
          ctx.checkpoint({ repoCredential: consumerRepoCredentialName(ac.name), deleted });
          ctx.log("meta", deleted ? `ArgoCD repository credential for ${ac.name} deleted` : `no ArgoCD repository credential for ${ac.name} — already absent`);
        } catch (err) {
          ctx.log("meta", `could not delete the ArgoCD repository credential for ${ac.name} (${err instanceof Error ? err.message : String(err)}) — continuing the teardown`);
        }
      },
    },
    {
      name: "delete-build-rbac",
      title: "Delete the build grants of this stage (the unit's own go with its last stage)",
      run: async (ctx) => {
        // The inverse of provision-build-rbac, and the ONE step that spans both scopes. The argo-sync
        // grant sits in the target cluster's ArgoCD namespace and names this stage's Application, so it
        // goes now. The other two sit in `<name>-build`, which is stage-free — one build namespace per
        // unit — so they go only with the unit's last stage: taking them earlier would leave the
        // surviving stage's release with no way to create its PipelineRun. Neither scope is ever pruned
        // by removing the registration; the Controller wrote all of them outside any chart.
        // Fail-soft — a teardown must not stall on a grant that was never provisioned, on a cluster
        // surface that is already down, or on a registration tree it cannot read; what is left behind is
        // an unbound Role, not access. The tree read sits INSIDE the fail-soft body deliberately: a read
        // that fails keeps every grant, which is the direction that cannot strip a surviving stage.
        const ac = loadAppCluster(ctx.db, appId);
        if (!ports.buildRbac) {
          ctx.log("meta", `no build RBAC writer wired — the grants for ${ac.name} are left as they are`);
          return;
        }
        try {
          const { argoNamespace } = await ports.resolver.resolve(ac.clusterId);
          const stageOnly = await unitStaysRegistered(ctx, ports.registry, ac, "the build-namespace grants");
          // The mail-OPS grant goes with the unit's last stage, like the build-namespace grants: it
          // is the unit's, not this stage's. Removed UNCONDITIONALLY rather than on a claim, because
          // this run is keyed on the appId and never reads services[] — and the delete is idempotent,
          // so a unit that never claimed smtp-ops simply has nothing there. That direction is the
          // safe one: the alternative leaves pods/exec in the relay's namespace bound to a
          // ServiceAccount whose namespace is being deleted.
          const grants = stageOnly
            ? [renderConsumerArgoSync({ name: ac.name, argoNamespace })]
            : [...renderBuildRbac({ name: ac.name, argoNamespace }), renderSmtpOpsGrant({ name: ac.name })];
          const { deleted } = await ports.buildRbac.deleteBuildRbac(grants);
          ctx.checkpoint({ buildRbacDeleted: deleted, scope: stageOnly ? "stage" : "unit" });
          ctx.log("meta", deleted ? `${deleted} build grant object(s) for ${ac.name} deleted` : `no build grants for ${ac.name} — already absent`);
        } catch (err) {
          ctx.log("meta", `could not delete the build grants for ${ac.name} (${err instanceof Error ? err.message : String(err)}) — continuing the teardown`);
        }
      },
    },
    {
      name: "delete-namespace",
      title: "Delete the (now-empty) target-cluster namespace",
      run: async (ctx) => {
        // ArgoCD's CreateNamespace=true CREATES the consumer namespace but does NOT delete it on prune —
        // after watch-removal the Application is gone yet the namespace lingers Active (only the default
        // ServiceAccount + a leftover cert-manager TLS Secret remain), violating "on delete, everything
        // but the inventory row is gone" (traces-not-facts-on-delete). Delete it explicitly. By the G1
        // identity law namespace == consumer name (ac.name). It runs on the RIGHT cluster — the resolved
        // clusterReader is the TARGET cluster's client (master-local for a master consumer, the per-slave
        // client for a slave), so the namespace is deleted WHERE the consumer ran, never master-only.
        // Ordered AFTER watch-removal so nothing live is stripped: the workloads are already pruned, so
        // the delete only reaps the empty shell. Idempotent + fail-soft: an already-absent namespace (a
        // re-run, or ArgoCD/an operator already removed it) resolves deleted:false. Non-blocking — the
        // adapter issues the delete and returns without waiting on finalizers (the `--wait=false` equivalent).
        const ac = loadAppCluster(ctx.db, appId);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        const { deleted } = await clusterReader.deleteNamespace(ac.name);
        ctx.checkpoint({ namespace: ac.name, deleted });
        ctx.log(
          "meta",
          deleted
            ? `namespace ${ac.name} deleted on the target cluster — the consumer leaves no lingering namespace`
            : `namespace ${ac.name} was already absent on the target cluster — nothing to delete`,
        );
      },
    },
    {
      name: "remove-dns",
      title: "Remove the unit's public DNS record",
      run: async (ctx) => {
        // The inverse of provision-dns (no address is left pointing nowhere — without
        // exception, which is why this one teardown step is fail-CLOSED where its neighbours are
        // fail-soft). The unit's host is <name>.<unitApex>; the apex comes off the cluster's values
        // chain, the same read provision-dns's plan made.
        const ac = loadAppCluster(ctx.db, appId);
        const unitApex = unitApexFromChain(await ports.registry.readClusterValueFiles(ac.domain, ac.stage));
        await removeUnitDns(ctx, { dns: ports.dns, unit: ac.name, recordName: consumerUnitHost(ac.name, unitApex) });
      },
    },
    {
      name: "remove-webhook",
      title: "Remove the consumer's build webhook (self-contained teardown)",
      run: async (ctx) => {
        // The inverse of onboard's setup-webhook: delete the consumer's push-webhook so no build fires
        // for an offboarded consumer. It names no host — the delete matches the EventListener path on
        // whichever address the hook carries, so a hook from a time when another cluster held the build
        // plane goes too (onboard-webhook.ts). PER UNIT — the repo carries exactly ONE hook however many
        // stages the unit is deployed at (ensureHook removes the stale ones), so it is kept while
        // another stage stands; that stage's releases fire through this hook. Runs BEFORE
        // remove-repo-pat — that step REVOKES the sealed clone credential, and this delete needs to open
        // it (ctx.creds.open throws on a revoked credential). Fail-soft: a removal failure logs a
        // warning and never blocks offboard (removeConsumerWebhook).
        const ac = loadAppCluster(ctx.db, appId);
        if (await unitStaysRegistered(ctx, ports.registry, ac, "the build webhook")) return;
        const app = ctx.db.select().from(apps).where(eq(apps.id, appId)).get();
        await removeConsumerWebhook(ctx, {
          github: ports.github,
          consumerName: ac.name,
          repoURL: app?.repoUrl,
          repoCredentialId: app?.repoCredentialId,
        });
      },
    },
    {
      name: "remove-release-kit",
      title: "Remove the release kit from the consumer repo (self-contained teardown)",
      run: async (ctx) => {
        // The inverse of onboard's inject-release-kit: git-rm release/ + .github/workflows/release.yml
        // from the consumer repo so an offboarded consumer no longer carries the platform release
        // tooling. PER UNIT — the repo is the unit's, not the stage's, and the kit is what mints a
        // release for every stage, so it is kept while another stage stands. Fail-soft: a removal
        // failure logs a warning and never blocks offboard (removeReleaseKit). Runs BEFORE
        // remove-repo-pat — that step REVOKES the sealed clone credential, and this git-rm needs to open
        // it (the consumer-repo writer opens the PAT to push).
        const ac = loadAppCluster(ctx.db, appId);
        if (await unitStaysRegistered(ctx, ports.registry, ac, "the release kit")) return;
        const app = ctx.db.select().from(apps).where(eq(apps.id, appId)).get();
        await removeReleaseKit(ctx, {
          consumerRepo: ports.consumerRepo,
          consumerName: ac.name,
          repoURL: app?.repoUrl,
          repoCredentialId: app?.repoCredentialId,
        });
      },
    },
    {
      name: "remove-repo-pat",
      title: "Remove the unit's repo PAT (local build Vault + sealed credential)",
      run: async (ctx) => {
        // The inverse of onboard's seed-repo-pat ("one PAT per consumer"), and the two halves have
        // different scopes. The Vault entry secret/build/<name>/repo-pat is stage-free — one build plane,
        // one PAT per unit — and the unit's build namespace clones, reads packages and pushes its bump
        // through it, so it goes only with the unit's last stage. The sealed clone credential is THIS
        // row's own (every stage's onboard seals its own PAT into the store), so it is revoked either
        // way and the surviving stage keeps the credential it was onboarded with. Runs AFTER the prune
        // (the build namespace's ExternalSecrets may still hold the PAT while the unit's last release
        // settles). Fail-closed on the Vault delete — a lingering PAT is a security residue, not a warn —
        // but idempotent: an already-absent entry (404) and an already-revoked/absent credential are the
        // retry no-ops.
        const ac = loadAppCluster(ctx.db, appId);
        if (!(await unitStaysRegistered(ctx, ports.registry, ac, "the repo PAT"))) {
          await ports.seeder.deleteBuildRepoPat({ consumerName: ac.name });
          ctx.log("meta", `repo PAT removed — ${KV_MOUNT}/build/${ac.name}/repo-pat deleted`);
        }
        const app = ctx.db.select().from(apps).where(eq(apps.id, appId)).get();
        if (app?.repoCredentialId) {
          try {
            await ctx.creds.revoke(app.repoCredentialId, `consumer ${ac.name} offboarded`);
          } catch (err) {
            // Idempotent: a re-run after a crash finds the credential already revoked/purged.
            if (!(err instanceof AppError && err.code === "NOT_FOUND")) throw err;
          }
          ctx.log("meta", `the sealed clone credential of ${ac.name} at ${ac.stage} revoked`);
        }
      },
    },
    {
      name: "remove-app-secrets",
      title: "Remove the consumer's ceremony secrets (Vault consumer tier)",
      run: async (ctx) => {
        // The inverse of onboard's seed-secrets: metadata-delete secret/<stage>/consumer/<name>/app
        // so nothing of the consumer outlives it in Vault. Both sides of the ordering are load-bearing:
        //  - AFTER watch-removal, because the consumer's OWN pods read this entry through ESO (role
        //    consumer-eso) and stop existing only once the Application is pruned — deleting earlier
        //    would strip a still-legitimately-live consumer. watch-removal throws when the prune never
        //    happens, so a run that leaves workloads lingering never reaches this step: the correct
        //    fail direction is a live consumer that KEEPS its secrets.
        //  - BEFORE record-offboard, because that flips the row to the soft, RE-ONBOARDABLE state
        //. A crash between the two would leave a re-onboardable row beside a surviving
        //    entry — precisely the silent-inheritance bug this step exists to kill. Delete, then record.
        // Fail-closed, and the case is stronger than the repo-pat's: a lingering PAT is a passive
        // credential residue, whereas a lingering app entry ACTIVELY corrupts the next onboard — the
        // seed is cas=0 create-only, so a surviving entry is not overwritten, it is INHERITED, and the
        // run reports `created: false` as a benign no-op while the "fresh" consumer holds the old
        // JWT signing keys and bootstrap token. An absent entry (404) stays the idempotent no-op: a
        // consumer whose manifest declared no secrets never had one.
        const ac = loadAppCluster(ctx.db, appId);
        await ports.seeder.deleteApp({
          stage: ac.stage,
          consumerName: ac.name,
        });
        ctx.log("meta", `ceremony secrets removed — ${KV_MOUNT}/${ac.stage}/consumer/${ac.name}/app deleted (all versions); a re-onboard mints fresh secrets instead of inheriting these`);
      },
    },
    {
      name: "remove-database-secrets",
      title: "Remove the consumer's database instance credentials (Vault consumer tier)",
      run: async (ctx) => {
        // The inverse of onboard's seed-postgres-superuser: metadata-delete
        // secret/<stage>/consumer/<name>/postgres. Ordered AFTER
        // watch-removal alongside remove-app-secrets: the per-consumer postgres pod + its metrics
        // exporter read this leaf through ESO (as Secret postgresql-credentials) until the Application
        // is pruned, so deleting earlier would strip a still-live instance. Called UNCONDITIONALLY +
        // 404-tolerant — offboard is keyed on the appId, not on a `services` claim, so a consumer that
        // never claimed postgresql simply 404s (the idempotent no-op, exactly like deleteApp for a
        // secret-less consumer). Fail-closed on any other non-2xx: a surviving entry would be inherited
        // by the next consumer of this name under the create-only (cas=0) re-seed — the same
        // silent-inheritance bug remove-app-secrets kills, for the same reason.
        const ac = loadAppCluster(ctx.db, appId);
        await ports.seeder.deletePostgres({
          stage: ac.stage,
          consumerName: ac.name,
        });
        // The MongoDB instance credential goes with it, under the same argument in every part: the
        // per-consumer instance reads this leaf through ESO until its Application is pruned, the
        // call is unconditional because this run cannot know what the manifest asked for, and a
        // surviving entry would be inherited by the next consumer of this name.
        await ports.seeder.deleteMongodb({
          stage: ac.stage,
          consumerName: ac.name,
        });
        ctx.log("meta", `database instance credentials removed — ${KV_MOUNT}/${ac.stage}/consumer/${ac.name}/{postgres,mongodb} deleted (all versions); a re-onboard mints fresh ones instead of inheriting them`);
      },
    },
    {
      name: "assert-no-orphans",
      title: "Assert nothing of the consumer is left standing",
      run: async (ctx) => {
        // The one step that MEASURES instead of acting: every object this run was supposed to remove is
        // read back from the cluster, the registration branch and the DNS provider, and the run fails
        // rather than record the row while any of it stands. It earns its place because the objects it
        // looks at are the ones no ArgoCD prune reaches — the controller wrote them outside any chart —
        // and because two of the steps that remove them are fail-soft, so a teardown can reach here
        // having reported success while a build grant or a repository Secret is still standing.
        // What counts as an orphan, and what the platform keeps on purpose, is stated in
        // offboard-orphans.ts; both answers depend on whether the unit still stands at another stage.
        await assertNoOrphans(ctx, ports, loadAppCluster(ctx.db, appId), "offboard");
      },
    },
    {
      name: "record-offboard",
      title: "Record the consumer as offboarded",
      run: async (ctx) => {
        // soft state, never a row delete. Keep the row (history + a future re-onboard);
        // flip status to offboarded and tie it to this run.
        localTx(ctx, (tx) => tx.update(apps).set({ status: "offboarded", lastRunId: ctx.runId }).where(eq(apps.id, appId)).run());
        const ac = loadAppCluster(ctx.db, appId);
        ctx.log("meta", `consumer ${ac.name} recorded as offboarded on cluster ${ac.clusterId} (row kept)`);
      },
    },
  ];
}

export function makeOffboardDef(ports: OffboardPorts): RunDefinition<OffboardParams> {
  return {
    kind: "offboard",
    paramsSchema: OffboardParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = offboardSteps(ports, params);
      return {
        kind: "offboard",
        targetKind: "app",
        targetId: params.appId,
        // States the Vault destruction plainly: the seeder is write-only, so nothing can read those
        // values back to restore them. The operator must see that at approve time, not discover it. The
        // per-unit rule is stated as a rule and not resolved here, so planning stays a read of the
        // inventory row and the answer is taken from the registration tree at the moment each step acts.
        summary: `Offboard consumer "${ac.name}" from ${ac.domain} (${ac.stage}): remove the registration, wait for ArgoCD to prune, delete the isolation AppProject + repository credential, delete the target-cluster namespace, remove the unit's DNS record, then permanently delete this stage's Vault secrets (ceremony + PostgreSQL — all versions, NOT recoverable) and mark offboarded. What the unit's stages SHARE — the build-namespace grants, the repo PAT, the build webhook and the release kit — is removed ONLY when this is the unit's last registered stage, and kept while another stage stands. The inventory row is kept.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Controller acts master-locally
        locks: [
          // The registration removal commits on the books branch; the values-chain read
          // (remove-dns resolves the unit apex off the install branch) rides that branch's worktree.
          { resource: "git-branch", key: ports.registry.branch },
          { resource: "git-branch", key: ac.domain },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => offboardSteps(ports, params),
  };
}
