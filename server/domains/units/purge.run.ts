import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps, clusters } from "../../db/schema/inventory.ts";
import { AppError, errNotFound, errValidation } from "../../kernel/errors.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { consumerArgoAppName } from "../../../shared/consumer.ts";
import { RELAY_NAMESPACE, renderSmtpOpsGrant } from "./build-rbac.ts";
import { localTx } from "../../executor/stepkit.ts";
import { assertDeployState, clearRelocationHold, unitStaysRegistered, type LifecyclePorts } from "./lifecycle.ts";
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

// purge / force-offboard (the orphan-removal companion to offboard.run.ts). A consumer onboard that
// FAILS after it has created cluster/Vault artifacts but BEFORE the final record-inventory step
// leaves an ORPHAN the normal offboard cannot reach: onboard writes the inventory row LAST, so a
// failure at watch-sync/smoke (e.g. the app crash-loops) means NO apps row exists → the consumer
// never appears in the Consumers list → there is no offboard action → the pointer, the generated
// ArgoCD Application, the AppProject, the namespace, the Vault secrets and the provisioned MongoDB
// user+db all linger with no UI/API way to remove them. purge removes that footprint BY NAME,
// deriving every artifact's identity from name+stage+cluster per the G1 identity law, so it works
// even when loadAppCluster finds no row. It reaches everything offboard reaches and more — it is safe
// to run on a healthy, fully-onboarded consumer too, so there is ONE reliable removal path — but it
// reaches it for ONE STAGE, exactly as offboard does (see SCOPE below): "more" means it needs no
// inventory row and does not stall on a prune that never completes, never that it takes a whole unit.
//
// DESIGN — a distinct RUN_KIND "consumer-purge", NOT a force-mode on consumer-offboard, because the two address a
// target DIFFERENTLY and that difference is the whole point:
//   - offboard is ROW-driven: params { appId }, loadAppCluster(appId) resolves name/domain/stage/
//     cluster, targetKind "app". An orphan has NO row → no appId → offboard structurally cannot
//     name it.
//   - purge is NAME-driven: params { consumerName, stage, clusterId }, identity derived from the
//     cluster row + the name (G1), targetKind "cluster" (like onboard's plan, whose app row does not
//     exist yet either). No inventory row is required at any point.
// Keeping them separate leaves offboard's strict, row-anchored contract untouched and gives purge a
// distinct, honest plan summary + UI entry.
//
// Every step is IDEMPOTENT and, with TWO exceptions, FAIL-SOFT: a missing artifact is fine (already
// gone → no-op), a re-run is fine. The exceptions are remove-dns — a DNS API failure fails the run,
// because an address left pointing nowhere is the one leftover no purge may leave behind — and
// assert-no-orphans, which reads back what the fail-soft deletes only logged about and refuses to let
// record-purge settle the row over anything still standing. The ONE hard gate is attest-target (mutating): purge refuses to act on a cluster
// whose deploy-state does not match the target domain/stage — a force-remove must never fire at the
// wrong cluster. The load-bearing difference from offboard is watch-removal: offboard THROWS when the
// app never prunes; purge only OBSERVES the prune best-effort (an orphan is precisely the crash-loop
// that never reaches a clean Missing) and continues, because delete-namespace is the backstop that
// force-reaps the workloads + the ServiceClaim regardless.
//
// CASCADE — how the MongoDB user+db (and every app-managed resource) is deprovisioned. The consumer
// chart ships a ServiceClaim rendered INTO the consumer namespace by the generated Application; the
// service-provisioner watches ServiceClaim deletion and deprovisions the mongo user+db. TWO
// independent paths reap it, so purge needs no dedicated ServiceClaim port:
//   1. remove-pointer → the consumers ApplicationSet stops generating the Application → ArgoCD prunes
//      it (ServiceClaim included) → deprovision. The graceful path (watch-removal waits for it).
//   2. delete-namespace → k8s garbage-collects the ServiceClaim (its finalizer holds the namespace
//      Terminating until the provisioner deprovisions) → deprovision. The backstop that fires even
//      when the app never prunes. It ALSO carries the consumer's credentials Secret + the leftover
//      cert-manager TLS Secret out with the namespace.
// The AppProject, the namespace and the Vault entries are MANAGER-managed (not app-managed, so the
// prune never touches them) — purge deletes those explicitly.
//
// SCOPE — purge is keyed on ONE stage (name + stage + cluster), so it removes one stage's footprint, not
// a whole unit's, and it obeys the same per-stage/per-unit split offboard does (offboard.run.ts SCOPE).
// The build-namespace grants, secret/build/<name>/repo-pat, the ONE build webhook on the consumer repo
// and the release kit in it are shared by every stage of the unit, so purge keeps them while another
// `<stage>.yaml` stands and takes them with the unit's last stage. It asks the registration tree through
// unitStaysRegistered, which is why the answer is right even here: a purge whose own registration was
// never written still reads the tree, and an orphan of a unit that stands nowhere else takes everything.

export const PurgeParams = z.object({
  // The consumer name == namespace == AppProject == pointer name (G1). Same shape onboard/offboard use.
  consumerName: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/),
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"),
});
export type PurgeParams = z.infer<typeof PurgeParams>;

/** purge carries the SAME ports as offboard: the lifecycle set (registrations + per-cluster resolver +
 *  watch budget) plus the VaultSeeder (the consumer-tier ceremony secrets of this stage and the
 *  build-tier repo PAT are destroyed through the SAME write-only adapter onboard seeded them with).
 *  Identical to OffboardPorts;
 *  declared here so purge does not import from offboard.run.ts (kept editable by another agent). */
export type PurgePorts = LifecyclePorts & {
  seeder: VaultSeeder;
  /** The GitHub consumer client — purge removes the consumer's build webhook with the unit's LAST stage
   *  (self-contained, fail-soft). Optional: absent ⇒ the remove-webhook step logs + skips (never blocks
   *  purge). */
  github?: GitHubConsumer;
  /** The consumer-repo writer — purge git-rm's the release-kit (release/ + the workflow) from the
   *  consumer repo BY NAME, with the unit's LAST stage (self-contained, fail-soft). Optional: absent ⇒
   *  the remove-release-kit step logs + skips (never blocks purge). */
  consumerRepo?: ConsumerRepo;
  /** The build-grant writer — purge deletes this stage's argo-sync Role + RoleBinding BY NAME, and the
   *  `<name>-build` pair with the unit's LAST stage (fail-soft). Optional: absent ⇒ the
   *  delete-build-rbac step logs + skips (never blocks purge). */
  buildRbac?: BuildRbacWriter;
  /** The repository-credential writer — purge deletes the unit's ArgoCD repository Secret BY NAME
   *  (fail-soft, like the grants). */
  repoCredential?: RepoCredentialWriter;
  /** The unit's public DNS record — purge removes it (remove-dns). Fail-CLOSED unlike the
   *  rest of this teardown: purge is the run kind after failed offboards, exactly where a record left
   *  pointing nowhere would appear, so an API failure fails the run rather than skipping it. */
  dns?: DnsProvider;
};

interface PurgeTarget {
  name: string;
  domain: string;
  stage: Stage;
  clusterId: string;
}

/** Derive the target identity from name+stage+cluster ALONE — no inventory row required (that is the
 *  whole point). The cluster row is the authority for the domain; the passed stage is cross-checked
 *  against the cluster's own stage (a cluster is exactly one stage) so a mistyped stage fails closed
 *  rather than pointing the teardown at the wrong pointer path / Vault tier. */
function loadPurgeTarget(db: Db, p: PurgeParams): PurgeTarget {
  const cluster = db.select().from(clusters).where(eq(clusters.id, p.clusterId)).get();
  if (!cluster) throw errNotFound(`cluster ${p.clusterId}`);
  if (cluster.stage !== p.stage) {
    throw errValidation(`stage mismatch: cluster ${p.clusterId} is ${cluster.stage}, purge targets ${p.stage}`);
  }
  return { name: p.consumerName, domain: cluster.domain, stage: cluster.stage, clusterId: cluster.id };
}

/** The apps row for this name on this cluster, or undefined — purge NEVER requires it. Present ⇒
 *  record-purge marks it offboarded and remove-repo-pat revokes its sealed clone credential;
 *  absent ⇒ a true orphan (onboard died before record-inventory), and purge reaps the cluster/Vault
 *  footprint by name anyway with nothing to mark. */
function findAppRow(db: Db, t: PurgeTarget): typeof apps.$inferSelect | undefined {
  return db.select().from(apps).where(and(eq(apps.clusterId, t.clusterId), eq(apps.name, t.name))).get();
}

function purgeSteps(ports: PurgePorts, params: PurgeParams): Step[] {
  const p = params;
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        // The ONE fail-closed gate (step 0 of this mutating run): the target cluster must still be a
        // provisioned hostyour cluster whose deploy-state agrees with the derived domain/stage. A
        // force-remove that fired at the wrong cluster would delete a foreign namespace/AppProject,
        // so this refuses BEFORE any deletion. Read on the TARGET cluster's own reader (a slave over
        // its bearer, or the master). Cannot reuse lifecycle's attestTargetStep — that one is keyed on an
        // appId via loadAppCluster; purge is keyed on the name.
        const t = loadPurgeTarget(ctx.db, p);
        const { clusterReader } = await ports.resolver.resolve(t.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), t.domain, t.stage, "consumer");
        ctx.log("meta", `target ${t.domain} (${t.stage}) attested for purge of ${t.name} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "remove-registration",
      title: "Remove the consumer registration (GitOps un-deploy)",
      run: async (ctx) => {
        // Remove registrations/<name>/<stage>.yaml so ArgoCD prunes the generated Application (→
        // workloads + ServiceClaim → the provisioner deprovisions the mongo user+db). IDEMPOTENT: a
        // true orphan may have died BEFORE write-registration, so an absent registration is the normal
        // case, not an error — removeRegistration THROWS on absence, so read first and only remove
        // when present.
        const t = loadPurgeTarget(ctx.db, p);
        // The relocation mark goes FIRST, and BEFORE the absent-registration return: purge reaps a
        // namespace whose registration is already gone too, and deleting that namespace hands its
        // ServiceClaims to the very teardown the mark disarms.
        const { clusterReader } = await ports.resolver.resolve(t.clusterId);
        await clearRelocationHold(ctx, clusterReader, [t.name], t.name);
        const current = await ports.registrations.readRegistration(t.stage, t.name);
        if (!current) {
          ctx.checkpoint({ registration: null, removed: false });
          ctx.log("meta", `no registration for ${t.name} at ${t.stage} — already absent, nothing to remove`);
          return;
        }
        const { commit, unitRemoved } = await ports.registrations.removeRegistration(t.stage, t.name, ctx.runId);
        ctx.checkpoint({ registration: `registrations/${t.name}/${t.stage}.yaml`, removed: true, unitRemoved, commit });
        ctx.log("meta", `registration for ${t.name} (${t.stage}) removed (${commit}) — the ArgoCD on ${t.domain} will now prune the app`);
      },
    },
    {
      name: "watch-removal",
      title: "Wait (best-effort) for ArgoCD to prune the app",
      run: async (ctx) => {
        // FAIL-SOFT — this is the load-bearing difference from offboard. offboard THROWS when the app
        // never goes Missing; purge only OBSERVES the prune and CONTINUES either way, because an
        // orphan is precisely the crash-looping / stuck app that never reaches a clean Missing, and
        // blocking the teardown on it would strand exactly the consumer purge exists to reap.
        // delete-namespace (next-but-one) force-reaps the workloads + the ServiceClaim regardless, so
        // giving the graceful prune a bounded chance here — then moving on — loses nothing.
        const t = loadPurgeTarget(ctx.db, p);
        const appName = consumerArgoAppName(t.name, t.stage);
        const gone = (s: { health: string }): boolean => s.health === "Missing";
        try {
          const { argoReader, argoNamespace } = await ports.resolver.resolve(t.clusterId);
          const status = await argoReader.watchApplication(argoNamespace, appName, gone, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
          const pruned = gone(status);
          ctx.checkpoint({ application: appName, pruned, lastHealth: status.health });
          ctx.log(
            "meta",
            pruned
              ? `Application ${appName} pruned — the consumer is no longer deployed`
              : `Application ${appName} not pruned within the watch budget (last health=${status.health})${status.message ? ` (${status.message})` : ""} — continuing; delete-namespace will force-reap the workloads + ServiceClaim`,
          );
        } catch (err) {
          // A read failure here (ArgoCD unreachable) must NOT stop the teardown — if the master surface
          // is genuinely down, the later master-side deletes (delete-appproject) fail loud + retryable
          // on their own. Observe-and-continue keeps purge reaping everything it CAN reach.
          ctx.checkpoint({ application: appName, pruned: false, watchError: err instanceof Error ? err.message : String(err) });
          ctx.log("meta", `could not confirm the prune of ${appName} (${err instanceof Error ? err.message : String(err)}) — continuing; delete-namespace will force-reap the workloads`);
        }
      },
    },
    {
      name: "delete-repo-credential",
      title: "Delete the ArgoCD repository credential",
      run: async (ctx) => {
        // The same inverse offboard runs, derived from the NAME alone — an orphan may have died
        // before the credential existed, so an absent Secret is the normal case. Fail-soft like the
        // grants: what would be left behind is a Secret no Application uses.
        const t = loadPurgeTarget(ctx.db, p);
        if (!ports.repoCredential) {
          ctx.log("meta", `no repository-credential writer wired — the ArgoCD repo Secret for ${t.name} is left as it is`);
          return;
        }
        try {
          const { argoNamespace } = await ports.resolver.resolve(t.clusterId);
          const { deleted } = await ports.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(t.name));
          ctx.checkpoint({ repoCredential: consumerRepoCredentialName(t.name), deleted });
          ctx.log("meta", deleted ? `ArgoCD repository credential for ${t.name} deleted` : `no ArgoCD repository credential for ${t.name} — already absent`);
        } catch (err) {
          ctx.log("meta", `could not delete the ArgoCD repository credential for ${t.name} (${err instanceof Error ? err.message : String(err)}) — continuing the teardown`);
        }
      },
    },
    {
      name: "delete-smtp-ops-grant",
      title: "Delete the unit's mail-ops grant (it goes with the unit's last stage)",
      run: async (ctx) => {
        // The same inverse offboard runs, derived from the NAME alone — an orphan may have died before
        // the grant existed, so an absent one is the normal case. Per UNIT and not per stage: the
        // dashboard it arms runs in the unit's namespace whatever stage it was onboarded at, so a purge
        // of one stage would blind a surviving stage's dashboard. Fail-soft like the rest of the
        // teardown, and the tree read sits INSIDE that body deliberately: a read that fails keeps the
        // grant, which is the direction that cannot strip a surviving stage.
        //
        // It is the one per-unit fence a reconciler cannot render — the relay's namespace stands on the
        // MASTER and a slave-hosted unit's reconciler is registered for one namespace — so it is the
        // one this run still deletes by hand (hostyour-cloud#174).
        const t = loadPurgeTarget(ctx.db, p);
        if (!ports.buildRbac) {
          ctx.log("meta", `no build RBAC writer wired — the mail-ops grant for ${t.name} is left as it is`);
          return;
        }
        try {
          const stageOnly = await unitStaysRegistered(ctx, ports.registrations, t, "the mail-ops grant");
          if (stageOnly) {
            ctx.checkpoint({ smtpOpsGrantDeleted: 0, scope: "stage" });
            ctx.log("meta", `mail-ops grant for ${t.name} kept — the unit still stands at another stage and the grant is the unit's`);
            return;
          }
          const { deleted } = await ports.buildRbac.deleteBuildRbac([renderSmtpOpsGrant({ name: t.name })]);
          ctx.checkpoint({ smtpOpsGrantDeleted: deleted, scope: "unit" });
          ctx.log("meta", deleted ? `${deleted} mail-ops grant object(s) for ${t.name} deleted from ${RELAY_NAMESPACE}` : `no mail-ops grant for ${t.name} — already absent`);
        } catch (err) {
          ctx.log("meta", `could not delete the mail-ops grant for ${t.name} (${err instanceof Error ? err.message : String(err)}) — continuing the teardown`);
        }
      },
    },
    {
      name: "delete-namespace",
      title: "Delete the target-cluster namespace (backstop reap)",
      run: async (ctx) => {
        // The backstop that makes purge complete even when the prune never happened: deleting the
        // namespace garbage-collects EVERY namespaced resource — the workloads, the ServiceClaim (whose
        // finalizer holds the namespace Terminating until the provisioner deprovisions the mongo
        // user+db), the consumer's credentials Secret and the leftover cert-manager TLS Secret. By G1
        // the namespace == the consumer name; the delete runs on the RESOLVED target client (the
        // the slave's own reader for a slave, the master's for a master — never master-only). Idempotent +
        // non-blocking: an already-absent namespace resolves deleted:false; a present one is issued the
        // delete without waiting on finalizers.
        const t = loadPurgeTarget(ctx.db, p);
        const { clusterReader } = await ports.resolver.resolve(t.clusterId);
        const { deleted } = await clusterReader.deleteNamespace(t.name);
        ctx.checkpoint({ namespace: t.name, deleted });
        ctx.log(
          "meta",
          deleted
            ? `namespace ${t.name} deleted on the target cluster — its ServiceClaim (→ mongo deprovision) and credentials Secret go with it`
            : `namespace ${t.name} was already absent on the target cluster — nothing to delete`,
        );
      },
    },
    {
      name: "remove-webhook",
      title: "Remove the consumer's build webhook (self-contained teardown)",
      run: async (ctx) => {
        // The inverse of onboard's setup-webhook, BY NAME. It names no host — the delete matches the
        // EventListener path on whichever address the hook carries (onboard-webhook.ts), which is what
        // a purge needs most: the run kind exists for the states nobody recorded. PER UNIT — the repo
        // carries exactly ONE hook however many stages the unit is deployed at — so it is kept while
        // another stage stands, whose releases fire through it. Fail-soft: for a true orphan (no
        // inventory row) the repoURL + sealed PAT are unknown, so removeConsumerWebhook logs + skips
        // rather than crash; when a row exists it opens the PAT and deletes the hook. A removal failure
        // never blocks purge. Runs BEFORE remove-repo-pat (that step revokes the sealed clone credential).
        const t = loadPurgeTarget(ctx.db, p);
        if (await unitStaysRegistered(ctx, ports.registrations, t, "the build webhook")) return;
        const row = findAppRow(ctx.db, t);
        await removeConsumerWebhook(ctx, {
          github: ports.github,
          consumerName: t.name,
          repoURL: row?.repoUrl,
          repoCredentialId: row?.repoCredentialId,
        });
      },
    },
    {
      name: "remove-dns",
      title: "Remove the unit's public DNS record",
      run: async (ctx) => {
        // The inverse of provision-dns (no address is left pointing nowhere — without
        // exception; purge runs after failed offboards, exactly where the leftover would appear, so
        // this one step is fail-CLOSED where its neighbours are fail-soft). Absent record = the
        // idempotent no-op, so a true orphan that never reached provision-dns removes nothing.
        const t = loadPurgeTarget(ctx.db, p);
        const unitApex = unitApexFromChain(await ports.registrations.readClusterValueFiles(t.domain, t.stage));
        await removeUnitDns(ctx, { dns: ports.dns, unit: t.name, recordName: consumerUnitHost(t.name, unitApex) });
      },
    },
    {
      name: "remove-release-kit",
      title: "Remove the release kit from the consumer repo (self-contained teardown)",
      run: async (ctx) => {
        // The inverse of onboard's inject-release-kit, BY NAME. PER UNIT — the repo is the unit's, not
        // the stage's, and the kit is what mints a release for every stage — so it is kept while another
        // stage stands. Fail-soft: for a true orphan (no inventory row) the repoURL + sealed PAT are
        // unknown, so removeReleaseKit logs + skips rather than crash; when a row exists it opens the PAT
        // and git-rm's release/ + the workflow. A removal failure never blocks purge. Runs BEFORE
        // remove-repo-pat (that step revokes the sealed clone credential the consumer-repo writer opens).
        const t = loadPurgeTarget(ctx.db, p);
        if (await unitStaysRegistered(ctx, ports.registrations, t, "the release kit")) return;
        const row = findAppRow(ctx.db, t);
        await removeReleaseKit(ctx, {
          consumerRepo: ports.consumerRepo,
          consumerName: t.name,
          repoURL: row?.repoUrl,
          repoCredentialId: row?.repoCredentialId,
        });
      },
    },
    {
      name: "remove-repo-pat",
      title: "Remove the unit's repo PAT (local build Vault + sealed credential)",
      run: async (ctx) => {
        // The inverse of onboard's seed-repo-pat: delete secret/build/<name>/repo-pat on the LOCAL
        // build-plane Vault — the one place the seed wrote — via the MANAGER's Vault adapter
        // (never a shell). Idempotent: an already-absent entry (404) is the seeder's no-op. Two scopes:
        // the Vault entry is stage-free (one build plane, one PAT per unit), so it goes only with the
        // unit's last stage, while the sealed clone credential is the ROW's own and is revoked either
        // way — and ONLY when an inventory row carries its id, since a true orphan (no row) never
        // recorded one.
        const t = loadPurgeTarget(ctx.db, p);
        if (!(await unitStaysRegistered(ctx, ports.registrations, t, "the repo PAT"))) {
          await ports.seeder.deleteBuildRepoPat({ consumerName: t.name });
          ctx.log("meta", `repo PAT removed — ${KV_MOUNT}/build/${t.name}/repo-pat deleted`);
        }
        const row = findAppRow(ctx.db, t);
        if (row?.repoCredentialId) {
          try {
            await ctx.creds.revoke(row.repoCredentialId, `consumer ${t.name} purged`);
          } catch (err) {
            // Idempotent: a re-run (or a prior offboard) finds the credential already revoked/purged.
            if (!(err instanceof AppError && err.code === "NOT_FOUND")) throw err;
          }
          ctx.log("meta", `the sealed clone credential of ${t.name} at ${t.stage} revoked`);
        } else {
          ctx.log("meta", `no inventory row for ${t.name} on this cluster → no sealed clone credential to revoke`);
        }
      },
    },
    {
      name: "remove-app-secrets",
      title: "Remove the consumer's ceremony secrets (Vault consumer tier)",
      run: async (ctx) => {
        // The inverse of onboard's seed-secrets: metadata-delete secret/<stage>/consumer/<name>/app
        // (all versions) so nothing of the consumer outlives it in Vault, and — decisively — so a later
        // re-onboard cannot INHERIT the old JWT signing keys + bootstrap token. The seed is cas=0
        // create-only: a surviving entry is not overwritten, it is inherited, reported as a benign
        // created:false. Idempotent: an absent entry (404) is the normal no-op (a consumer that
        // declared no secrets never had one). A real non-2xx (a 403 policy gap) fails loud + retryable.
        const t = loadPurgeTarget(ctx.db, p);
        await ports.seeder.deleteApp({
          stage: t.stage,
          consumerName: t.name,
        });
        ctx.log("meta", `ceremony secrets removed — ${KV_MOUNT}/${t.stage}/consumer/${t.name}/app deleted (all versions); a re-onboard mints fresh secrets instead of inheriting these`);
      },
    },
    {
      name: "remove-database-secrets",
      title: "Remove the consumer's database instance credentials (Vault consumer tier)",
      run: async (ctx) => {
        // The inverse of onboard's seed-postgres-superuser, BY NAME: metadata-delete
        // secret/<stage>/consumer/<name>/postgres. Called
        // UNCONDITIONALLY + 404-tolerant — purge is keyed on name+stage+cluster, not on a `services`
        // claim, so a consumer (or orphan) that never claimed postgresql simply 404s (the idempotent
        // no-op). A real non-2xx (a 403 policy gap) fails loud + retryable: a surviving entry would be
        // inherited by the next consumer of this name under the create-only (cas=0) re-seed.
        const t = loadPurgeTarget(ctx.db, p);
        await ports.seeder.deletePostgres({
          stage: t.stage,
          consumerName: t.name,
        });
        // The MongoDB instance credential goes with it, under the same argument in every part: the
        // per-consumer instance reads this leaf through ESO until its Application is pruned, the
        // call is unconditional because this run cannot know what the manifest asked for, and a
        // surviving entry would be inherited by the next consumer of this name.
        await ports.seeder.deleteMongodb({
          stage: t.stage,
          consumerName: t.name,
        });
        ctx.log("meta", `database instance credentials removed — ${KV_MOUNT}/${t.stage}/consumer/${t.name}/{postgres,mongodb} deleted (all versions); a re-onboard mints fresh ones instead of inheriting them`);
      },
    },
    {
      name: "assert-no-orphans",
      title: "Assert nothing of the consumer is left standing",
      run: async (ctx) => {
        // The same measurement offboard makes, for the same reason and with more force here: purge's
        // delete-repo-credential and delete-build-rbac are fail-soft, so this run can reach its end
        // having logged a warning over a Role or a Secret that is still standing. purge is also the
        // run kind an operator turns to when offboard refused at ITS scan — settling the row here without
        // looking would let the backstop record exactly what the stricter run kind declined to record.
        // What counts as an orphan, and what the platform keeps on purpose, is stated in
        // offboard-orphans.ts; both answers depend on whether the unit still stands at another stage.
        await assertNoOrphans(ctx, ports, loadPurgeTarget(ctx.db, p), "consumer-purge");
      },
    },
    {
      name: "record-purge",
      title: "Record the consumer as offboarded (only if a row exists)",
      run: async (ctx) => {
        // a settled row is soft, never hard-deleted — if an inventory row exists, flip it to
        // offboarded and tie it to this run. If NONE exists (the true orphan onboard died before
        // record-inventory), there is nothing to mark: the cluster + Vault footprint was already
        // purged by name, so this is a clean no-op, not a failure.
        const t = loadPurgeTarget(ctx.db, p);
        const row = findAppRow(ctx.db, t);
        if (!row) {
          ctx.checkpoint({ row: null });
          ctx.log("meta", `no inventory row for ${t.name} on cluster ${t.clusterId} — nothing to mark; the orphan's cluster + Vault footprint was purged by name`);
          return;
        }
        localTx(ctx, (tx) => tx.update(apps).set({ status: "offboarded", lastRunId: ctx.runId }).where(eq(apps.id, row.id)).run());
        ctx.checkpoint({ row: row.id, status: "offboarded" });
        ctx.log("meta", `consumer ${t.name} recorded as offboarded on cluster ${t.clusterId} (row kept)`);
      },
    },
  ];
}

export function makePurgeDef(ports: PurgePorts): RunDefinition<PurgeParams> {
  return {
    kind: "consumer-purge",
    paramsSchema: PurgeParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const t = loadPurgeTarget(db, params);
      const row = findAppRow(db, t);
      const stepDefs = purgeSteps(ports, params);
      return {
        kind: "consumer-purge",
        // The app row may not exist (orphan), so purge targets the CLUSTER — like onboard's plan,
        // whose app row does not exist yet either. offboard targets the app; purge cannot assume one.
        targetKind: "cluster",
        targetId: t.clusterId,
        summary:
          `Force-remove consumer "${t.name}" from ${t.domain} (${t.stage}) by NAME` +
          (row ? "" : " (no inventory row — an orphaned partial onboard)") +
          `: remove the registration, best-effort wait for the prune, delete the isolation AppProject + repository credential, delete the target-cluster namespace ` +
          `(its ServiceClaim → the MongoDB user+db is deprovisioned, its credentials Secret goes with it), remove the unit's DNS record, then permanently delete this stage's Vault ` +
          `secrets (ceremony + PostgreSQL — all versions, NOT recoverable)` +
          (row ? " and mark the inventory row offboarded (kept)." : ". No inventory row to mark.") +
          " What the unit's stages SHARE — the build-namespace grants, the repo PAT, the build webhook and the release kit — is removed ONLY when this is the unit's last registered stage, and kept while another stage stands." +
          " Every step is idempotent and safe to re-run; two fail the run rather than continue — the DNS removal on an API failure (no address may be left pointing nowhere), and the closing read-back if any object this purge was to take is still standing (the row is then left unsettled and the step retried).",
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        locks: [
          // The registration removal commits on the books branch; the values-chain read
          // (remove-dns resolves the unit apex off the install branch) rides that branch's worktree.
          { resource: "git-branch", key: ports.registrations.branch },
          { resource: "git-branch", key: t.domain },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => purgeSteps(ports, params),
  };
}
