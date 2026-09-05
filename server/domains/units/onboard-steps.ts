// The onboard step factories + compensations, extracted from onboard.run.ts so that file stays a thin
// orchestrator — the DRY companion to onboard-seed-repo-pat.ts / onboard-seed-postgres.ts (which are
// already such factories). Every step here reads only p.stage/p.clusterId/p.domain/
// p.consumerName/p.argoAppName/etc. The onboard-ONLY steps (check, write-registration, the build-only
// record) stay in the run file.
//
// Types come from onboard.run.ts as a TYPE-ONLY import (erased at runtime), exactly like
// onboard-seed-repo-pat.ts — so the value dependency is one-directional (onboard.run.ts imports these
// factories) and there is no runtime import cycle.
import { eq, and } from "drizzle-orm";
import type { Step, Cleanup } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { appId } from "../../kernel/ids.ts";
import { errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import type { AppProvenance, AppStatus, Stage } from "../../../shared/enums.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { RELAY_NAMESPACE, renderSmtpOpsGrant } from "./build-rbac.ts";
import { unitStaysRegistered } from "./lifecycle.ts";
import { buildConsumerSecretDataWithDerivations } from "./secret-mint.ts";
import { renderConsumerRepoCredential, consumerRepoCredentialName } from "./repo-credential.ts";
import { provisionUnitDns, removeUnitDns, consumerUnitHost } from "./unit-dns.ts";
import type { OnboardPorts, OnboardParams, DeployableOnboardParams } from "./onboard.run.ts";

// The compensations below are IDEMPOTENT WITHOUT SWALLOWING: each one tolerates exactly the
// "already absent" outcome (a read-first skip, or a delete that resolves deleted:false) and lets every
// real failure propagate, so a kube/git error fails the cleanup step visibly and the run stays failed +
// re-abortable — the same contract the tenant abort has (create-tenant-abort.ts). A bare catch made a
// failed compensation and an absent object the same "ok": the abort reported "cleanup complete" while
// the registration, the AppProject and the grants all still stood.

/** The offboard inverse of write-registration, run only on an explicit abort-with-cleanup. Read-first:
 *  an absent registration is the normal case for a run that died before its commit, or a re-abort. */
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
      ctx.log("meta", `registration for ${p.consumerName} (${p.stage}) removed (${commit}) — the ArgoCD on ${p.domain} will now prune the generated Application`);
    },
  };
}

/** The compensation between the registration removal above and the object deletes below: wait for the
 *  master ArgoCD to actually prune the generated Application. Without it the AppProject is deleted
 *  while the Application still references it (ArgoCD then refuses every operation on it) and the
 *  admission boundary comes down while the workloads still serve. FAIL-LOUD, like the tenant abort and
 *  for its reason: an abort deletes no namespace, so there is no cluster-side backstop — a fan-in that
 *  will not prune must stop the abort visibly (the run stays failed, re-abortable; purge is the run kind
 *  that force-reaps). An Application that never existed (the run died before its first sync) reads
 *  Missing immediately, so this passes at once on a run with nothing deployed. */
export function watchConsumerPruneCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "watch-consumer-prune",
    title: "Wait for ArgoCD to prune the generated Application",
    run: async (ctx) => {
      const appName = p.argoAppName;
      const gone = (s: { health: string }): boolean => s.health === "Missing";
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const status = await argoReader.watchApplication(argoNamespace, appName, gone, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
      if (!gone(status)) {
        throw errValidation(
          `Application ${appName} was not pruned — last seen health=${status.health}${status.message ? ` (${status.message})` : ""}; ` +
            `the registration is removed but the workloads linger, and deleting the AppProject or the admission policy over a standing Application would strand it — re-abort once the master ArgoCD has pruned it, or purge`,
        );
      }
      ctx.log("meta", `Application ${appName} pruned — nothing of the consumer is deployed any more`);
    },
  };
}

/** The build-only twin of removeRegistrationCleanup: take back registrations/<name>/build.yaml — the
 *  registrations itself keeps it (removed:false) when a stage file still stands (the unit is deployed
 *  elsewhere and its build attestation must survive this run's abort). */
export function removeBuildRegistrationCleanup(ports: OnboardPorts, p: OnboardParams): Cleanup {
  return {
    name: "remove-build-registration",
    title: "Remove the build registration",
    run: async (ctx) => {
      const { removed } = await ports.registrations.removeBuildRegistration(p.consumerName, ctx.runId);
      ctx.log("meta", removed
        ? `build registration for ${p.consumerName} removed`
        : `build registration for ${p.consumerName} kept — already absent, or a stage file still stands and the attestation belongs to it`);
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
      const { deleted } = await ports.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(p.consumerName));
      ctx.log("meta", deleted ? `ArgoCD repository credential for ${p.consumerName} deleted` : `no ArgoCD repository credential for ${p.consumerName} — already absent`);
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
 *  IT IS THE UNIT'S GRANT AND NOT THIS STAGE'S, so it obeys the per-stage/per-unit split the removal
 *  run kinds do (offboard.run.ts SCOPE): a dashboard runs in the unit's namespace whatever stage it
 *  was onboarded at, so the grant goes only when no OTHER stage of the unit stands. Without that read,
 *  aborting the onboard of a second stage takes the live stage's queue dashboard away from it.
 *
 *  A BUILD-ONLY UNIT NEVER HAS ONE — it claims no services and has no namespace to run a dashboard in
 *  — so this compensation is armed on the deployable form alone (onboard-abort.ts). */
export function deleteSmtpOpsGrantCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "delete-smtp-ops-grant",
    title: "Delete the unit's mail-ops grant (it goes with the unit's last stage)",
    run: async (ctx) => {
      if (!p.services.includes("smtp-ops")) {
        ctx.log("meta", `${p.consumerName} claims no smtp-ops — no mail-ops grant was ever written, nothing to take back`);
        return;
      }
      if (!ports.buildRbac) {
        ctx.log("meta", `no build RBAC writer wired — nothing was ever provisioned, nothing to take back`);
        return;
      }
      const stageOnly = await unitStaysRegistered(ctx, ports.registrations, { name: p.consumerName, stage: p.stage }, "the mail-ops grant");
      if (stageOnly) {
        ctx.log("meta", `mail-ops grant for ${p.consumerName} kept — the unit still stands at another stage and the grant is the unit's`);
        return;
      }
      const { deleted } = await ports.buildRbac.deleteBuildRbac([renderSmtpOpsGrant({ name: p.consumerName })]);
      ctx.log("meta", deleted ? `mail-ops grant for ${p.consumerName} deleted from ${RELAY_NAMESPACE}` : `no mail-ops grant for ${p.consumerName} — already absent`);
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
      await removeUnitDns(ctx, { dns: ports.dns, unit: p.consumerName, recordName: consumerUnitHost(p.consumerName, p.unitApex) });
    },
  };
}

/** attest-target: fail-closed deploy-state freshness check on the TARGET cluster (step 0 of a
 *  mutating run). Reads the deploy-state on the target's own reader (a slave over its bearer, or the master). */
export function attestTargetStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "attest-target",
    title: "Attest the target cluster (deploy-state fresh)",
    run: async (ctx) => {
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const state = await clusterReader.readDeployState();
      if (!state) {
        throw errValidation(`target cluster "${p.domain}" has no hostyour-cloud deploy-state — is it a provisioned hostyour cluster? refusing to onboard`);
      }
      if (state.domain !== p.domain || state.stage !== p.stage) {
        throw errValidation(`deploy-state mismatch: the cluster reports ${state.domain}/${state.stage} but this run targets ${p.domain}/${p.stage}`);
      }
      ctx.log("meta", `target ${p.domain} (${p.stage}) attested — deploy-state generation ${state.generation}`);
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
      const { data, minted } = await buildConsumerSecretDataWithDerivations(
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
    },
  };
}

/** provision-repo-credential: write the unit's ArgoCD repository Secret (its repo URL + its ONE PAT)
 *  into the target's ArgoCD namespace, imperatively, and register the delete inverse. Without it the
 *  generated Application cannot fetch the private consumer repo at all — the PAT lives only in the
 *  sealed store and the local build Vault, neither of which the target's ESO reads. Idempotent (the
 *  writer replaces the Secret in place on a resume, so a re-onboard rotates the credential to the
 *  freshly sealed PAT). */
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
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:provision-repo-credential", runId: ctx.runId });
      let created: boolean;
      try {
        ({ created } = await ports.repoCredential.applyRepoCredential(
          renderConsumerRepoCredential({ consumerName: p.consumerName, argoNamespace, repoURL: p.repoURL, pat: pat.toString("utf8") }),
        ));
      } finally {
        pat.fill(0);
      }
      const name = consumerRepoCredentialName(p.consumerName);
      ctx.checkpoint({ repoCredential: name, created });
      ctx.log("meta", `ArgoCD repository credential ${name} ${created ? "created" : "replaced"} in ${argoNamespace} — the generated Application can fetch ${p.repoURL}`);
    },
  };
}

/** provision-smtp-ops-grant: write the unit's mail-OPS grant — read/exec on the relay's pods, in the
 *  relay's own namespace — for a unit whose stage registration attests `smtp-ops`, and register the
 *  delete inverse. A unit that claims nothing writes nothing and the step says so.
 *
 *  IT IS THE ONE PER-UNIT OBJECT LEFT THAT NO RECONCILER RENDERS, and that is why it alone stands
 *  where a whole apply of four object kinds used to. The other five — the isolation AppProject, the
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
      const grant = renderSmtpOpsGrant({ name: p.consumerName });
      const { created } = await ports.buildRbac.applyBuildRbac([grant]);
      ctx.checkpoint({ smtpOpsGrant: `${grant.role.metadata.namespace}/${grant.role.metadata.name}`, created });
      ctx.log("meta", `mail-ops grant provisioned in ${RELAY_NAMESPACE} (${created} created, ${2 - created} replaced) — ${p.consumerName} may read and exec the relay's pods`);
    },
  };
}

/** provision-dns: create the unit's ONE public record — A `<name>.<unitApex>`, pointing at the
 *  target cluster's own address — and register the remove inverse (the address belongs to
 *  the unit; a move is a content update of exactly this record). Fail-closed: an unwired provider or
 *  an API failure breaks the run. */
export function provisionDnsStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "provision-dns",
    title: "Provision the unit's public DNS record",
    run: async (ctx) => {
      await provisionUnitDns(ctx, {
        dns: ports.dns,
        unit: p.consumerName,
        recordName: consumerUnitHost(p.consumerName, p.unitApex),
        clusterFqdn: p.domain,
        runKind: "consumer-onboard",
      });
    },
  };
}

/** smoke: verify the consumer namespace on the target cluster (namespace + workloads available +
 *  ExternalSecrets Ready). */
export function smokeStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "smoke",
    title: "Smoke-check the consumer namespace",
    run: async (ctx) => {
      // Smoke the consumer namespace on the TARGET cluster's own reader (a slave over its bearer).
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const smoke = await clusterReader.smoke(p.namespace);
      if (!smoke.namespaceExists) throw errValidation(`namespace ${p.namespace} does not exist after sync`);
      const failing = smoke.workloads.filter((w) => !w.available);
      if (failing.length) {
        throw errValidation(`workloads not available in ${p.namespace}: ${failing.map((w) => `${w.kind}/${w.name}${w.message ? ` (${w.message})` : ""}`).join(", ")}`);
      }
      if (!smoke.externalSecretsReady) {
        throw errValidation(`ExternalSecrets are not all Ready in ${p.namespace} — the consumer's secrets did not materialize`);
      }
      ctx.checkpoint({ namespaceExists: true, workloads: smoke.workloads.length, externalSecretsReady: true });
      ctx.log("meta", `smoke ok — ${smoke.workloads.length} workload(s) available, external secrets ready`);
    },
  };
}

/** The values ONE apps-row upsert writes — every column the (clusterId, name, stage)-keyed writer
 *  sets, spelled as a type so the two writers below can never diverge on a column. No revision among
 *  them, and no column for one: the registration states none, and the unit's pin is the delivery
 *  branch's own, written by the release cycle. */
export interface AppRowValues {
  clusterId: string;
  name: string;
  stage: Stage;
  repoUrl: string;
  chartPath: string;
  repoCredentialId: string | null;
  provenance: AppProvenance;
  status: AppStatus;
  lastRunId: string;
}

/** The ONE upsert of a consumer `apps` row, keyed on the (clusterId, name, stage) unique index — a
 *  registration at a new stage INSERTs a NEW row for that cluster/stage instead of overwriting another
 *  stage's row. Shared by onboard's record-inventory step AND the adopt-consumer run's
 *  record-inventory, so the inventory has exactly ONE writer shape however a row
 *  comes to exist. Overwrite-idempotent by construction (a resume re-runs it). Runs inside the caller's
 *  localTx. */
export function upsertAppRow(tx: Db, values: AppRowValues, opts: { keepStatusOnUpdate?: boolean } = {}): void {
  const existing = tx.select().from(apps).where(and(eq(apps.clusterId, values.clusterId), eq(apps.name, values.name), eq(apps.stage, values.stage))).get();
  if (existing) {
    // keepStatusOnUpdate is the provisional phase's flag. A resumed run re-runs record-provisional
    // against a row record-inventory may ALREADY have settled to "active" — or a later suspend moved
    // to "suspended" — and writing "provisioning" over that would paint a serving consumer as
    // unfinished. Every DESCRIPTIVE column is still rewritten, because a resume must converge the row
    // onto the params it is actually running.
    const { status: _status, ...withoutStatus } = values;
    tx.update(apps).set(opts.keepStatusOnUpdate ? withoutStatus : values).where(eq(apps.id, existing.id)).run();
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
            repoUrl: p.repoURL,
            chartPath: p.chartPath,
            repoCredentialId: p.repoCredentialId,
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
      // (clusterId, name, stage) unique index. provenance "manager" marks a unit this Manager
      // onboarded and gate-validated — the SAME word create-tenant writes for a tenant, so one query
      // reaches both kinds; clusterId records WHICH cluster the consumer runs on; lastRunId ties it to
      // this run.
      localTx(ctx, (tx) =>
        upsertAppRow(tx, {
          clusterId: p.clusterId,
          name: p.consumerName,
          stage: p.stage,
          repoUrl: p.repoURL,
          chartPath: p.chartPath,
          repoCredentialId: p.repoCredentialId,
          provenance: "manager",
          lastRunId: ctx.runId,
          status: "active",
        }),
      );
      ctx.log("meta", `consumer ${p.consumerName} recorded on cluster ${p.clusterId} (${p.stage}, provenance manager)`);
    },
  };
}
