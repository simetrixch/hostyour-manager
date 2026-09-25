// The onboard step factories + compensations, extracted from onboard.run.ts so that file stays a thin
// orchestrator — the DRY companion to plugins/unit/server/seed-repo-pat.ts / onboard-seed-postgres.ts (which are
// already such factories). Every step here reads only p.stage/p.clusterId/p.domain/
// p.consumerName/p.argoAppName/etc. The onboard-ONLY steps (check, write-registration, the build-only
// record) stay in the run file.
//
// Types come from onboard.run.ts as a TYPE-ONLY import (erased at runtime), exactly like
// plugins/unit/server/seed-repo-pat.ts — so the value dependency is one-directional (onboard.run.ts imports these
// factories) and there is no runtime import cycle.
import { eq, and } from "drizzle-orm";
import type { Step, Cleanup } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { appId } from "../../kernel/ids.ts";
import { errValidation } from "../../kernel/errors.ts";
import { probeTarget, probeDns } from "./onboard-deploy-probes.ts";
import { localTx } from "../../executor/stepkit.ts";
import type { AppProvenance, AppStatus, Stage } from "../../../shared/enums.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { RELAY_NAMESPACE, renderSmtpOpsGrant } from "#unit/server/build-rbac.ts";
import { buildConsumerSecretDataWithDerivations } from "#unit/server/secret-mint.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { keepUnitRepoCredential } from "./repo-credential-keep.ts";
import { provisionUnitDns, removeUnitDns, consumerUnitHost } from "#unit/server/unit-dns.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";

// The compensations below are IDEMPOTENT WITHOUT SWALLOWING: each one tolerates exactly the
// "already absent" outcome (a read-first skip, or a delete that resolves deleted:false) and lets every
// real failure propagate, so a kube/git error fails the cleanup step visibly and the run stays failed +
// re-abortable — the same contract the tenant abort has (create-tenant-abort.ts). A bare catch made a
// failed compensation and an absent object the same "ok": the abort reported "cleanup complete" while
// the registration, the AppProject and the grants all still stood.

/** The first of the three registration cleanups, run only on an explicit abort-with-cleanup: mark the
 *  registration `removing`, which is what makes the consumers ApplicationSet drop the generated
 *  Application — while the AppProject and the admission policy, generated off the same file, still
 *  stand for its deletion to run against (hostyour-cloud#213). Read-first: an absent registration is
 *  the normal case for a run that died before its commit, or a re-abort past the removal; a
 *  registration already marked is a re-abort that died between this commit and its `ok`. */
export function markRemovingCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "mark-removing",
    title: "Take the generated Application down",
    run: async (ctx) => {
      const current = await ports.registrations.readRegistration(p.stage, p.consumerName);
      if (current === null) {
        ctx.log("meta", `no registration for ${p.consumerName} at ${p.stage} — already absent, nothing to take down`);
        return;
      }
      if (current.entry.removing) {
        ctx.log("meta", `registration for ${p.consumerName} at ${p.stage} already marked removing — skipping (re-abort)`);
        return;
      }
      const { commit } = await ports.registrations.setRemoving(p.stage, p.consumerName, ctx.runId);
      ctx.log("meta", `registration for ${p.consumerName} (${p.stage}) marked removing (${commit}) — the ArgoCD on ${p.domain} will now prune the generated Application; its AppProject and admission policy stay until it is gone`);
    },
  };
}

/** The LAST compensation of a rolled-back deployable onboarding: the apps row record-provisional wrote
 *  as INTENT is settled "offboarded" — the soft, re-onboardable state an offboard leaves, the same
 *  one the create-tenant abort settles its row to — so no consumer nothing serves stands on the
 *  Consumers page as "provisioning" after everything behind it is gone (#199). Only a row still
 *  "provisioning" is touched: the abort's precondition already refused a live one, and a row another
 *  run has moved since is that run's. */
export function settleProvisionalRowCleanup(_ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "settle-provisional-row",
    title: "Record the rolled-back consumer as offboarded",
    run: async (ctx) => {
      const settled = localTx(ctx, (tx) => {
        const row = tx.select({ id: apps.id, status: apps.status }).from(apps).where(and(eq(apps.name, p.consumerName), eq(apps.stage, p.stage))).get();
        if (!row || row.status !== "provisioning") return row?.status ?? null;
        tx.update(apps).set({ status: "offboarded", lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(apps.id, row.id)).run();
        return "offboarded";
      });
      ctx.log("meta", settled === "offboarded"
        ? `consumer ${p.consumerName} (${p.stage}) recorded as offboarded — the provisioning row of this rolled-back onboarding is settled (row kept, re-onboardable)`
        : `consumer ${p.consumerName} (${p.stage}) row ${settled === null ? "absent" : `stands ${settled}`} — not this rollback's to settle`);
    },
  };
}

/** The compensation between the mark above and the registration removal below: wait for the master
 *  ArgoCD to actually prune the generated Application, while its AppProject still stands. Removing the
 *  file over a standing Application prunes the project it needs for its own deletion, and ArgoCD then
 *  refuses every operation on it — the Application keeps its deletionTimestamp for good. FAIL-LOUD,
 *  like the tenant abort and for its reason: an abort deletes no namespace, so there is no
 *  cluster-side backstop — a fan-in that will not prune must stop the abort visibly (the run stays
 *  failed, re-abortable; purge is the run kind that force-reaps). Unbounded, like the deployment wait
 *  (#140): a prune takes what it takes, and what ends it is Missing, ArgoCD's own DeletionError, or
 *  the operator's cancel. An Application that never existed (the run died before its first sync)
 *  reads Missing immediately, so this passes at once on a run with nothing deployed. */
export function watchConsumerPruneCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "watch-consumer-prune",
    title: "Wait for ArgoCD to prune the generated Application",
    run: async (ctx) => {
      const appName = p.argoAppName;
      const gone = (s: { health: string }): boolean => s.health === "Missing";
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const status = await argoReader.watchApplication(argoNamespace, appName, gone, { signal: ctx.signal, failFast: (s) => s.deletionError !== undefined });
      if (!gone(status)) {
        throw errValidation(
          `Application ${appName} was not pruned — ${status.deletionError ? `ArgoCD reports: ${status.deletionError}` : `last seen health=${status.health}${status.message ? ` (${status.message})` : ""}`}; ` +
            `the registration is marked removing but the workloads linger — re-abort once the master ArgoCD has pruned it, or purge`,
        );
      }
      ctx.log("meta", `Application ${appName} pruned — nothing of the consumer is deployed any more`);
    },
  };
}

/** The offboard inverse of write-registration, run once the prune was seen: the file goes, and with it
 *  the AppProject and the admission policy the units ApplicationSet generated from it. Read-first: an
 *  absent registration is a re-abort past this commit, or a run that died before its own. */
export function removeRegistrationCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "remove-consumer-registration",
    title: "Remove the consumer registration",
    run: async (ctx) => {
      if ((await ports.registrations.readRegistration(p.stage, p.consumerName)) === null) {
        ctx.log("meta", `no registration for ${p.consumerName} at ${p.stage} — already absent, nothing to remove`);
        return;
      }
      const { commit } = await ports.registrations.removeRegistration(p.stage, p.consumerName, ctx.runId);
      ctx.log("meta", `registration for ${p.consumerName} (${p.stage}) removed (${commit}) — the AppProject and the admission policy of the stage go with it`);
    },
  };
}

/** The offboard inverse of provision-repo-credential, run only on an explicit abort-with-cleanup. An
 *  already-absent Secret resolves deleted:false; an unwired writer never provisioned one. */
export function deleteRepoCredentialCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "delete-repo-credential",
    title: "Delete the ArgoCD repository credential",
    run: async (ctx) => {
      if (!ports.repoCredential) {
        ctx.log("meta", `no repository-credential writer wired — nothing was ever provisioned, nothing to take back`);
        return;
      }
      const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const { deleted } = await ports.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(p.consumerName, p.stage));
      ctx.log("meta", deleted ? `ArgoCD repository credential for ${p.consumerName} at ${p.stage} deleted` : `no ArgoCD repository credential for ${p.consumerName} at ${p.stage} — already absent`);
    },
  };
}

/** The abort inverse of seed-secrets: destroy the ceremony entry THIS run created (metadata-delete,
 *  all versions), so the next onboard of the name reaches created:true instead of inheriting this
 *  run's JWT signing keys and bootstrap token under the cas=0 create-only seed — the exact
 *  silent-inheritance defect offboard's remove-app-secrets kills, closed on the abort path too.
 *
 *  Registered by seed-secrets ONLY on created:true, never up front like its siblings: the seed's cas=0
 *  outcome IS the existence probe, and created:false means the entry belongs to an EARLIER onboard of
 *  this name — a compensation may undo only what this run created, and destroying a live consumer's
 *  standing entry on a re-onboard's abort would strip the very secrets its pods boot from. */
export function removeCeremonySecretsCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "remove-ceremony-secrets",
    title: "Destroy the ceremony secrets this run minted (Vault consumer tier)",
    run: async (ctx) => {
      await ports.seeder.deleteApp({ stage: p.stage, consumerName: p.consumerName });
      ctx.log("meta", `ceremony secrets removed — ${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/app deleted (all versions); a later onboard of "${p.consumerName}" mints fresh secrets instead of inheriting this run's`);
    },
  };
}

/** The teardown inverse of provision-smtp-ops-grant — registered by that step, run only on an
 *  explicit abort-with-cleanup. Tolerates an already-absent grant (idempotent).
 *
 *  IT IS THIS STAGE'S GRANT: the dashboard runs in the namespace `<name>-<stage>` and the grant
 *  binds that namespace's ServiceAccount under a name that carries the stage (build-rbac.ts), so
 *  another stage of the unit holds a grant of its own and this delete cannot reach it.
 *
 *  A BUILD-ONLY UNIT NEVER HAS ONE — it claims no services and has no namespace to run a dashboard in
 *  — so this compensation is armed on the deployable form alone (onboard-abort.ts). */
export function deleteSmtpOpsGrantCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "delete-smtp-ops-grant",
    title: "Delete this stage's mail-ops grant",
    run: async (ctx) => {
      if (!p.services.includes("smtp-ops")) {
        ctx.log("meta", `${p.consumerName} claims no smtp-ops — no mail-ops grant was ever written, nothing to take back`);
        return;
      }
      if (!ports.buildRbac) {
        ctx.log("meta", `no build RBAC writer wired — nothing was ever provisioned, nothing to take back`);
        return;
      }
      const { deleted } = await ports.buildRbac.deleteBuildRbac([renderSmtpOpsGrant({ name: p.consumerName, stage: p.stage })]);
      ctx.log("meta", deleted ? `mail-ops grant for ${p.consumerName} at ${p.stage} deleted from ${RELAY_NAMESPACE}` : `no mail-ops grant for ${p.consumerName} at ${p.stage} — already absent`);
    },
  };
}

/** The abort inverse of provision-dns, run only on an explicit abort-with-cleanup. Absent records are
 *  the no-op (removeUnitDns); a real DNS API failure stays fail-closed there. An UNWIRED provider is
 *  the log-skip here alone: provision-dns fails loud without one, so on such a manager no record
 *  was ever created and the abort has nothing to remove — the whole inverse is armed up front at
 *  write-registration, before the run knows whether it will ever reach provision-dns. */
export function removeDnsCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "remove-dns",
    title: "Remove the unit's public DNS record",
    run: async (ctx) => {
      if (!ports.dns) {
        ctx.log("meta", `no DNS provider wired — provision-dns could never have created a record on this manager, nothing to remove`);
        return;
      }
      await removeUnitDns(ctx, { dns: ports.dns, unit: p.consumerName, recordName: consumerUnitHost(p.host, p.stage, p.unitApex) });
    },
  };
}

/** attest-target: fail-closed deploy-state freshness check on the TARGET cluster (step 0 of a
 *  mutating run). Reads the deploy-state on the target's own reader (a slave over its bearer, or the
 *  master). The DOMAIN is compared and the cluster's stage is not: the deploy-state's stage is the
 *  platform's, and a unit at any stage may land on a cluster of any stage. */
export function attestTargetStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "attest-target",
    title: "Attest the target cluster (deploy-state fresh)",
    // The same reading before the approve (onboard-deploy-probes.ts); the step re-asks it at run time,
    // because step 0 of a mutating run is where the world is measured last before anything moves.
    probe: () => probeTarget(ports, p),
    run: async (ctx) => {
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const state = await clusterReader.readDeployState();
      if (!state) {
        throw errValidation(`target cluster "${p.domain}" has no hostyour-cloud deploy-state — is it a provisioned hostyour cluster? refusing to onboard`);
      }
      if (state.domain !== p.domain) {
        throw errValidation(`deploy-state mismatch: the cluster reports ${state.domain} but this run targets ${p.domain}`);
      }
      ctx.log("meta", `target ${p.domain} attested for ${p.consumerName} at ${p.stage} — deploy-state generation ${state.generation}`);
    },
  };
}

/** seed-secrets: mint + write the manifest-declared secrets into the target Vault, create-only (cas=0).
 *  `runtime` (optional) is the in-run memory an onboard shares with its `activate` step — the freshly
 *  minted bootstrap token is stashed there ONLY on a real create. */
export function seedSecretsStep(ports: OnboardPorts, p: DeployableOnboardParams, runtime?: { bootstrapToken?: string | undefined }): Step {
  return {
    name: "seed-secrets",
    title: "Seed the consumer secrets into the target Vault",
    run: async (ctx) => {
      if (p.secretSpecs.length === 0) {
        ctx.log("meta", "no secrets declared in the manifest — nothing to seed");
        return;
      }
      // A `generate` key is MINTED + verified here (the operator is never asked — requiredSecrets
      // excludes it); a required non-generate key MUST have been supplied at approve (fail closed);
      // an optional non-generate key is seeded only when supplied. All of it — including the RSA
      // keypair pairing + the complexity verification — is buildConsumerSecretData (secret-mint.ts).
      const { data, minted, publicKeys } = await buildConsumerSecretDataWithDerivations(
        p.secretSpecs,
        (key) => ctx.secrets.get(`consumer-secret:${key}`)?.toString("utf8"),
        () => ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:seed-secrets:deploy-git-credentials", runId: ctx.runId }),
      );
      const keys = Object.keys(data);
      if (keys.length === 0) {
        ctx.log("meta", "all declared secrets are optional and none were supplied — nothing to seed");
        return;
      }
      // ONE put carries the whole entry, and it is CREATE-ONLY (cas=0, seeder-port.ts): the mint
      // above is unconditional, so without cas=0 a re-run would silently rotate a live consumer's
      // keys out from under its running pods. An entry that already exists is left untouched and the
      // values minted for this run are discarded — this step is idempotent, as onboard claims.
      const { created } = await ports.seeder.seed({
        stage: p.stage,
        consumerName: p.consumerName,
        data,
      });
      const path = `${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/app`;
      if (!created) {
        // Say it plainly: an operator who added a key to the manifest and re-ran MUST see that
        // it did not land, rather than discover it as a missing env var at the consumer's boot.
        ctx.log("meta", `secrets already present at ${path} — left untouched (create-only). This run minted nothing new: re-running never rotates or extends an existing entry. To change it, rotate deliberately.`);
        return;
      }
      // Arm the inverse ONLY on a real create (see removeCeremonySecretsCleanup for why never up
      // front): from here the entry is this run's own, so an abort destroys it and the next onboard
      // reaches created:true again. Registered after the write by necessity — cas=0 is the existence
      // probe — so a crash between the Vault create and this line loses the armed inverse; the entry
      // then survives an abort and offboard/purge's remove-app-secrets remains its removal.
      ctx.registerCleanup(removeCeremonySecretsCleanup(ports, p));
      // Keep the freshly-minted bootstrap token in-run memory for a manifest-declared activation
      // call — reachable ONLY on a real create (the create-only re-run returned above), so the
      // value in `data` IS the live token, not a re-minted one Vault refused. Never persisted/logged
      // (the manifest schema requires tokenSecret to name a declared secret, so `data` always has it here).
      if (p.activation && runtime) runtime.bootstrapToken = data[p.activation.tokenSecret];
      ctx.log("meta", `seeded ${keys.length} secret(s) write-only into ${path}` + (minted.length ? `; platform-generated + verified: ${minted.join(", ")}` : ""));
      // A mail sender's DKIM key: the public half stays on the unit's row for the Mail page to publish
      // — only here, on the create that put its private half into Vault, so the two always match.
      const dkimKey = p.smtpEntry?.dkimKey;
      const dkimPublicKey = dkimKey !== undefined ? publicKeys[dkimKey] : undefined;
      if (dkimPublicKey !== undefined) {
        ctx.db.update(apps).set({ dkimPublicKey, updatedAt: new Date() }).where(and(eq(apps.name, p.consumerName), eq(apps.stage, p.stage))).run();
        ctx.log("meta", `the public half of ${dkimKey} is kept on ${p.consumerName}'s row — the Mail page publishes it as the DKIM key of the platform domain`);
      }
    },
  };
}

/** provision-repo-credential: keep the unit's ArgoCD repository access in the target's ArgoCD
 *  namespace by the one rule of repo-credential-keep.ts. A repository the owner's GitHub App reaches is
 *  fetched through the App's credential template (repo-creds-owner) and gets no Secret of its own; any
 *  other is fetched with its owner's PAT, written into the unit's repository Secret — the PAT lives only
 *  in the sealed store and the local build Vault, neither of which the target's ESO reads. Idempotent:
 *  a resume replaces the Secret in place. */
export function provisionRepoCredentialStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "provision-repo-credential",
    title: "Provision the ArgoCD repository credential",
    run: async (ctx) => {
      if (!ports.repoCredential) {
        throw errValidation(`onboard "${p.consumerName}" requires the repository-credential writer but none is wired on this manager — without it ArgoCD cannot fetch the private consumer repo and the generated Application can never sync`);
      }
      // The delete inverse is already armed: write-registration registered the WHOLE ordered rollback
      // (onboard-abort.ts) before the first mutation, so no step here arms its own piece any more.
      const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const name = consumerRepoCredentialName(p.consumerName, p.stage);
      const kept = await keepUnitRepoCredential(
        { store: ctx.creds, repoCredential: ports.repoCredential },
        { name: p.consumerName, stage: p.stage, repoURL: p.repoURL, credentialId: p.repoCredentialId, argoNamespace },
        { purpose: "consumer-onboard:provision-repo-credential", runId: ctx.runId },
      );
      if (kept.identity === "github-app") {
        ctx.checkpoint({ repoCredential: name, created: false });
        ctx.log("meta", `${p.repoURL} is reached by the owner's GitHub App — the generated Application fetches it through the App's credential template repo-creds-owner in ${argoNamespace}; ${name} ${kept.removed ? "stood with a token and is removed" : "is not written"}`);
        return;
      }
      ctx.checkpoint({ repoCredential: name, created: kept.created });
      ctx.log("meta", `ArgoCD repository credential ${name} ${kept.created ? "created" : "replaced"} in ${argoNamespace} — the generated Application fetches ${p.repoURL} with its owner's PAT`);
    },
  };
}

/** provision-smtp-ops-grant: write this stage's mail-OPS grant — read/exec on the relay's pods, in the
 *  relay's own namespace, bound to the ServiceAccount `<name>` in `<name>-<stage>` — for a unit whose
 *  stage registration attests `smtp-ops`, and register the delete inverse. A unit that claims nothing
 *  writes nothing and the step says so.
 *
 *  IT IS THE ONE PER-UNIT OBJECT NO RECONCILER RENDERS, and that is why it alone is applied here.
 *  The other five — the isolation AppProject, the
 *  admission policy with its Binding, the argo-sync grant and the two `<name>-build` grants — are
 *  rendered from the registration this run already commits (hostyour-cloud#174: a fence is rendered by
 *  the reconciler that manages the namespace it lands in). This grant lands in `postfix` ON THE
 *  MASTER, which the reconciler of a slave-hosted unit cannot reach at all — its in-cluster
 *  registration is restricted to one namespace — so no chart can render it and the Manager stays its
 *  writer.
 *
 *  Idempotent: the writer replaces the object in place on a resume. */
export function provisionSmtpOpsGrantStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "provision-smtp-ops-grant",
    title: "Provision the unit's mail-ops grant",
    run: async (ctx) => {
      // The claim is the plan-frozen services[] — the SAME one the registration commits and the
      // rendered admission policy reads — so the grant and the fence cannot disagree within one run.
      if (!p.services.includes("smtp-ops")) {
        ctx.log("meta", `${p.consumerName} claims no smtp-ops — no grant in ${RELAY_NAMESPACE}, and nothing of this unit may read the relay's queue`);
        return;
      }
      if (!ports.buildRbac) {
        throw errValidation("the build RBAC writer is not wired — without it this unit's queue dashboard could not read the relay it was granted");
      }
      const grant = renderSmtpOpsGrant({ name: p.consumerName, stage: p.stage });
      const { created } = await ports.buildRbac.applyBuildRbac([grant]);
      ctx.checkpoint({ smtpOpsGrant: `${grant.role.metadata.namespace}/${grant.role.metadata.name}`, created });
      ctx.log("meta", `mail-ops grant provisioned in ${RELAY_NAMESPACE} (${created} created, ${2 - created} replaced) — ${p.namespace} may read and exec the relay's pods`);
    },
  };
}

/** provision-dns: create the unit's ONE public record — A `<label>.<stage apex>`, pointing at
 *  the target cluster's own address — and register the remove inverse (the address belongs to
 *  the unit; a move is a content update of exactly this record). Fail-closed: an unwired provider or
 *  an API failure breaks the run. */
export function provisionDnsStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "provision-dns",
    title: "Provision the unit's public DNS record",
    probe: (ctx) => probeDns(ports, p, ctx),
    run: async (ctx) => {
      await provisionUnitDns(ctx, {
        dns: ports.dns,
        unit: p.consumerName,
        kind: "consumer",
        stage: p.stage,
        recordName: consumerUnitHost(p.host, p.stage, p.unitApex),
        clusterFqdn: p.domain,
        runKind: "consumer-onboard",
      });
    },
  };
}

/** smoke: verify what the PLATFORM put in the consumer namespace on the target cluster — the
 *  namespace itself and the ExternalSecrets that carry the unit's own secrets into it. Both are ours,
 *  and either missing means the onboarding did not finish.
 *
 *  A WORKLOAD THAT IS NOT AVAILABLE IS REPORTED, NOT REFUSED (#246), for the same reason the watch
 *  before it settles on Synced: whether the customer's images come up is their repository's
 *  business, and a run that fails on it says the platform failed when it delivered exactly what was
 *  asked. The names and the reasons are in the log and the checkpoint, so nothing is hidden. */
export function smokeStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "smoke",
    title: "Smoke-check the consumer namespace",
    run: async (ctx) => {
      // Smoke the consumer namespace on the TARGET cluster's own reader (a slave over its bearer).
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const smoke = await clusterReader.smoke(p.namespace);
      if (!smoke.namespaceExists) throw errValidation(`namespace ${p.namespace} does not exist after sync`);
      if (!smoke.externalSecretsReady) {
        throw errValidation(`ExternalSecrets are not all Ready in ${p.namespace} — the consumer's secrets did not materialize`);
      }
      const failing = smoke.workloads.filter((w) => !w.available);
      ctx.checkpoint({ namespaceExists: true, workloads: smoke.workloads.length, unavailable: failing.map((w) => `${w.kind}/${w.name}`), externalSecretsReady: true });
      ctx.log(
        "meta",
        failing.length === 0
          ? `smoke ok — ${smoke.workloads.length} workload(s) available, external secrets ready`
          : `smoke — the namespace stands and its external secrets are ready; ${failing.length} of ${smoke.workloads.length} workload(s) are not available yet: ${failing.map((w) => `${w.kind}/${w.name}${w.message ? ` (${w.message})` : ""}`).join(", ")} — that is the consumer repository's to fix, and the onboarding is done`,
      );
    },
  };
}

/** The values ONE apps-row upsert writes — every column the (name, stage)-keyed writer sets, spelled
 *  as a type so the two writers below can never diverge on a column. No revision among them, and no
 *  column for one: the registration states none, and the unit's pin is the delivery branch's own,
 *  written by the release cycle. */
export interface AppRowValues {
  clusterId: string;
  name: string;
  stage: Stage;
  host: string;
  repoUrl: string;
  chartPath: string;
  provenance: AppProvenance;
  status: AppStatus;
  lastRunId: string;
}

/** The ONE upsert of a consumer `apps` row, keyed on the (name, stage) unique index — a registration
 *  at a new stage INSERTs a NEW row for that stage instead of overwriting another stage's row, and a
 *  re-onboard of a stage onto another cluster UPDATES the standing row, clusterId included, because
 *  one unit stands at one stage in exactly one place. Shared by onboard's record-inventory step AND
 *  the adopt-consumer run's record-inventory, so the inventory has exactly ONE writer shape however a
 *  row comes to exist. Overwrite-idempotent by construction (a resume re-runs it). Runs inside the
 *  caller's localTx. */
export function upsertAppRow(tx: Db, values: AppRowValues, opts: { keepStatusOnUpdate?: boolean } = {}): void {
  const existing = tx.select().from(apps).where(and(eq(apps.name, values.name), eq(apps.stage, values.stage))).get();
  if (existing) {
    // keepStatusOnUpdate is the provisional phase's flag. A resumed run re-runs record-provisional
    // against a row record-inventory may ALREADY have settled to "active" — or a later suspend moved
    // to "suspended" — and writing "provisioning" over that would paint a serving consumer as
    // unfinished. A row standing "offboarded" is the one settled state a NEW onboarding writes over:
    // it is the soft, re-onboardable state an offboard or a rolled-back onboarding leaves (#199), and
    // a re-onboard onto it is a new intent, recorded as such. Every DESCRIPTIVE column is still
    // rewritten, clusterId included, because a resume must converge the row onto the params it is
    // actually running.
    const { status: _status, ...withoutStatus } = values;
    const keep = opts.keepStatusOnUpdate && existing.status !== "offboarded";
    tx.update(apps).set({ ...(keep ? withoutStatus : values), updatedAt: new Date() }).where(eq(apps.id, existing.id)).run();
  } else {
    tx.insert(apps).values({ id: appId(), ...values }).run();
  }
}

/** record-provisional: the row is written BEFORE the onboard mutates anything, recording INTENT.
 *
 *  Every mutation that follows leaves something behind — write-registration commits
 *  registrations/<name>/<stage>.yaml, then the secrets and the repo-pat are seeded, the repo
 *  credential, the AppProject, the admission policy and the build RBAC are provisioned, the DNS record
 *  is created, the release kit is injected and the webhook is set. Recording only at the END meant an
 *  onboard that failed anywhere in between left ALL of it with no inventory row at all: on an explicit
 *  abort the registered compensations run, but a plain failure left leftovers findable only by an
 *  explicit detected-scan.
 *
 *  Same shape and same writer as the settling step below, so intent and outcome can never drift into
 *  two row shapes — the discipline create-tenant's own record-provisional has carried since it was
 *  built. Overwrite-idempotent: a resumed run re-runs it, and a row record-inventory may already have
 *  lifted to "active" must not be demoted back, so the status is written on INSERT only. */
export function recordProvisionalStep(_ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "record-provisional",
    title: "Record the consumer as provisioning",
    run: async (ctx) => {
      localTx(ctx, (tx) =>
        upsertAppRow(
          tx,
          {
            clusterId: p.clusterId,
            name: p.consumerName,
            stage: p.stage,
            host: p.host,
            repoUrl: p.repoURL,
            chartPath: p.chartPath,
            provenance: "manager",
            lastRunId: ctx.runId,
            status: "provisioning",
          },
          { keepStatusOnUpdate: true },
        ),
      );
      ctx.log("meta", `consumer ${p.consumerName} recorded as provisioning on cluster ${p.clusterId} (${p.stage}) — every mutation after this one is accounted for by a row`);
    },
  };
}

/** record-inventory: settle the apps row to "active" via upsertAppRow (the shared single writer above).
 *  Overwrite-idempotent (a resume re-runs it). */
export function recordInventoryStep(_ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "record-inventory",
    title: "Record the consumer in inventory",
    run: async (ctx) => {
      // Overwrite-idempotent (a crash-resumed executor re-runs this local step): upsert on the
      // (name, stage) unique index. provenance "manager" marks a unit this Manager
      // onboarded and gate-validated — the SAME word create-tenant writes for a tenant, so one query
      // reaches both kinds; clusterId records WHICH cluster the consumer runs on; lastRunId ties it to
      // this run.
      localTx(ctx, (tx) =>
        upsertAppRow(tx, {
          clusterId: p.clusterId,
          name: p.consumerName,
          stage: p.stage,
          host: p.host,
          repoUrl: p.repoURL,
          chartPath: p.chartPath,
          provenance: "manager",
          lastRunId: ctx.runId,
          status: "active",
        }),
      );
      ctx.log("meta", `consumer ${p.consumerName} recorded on cluster ${p.clusterId} (${p.stage}, provenance manager)`);
    },
  };
}
