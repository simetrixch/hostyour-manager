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
import { renderConsumerAppProject } from "./appproject.ts";
import { renderBuildRbac, renderConsumerArgoSync, renderSmtpOpsGrant, unitBuildNamespace } from "./build-rbac.ts";
import { unitStaysRegistered } from "./lifecycle.ts";
import { consumerAdmissionPolicyName, renderConsumerAdmissionPolicy } from "./admission-policy.ts";
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
      if ((await ports.registry.readRegistration(p.stage, p.consumerName)) === null) {
        ctx.log("meta", `no registration for ${p.consumerName} at ${p.stage} — already absent, nothing to remove`);
        return;
      }
      const { commit } = await ports.registry.removeRegistration(p.stage, p.consumerName, ctx.runId);
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
 *  registry itself keeps it (removed:false) when a stage file still stands (the unit is deployed
 *  elsewhere and its build attestation must survive this run's abort). */
export function removeBuildRegistrationCleanup(ports: OnboardPorts, p: OnboardParams): Cleanup {
  return {
    name: "remove-build-registration",
    title: "Remove the build registration",
    run: async (ctx) => {
      const { removed } = await ports.registry.removeBuildRegistration(p.consumerName, ctx.runId);
      ctx.log("meta", removed
        ? `build registration for ${p.consumerName} removed`
        : `build registration for ${p.consumerName} kept — already absent, or a stage file still stands and the attestation belongs to it`);
    },
  };
}

/** The offboard inverse of apply-admission-policy, run only on an explicit abort-with-cleanup. An
 *  already-absent policy resolves deleted:false (a run that died before the apply, or a re-abort). */
export function deleteAdmissionPolicyCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "delete-admission-policy",
    title: "Delete the per-consumer admission policy",
    run: async (ctx) => {
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const { deleted } = await clusterReader.deleteAdmissionPolicy(consumerAdmissionPolicyName(p.consumerName));
      ctx.log("meta", deleted ? `admission policy for ${p.consumerName} deleted` : `no admission policy for ${p.consumerName} — already absent`);
    },
  };
}

/** The offboard inverse of apply-appproject, run only on an explicit abort-with-cleanup. An
 *  already-absent project resolves deleted:false. */
export function deleteAppProjectCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "delete-appproject",
    title: "Delete the per-consumer AppProject",
    run: async (ctx) => {
      // Resolve the target cluster's projectWriter + ArgoCD namespace (a slave's AppProject lives in
      // the per-slave ArgoCD ns on the master, "argocd" for the master) — the same seam the apply used.
      const { projectWriter, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const { deleted } = await projectWriter.deleteAppProject(argoNamespace, p.consumerName);
      ctx.log("meta", deleted ? `AppProject ${p.consumerName} deleted from ${argoNamespace}` : `AppProject ${p.consumerName} was already absent in ${argoNamespace}`);
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

/** The teardown inverse of provision-build-rbac — registered by that step, run only on an explicit
 *  abort-with-cleanup. Tolerates already-absent grants (idempotent).
 *
 *  It obeys the same per-stage/per-unit split the removal run kinds do (offboard.run.ts SCOPE), because the
 *  apply it inverts REPLACES objects an earlier stage created rather than only creating its own: the two
 *  grants in the stage-free `<name>-build` namespace exist once per unit, so an abort takes them only
 *  when no OTHER stage of the unit stands. Without that read, aborting the onboard of a second stage
 *  strips the live stage's EventListener of its create-PipelineRun grant, and its next release push
 *  produces nothing at all. */
export function deleteBuildRbacCleanup(ports: OnboardPorts, p: OnboardParams): Cleanup {
  return {
    name: "delete-build-rbac",
    title: "Delete the build grants of this run (the unit's own go with its last stage)",
    run: async (ctx) => {
      if (!ports.buildRbac) {
        ctx.log("meta", `no build RBAC writer wired — nothing was ever provisioned, nothing to take back`);
        return;
      }
      const argoNamespace = p.form === "build-only" ? undefined : (await ports.resolver.resolve(p.clusterId)).argoNamespace;
      // A build-only run has no stage registration of its own, so it discounts none.
      const unit = { name: p.consumerName, ...(p.form === "build-only" ? {} : { stage: p.stage }) };
      const stageOnly = await unitStaysRegistered(ctx, ports.registry, unit, "the build-namespace grants");
      const grants = stageOnly
        ? argoNamespace !== undefined
          ? [renderConsumerArgoSync({ name: p.consumerName, argoNamespace })]
          : [] // build-only, and the unit stands elsewhere: nothing of this run's grants is this run's alone
        : [
            ...renderBuildRbac({ name: p.consumerName, ...(argoNamespace !== undefined ? { argoNamespace } : {}) }),
            // Only on the FULL teardown: the ops grant is the unit's, not this stage's, exactly like
            // the build-namespace grants it is removed beside.
            ...(p.form !== "build-only" && p.services.includes("smtp-ops") ? [renderSmtpOpsGrant({ name: p.consumerName })] : []),
          ];
      if (grants.length === 0) return;
      const { deleted } = await ports.buildRbac.deleteBuildRbac(grants);
      ctx.log("meta", deleted ? `${deleted} build grant object(s) for ${p.consumerName} deleted` : `no build grants for ${p.consumerName} — already absent`);
    },
  };
}

/** The abort inverse of provision-dns, run only on an explicit abort-with-cleanup. Absent records are
 *  the no-op (removeUnitDns); a real DNS API failure stays fail-closed there. An UNWIRED provider is
 *  the log-skip here alone: provision-dns fails loud without one, so on such a controller no record
 *  was ever created and the abort has nothing to remove — the whole inverse is armed up front at
 *  write-registration, before the run knows whether it will ever reach provision-dns. */
export function removeDnsCleanup(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup {
  return {
    name: "remove-dns",
    title: "Remove the unit's public DNS record",
    run: async (ctx) => {
      if (!ports.dns) {
        ctx.log("meta", `no DNS provider wired — provision-dns could never have created a record on this controller, nothing to remove`);
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
        () => ctx.creds.open(p.repoCredentialId, { purpose: "onboard:seed-secrets:deploy-git-credentials", runId: ctx.runId }),
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
        throw errValidation(`onboard "${p.consumerName}" requires the repository-credential writer but none is wired on this controller — without it ArgoCD cannot fetch the private consumer repo and the generated Application can never sync`);
      }
      // The delete inverse is already armed: write-registration registered the WHOLE ordered rollback
      // (onboard-abort.ts) before the first mutation, so no step here arms its own piece any more.
      const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "onboard:provision-repo-credential", runId: ctx.runId });
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

/** apply-appproject: create/replace the per-consumer isolation AppProject on the target cluster's
 *  ArgoCD namespace and register the delete inverse. Idempotent. */
export function applyAppProjectStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "apply-appproject",
    title: "Apply the per-consumer isolation AppProject",
    run: async (ctx) => {
      // The generated Application references .spec.project == consumerName, and ArgoCD rejects an
      // Application whose project is absent — so this stands before the first release can sync.
      // The delete inverse is armed at write-registration with the rest of the ordered rollback
      // (onboard-abort.ts). Idempotent: a crash-resumed executor re-runs this step and the writer
      // replaces the existing project in place.
      const { projectWriter, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const project = renderConsumerAppProject({ name: p.consumerName, namespace: p.namespace, repoURL: p.repoURL, platformRepoURL: ports.platformRepoURL, argoNamespace });
      const { created } = await projectWriter.applyAppProject(argoNamespace, project);
      ctx.checkpoint({ appProject: p.consumerName, created });
      ctx.log("meta", `AppProject ${p.consumerName} ${created ? "created" : "updated"} in ${argoNamespace} — the consumer is isolated to its own namespace + repo`);
    },
  };
}

/** apply-admission-policy: arm the unit's ValidatingAdmissionPolicy + Binding on the TARGET cluster
 *  and register the delete inverse. A one-time provisioning, like the AppProject: the boundary holds
 *  for whatever the unit deploys afterwards, which is what makes a per-release check unnecessary.
 *  Idempotent (the writer replaces both in place on a resume). */
export function applyAdmissionPolicyStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "apply-admission-policy",
    title: "Apply the per-consumer admission policy",
    run: async (ctx) => {
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const { policy, binding } = renderConsumerAdmissionPolicy({
        name: p.consumerName,
        namespace: p.namespace,
        unitApex: p.unitApex,
        argoAppName: p.argoAppName,
        // the plan-frozen attested fqdn — the SAME value write-registration committed above, so the
        // policy and the registration cannot disagree within one run
        ...(p.fqdn !== undefined ? { fqdn: p.fqdn } : {}),
        // likewise plan-frozen: the claimed services decide the redis-consumer namespace label the
        // policy admits, and the consumers ApplicationSet stamps it off the same attested field
        services: p.services,
      });
      const { created } = await clusterReader.applyAdmissionPolicy(policy, binding);
      ctx.checkpoint({ admissionPolicy: policy.metadata.name, created });
      const served = [`${p.consumerName}.${p.unitApex}`, ...(p.fqdn !== undefined ? [p.fqdn] : [])].join(" and ");
      ctx.log(
        "meta",
        `admission policy ${policy.metadata.name} ${created ? "created" : "updated"} on ${p.domain} — the unit may serve only ${served}, expose only ClusterIP Services, and create only the namespace ${p.namespace}`,
      );
    },
  };
}

/** provision-build-rbac: write the unit's build grants — the EventListener's create on PipelineRuns
 *  in `<name>-build`, the controller's read on the same, and (for a DEPLOYABLE unit) the argo-sync
 *  Role+Binding scoped to the unit's own Applications — and register the delete inverse. A build-only
 *  unit has no Applications, so its argo-sync grant has no object and is not rendered; the two
 *  build-namespace grants are what let the webhook create its release run and the controller watch
 *  it. The unit's AppProject blacklists Role and RoleBinding, so nothing the unit deploys can create
 *  these and the Controller is the only writer left. Idempotent (the writer replaces each object in
 *  place on a resume). */
export function provisionBuildRbacStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "provision-build-rbac",
    title: "Provision the unit's build grants",
    run: async (ctx) => {
      if (!ports.buildRbac) {
        throw errValidation("the build RBAC writer is not wired — without it the webhook could not create a PipelineRun in the unit's build namespace and the release pipeline could not sync its bump");
      }
      const argoNamespace = p.form === "build-only" ? undefined : (await ports.resolver.resolve(p.clusterId)).argoNamespace;
      // The mail-OPS grant rides along on an attested `smtp-ops` claim — the SAME plan-frozen
      // services[] the admission policy and the namespace label read, so the three cannot disagree
      // within one run. It lands in the relay's namespace, not the unit's build namespace.
      //
      // Never for a build-only unit: it has no stage registration, so it claims nothing, and it has
      // no namespace to run a dashboard in — the grant would name a ServiceAccount that does not
      // exist.
      const grants = [
        ...renderBuildRbac({ name: p.consumerName, ...(argoNamespace !== undefined ? { argoNamespace } : {}) }),
        ...(p.form !== "build-only" && p.services.includes("smtp-ops") ? [renderSmtpOpsGrant({ name: p.consumerName })] : []),
      ];
      const { created } = await ports.buildRbac.applyBuildRbac(grants);
      ctx.checkpoint({ buildRbac: grants.map((g) => `${g.role.metadata.namespace}/${g.role.metadata.name}`), created });
      ctx.log(
        "meta",
        `build grants provisioned in ${unitBuildNamespace(p.consumerName)}${argoNamespace !== undefined ? ` and ${argoNamespace}` : ""} (${created} created, ${grants.length * 2 - created} replaced) — the webhook may start a release run${argoNamespace !== undefined ? `, and that run may sync ${p.consumerName}'s own Applications and no others` : ""}`,
      );
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
            provenance: "controller",
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
      // (clusterId, name, stage) unique index. provenance "controller" marks a unit this Controller
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
          provenance: "controller",
          lastRunId: ctx.runId,
          status: "active",
        }),
      );
      ctx.log("meta", `consumer ${p.consumerName} recorded on cluster ${p.clusterId} (${p.stage}, provenance controller)`);
    },
  };
}
