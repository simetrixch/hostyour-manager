import { z } from "zod";
import { eq, and, notInArray } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps, clusters } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { STAGE, APP_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
import { consumerArgoAppName, type ConsumerStageRegistration } from "../../../shared/consumer.ts";
import { localTx } from "../../executor/stepkit.ts";
import { assertDeployState, type LifecyclePorts } from "./lifecycle.ts";
import { upsertAppRow } from "./onboard-steps.ts";

// adopt-consumer — the RECOVERY companion to purge.run.ts, and its structural
// twin: NAME-keyed, no appId, no inventory row required. Where purge REMOVES a consumer's whole
// footprint by name, adopt-consumer RECORDS one: it reconstructs the missing apps row FROM the GitOps
// registration, so a consumer whose onboard died before record-inventory (the LAST onboard step) — or
// whose registration was written by hand — becomes visible under Consumers and reachable by the
// row-keyed run kinds again (offboard reads repoURL + the sealed PAT off the row it writes). swissbookai is
// the founding case: healthy in the cluster, invisible in the Manager.
//
// DESIGN — a distinct RUN_KIND "consumer-adopt" (NOT "cluster-adopt", which adopts a SERVER), NOT a
// repair mode on onboard, for the same reason purge is not a force-mode on offboard: onboard is
// gate-validated end to end (it deploys), while adopt deploys NOTHING — its only mutation is the ONE
// local DB upsert, shared byte-for-byte with onboard's record-inventory (upsertAppRow,
// onboard-steps.ts), so however a row comes to exist there is exactly one writer shape.
//
// THE HONESTY LAW (the owner's "nichts darf eine Lüge sein"): the row this run writes is the
// REGISTRATION's word, not a validated deployment — so (1) the row is marked provenance "adopted",
// never "manager" (which states a gate-validated onboard ran); (2) the run PROBES THE LIVE CLUSTER
// first (attest-live) and puts both truths — the namespace smoke and the ArgoCD Application status —
// into the step log, so the row is only ever written after what actually runs is on record; (3)
// attest-live is SOFT: a suspended or missing app is still adoptable, because the registration is the
// record of INTENT and the Consumers card renders the live truth per row anyway. It records NO
// revision: the registration states none, so `version` stays null rather than inventing a pin.
// The ONE hard gate is attest-target
// (mutating): the deploy-state of the target cluster must agree with the derived domain/stage, exactly
// as purge refuses to act on the wrong cluster.

export const AdoptConsumerParams = z.object({
  // The consumer name == namespace == AppProject == registration directory (G1). Same shape onboard/purge use.
  consumerName: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/),
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"),
});
export type AdoptConsumerParams = z.infer<typeof AdoptConsumerParams>;

/** adopt-consumer drives the SAME narrow port set as suspend/resume (LifecyclePorts): the registrations
 *  (the registration read), the per-cluster resolver (deploy-state attest + the live probe) and the
 *  watch budget (unused here — attest-live is a single read, never a watch). Aliased so the wiring
 *  reads as intent. */
export type AdoptConsumerPorts = LifecyclePorts;

interface AdoptTarget {
  name: string;
  domain: string;
  stage: Stage;
  clusterId: string;
}

/** Read the target's STAGE registration, refusing everything that would make an adopt write a mixed
 *  identity. Both steps that need it call this rather than one caching the read for the other: steps
 *  are independently resumable, and the row must be written from what the registration says NOW.
 *   - absent            — nothing to adopt.
 *   - body name drift   — a body whose `name` disagrees with its directory would put THAT name's repo
 *                         on THIS name's row, a mixed identity every later run kind would act on.
 *   - no deploy group   — the file at <stage>.yaml is a build registration; it deploys nothing. */
async function readStageRegistration(ports: AdoptConsumerPorts, t: AdoptTarget): Promise<ConsumerStageRegistration> {
  const current = await ports.registrations.readRegistration(t.stage, t.name);
  if (!current) {
    throw errNotFound(
      `no consumer registration for "${t.name}" at ${t.stage} — registrations/${t.name}/${t.stage}.yaml does not exist, so there is nothing to adopt`,
    );
  }
  const e = current.entry;
  if (e.name !== t.name) {
    throw errValidation(
      `registration body name "${e.name}" disagrees with its directory name "${t.name}" — refusing to adopt a mixed identity; fix the file in GitOps first`,
    );
  }
  if (e.chartPath === undefined || e.cluster === undefined || e.databases === undefined || e.services === undefined || e.size === undefined || e.mongodb === undefined || e.quota === undefined) {
    throw errValidation(
      `registrations/${t.name}/${t.stage}.yaml carries no deploy group (chartPath/cluster/databases/services/size/mongodb/quota) — it registers a build, not a deployment, so there is nothing to adopt`,
    );
  }
  return { ...e, chartPath: e.chartPath, cluster: e.cluster, databases: e.databases, services: e.services, size: e.size, mongodb: e.mongodb, quota: e.quota };
}

/** Derive the target identity from name+stage+cluster ALONE — no inventory row exists (that is the
 *  whole point). The cluster row is the AUTHORITY for the domain; the passed stage is cross-checked
 *  against the cluster's own stage (a cluster is exactly one stage) so a mistyped stage fails closed
 *  rather than reading the wrong pointer path. Byte-identical to purge's loadPurgeTarget — kept local
 *  so the two run files stay independently editable (the same reason purge does not import offboard). */
function loadAdoptTarget(db: Db, p: AdoptConsumerParams): AdoptTarget {
  const cluster = db.select().from(clusters).where(eq(clusters.id, p.clusterId)).get();
  if (!cluster) throw errNotFound(`cluster ${p.clusterId}`);
  if (cluster.stage !== p.stage) {
    throw errValidation(`stage mismatch: cluster ${p.clusterId} is ${cluster.stage}, adopt targets ${p.stage}`);
  }
  return { name: p.consumerName, domain: cluster.domain, stage: cluster.stage, clusterId: cluster.id };
}

/** The UNSETTLED apps row for this name on this cluster, or undefined. Present ⇒ the consumer is
 *  already on the Consumers list (the list joins apps -> clusters with no stage filter), so there is
 *  nothing invisible to adopt and the run refuses. A SETTLED row (APP_SETTLED_STATUS — a recorded
 *  removal) does NOT block: a pointer standing beside it means the consumer is out there again,
 *  and adopting flips that same row back to a live status (the upsert key finds it). */
function findUnsettledRow(db: Db, t: AdoptTarget): typeof apps.$inferSelect | undefined {
  return db
    .select()
    .from(apps)
    .where(and(eq(apps.clusterId, t.clusterId), eq(apps.name, t.name), notInArray(apps.status, [...APP_SETTLED_STATUS])))
    .get();
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function adoptSteps(ports: AdoptConsumerPorts, params: AdoptConsumerParams): Step[] {
  const p = params;
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        // The ONE fail-closed gate (step 0 of this mutating run): the target cluster must still be a
        // provisioned hostyour cluster whose deploy-state agrees with the derived domain/stage — a row
        // recorded against the wrong cluster would aim every later row-keyed run kind (offboard!) at it.
        // Same shape as purge's attest-target: keyed on the name, so lifecycle's appId-keyed
        // attestTargetStep cannot be reused.
        const t = loadAdoptTarget(ctx.db, p);
        const { clusterReader } = await ports.resolver.resolve(t.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), t.domain, t.stage, "consumer");
        ctx.log("meta", `target ${t.domain} (${t.stage}) attested for adopt of ${t.name} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "read-pointer",
      title: "Read the GitOps pointer (the record of intent)",
      run: async (ctx) => {
        const t = loadAdoptTarget(ctx.db, p);
        // Already tracked ⇒ nothing invisible to adopt: refuse BEFORE any read of git, so a double
        // adopt (or an adopt raced by a finishing onboard) never overwrites a row another run owns.
        // Checked here rather than only at plan time because approve re-validates nothing — the plan
        // may be hours old when it runs. Resume-safe: this step runs BEFORE record-inventory, so a
        // resumed run never trips over the row it wrote itself.
        const tracked = findUnsettledRow(ctx.db, t);
        if (tracked) {
          throw errValidation(
            `consumer "${t.name}" is already tracked on cluster ${t.clusterId} (row ${tracked.id}, status ${tracked.status}) — it is on the Consumers list, so there is nothing to adopt`,
          );
        }
        const current = await readStageRegistration(ports, t);
        ctx.checkpoint({
          suspended: current.suspended,
          chartPath: current.chartPath,
          hasRepoCredential: current.repoCredentialId !== undefined,
        });
        ctx.log(
          "meta",
          `registration registrations/${t.name}/${t.stage}.yaml read — chart ${current.chartPath} on cluster ${current.cluster}, ${current.suspended ? "suspended" : "running"}` +
            (current.repoCredentialId ? `, sealed repo credential ${current.repoCredentialId}` : ", no repo credential recorded") +
            ". This is what the REGISTRATION says — the live cluster is attested next.",
        );
      },
    },
    {
      name: "attest-live",
      title: "Attest the live cluster state (recorded, never a gate)",
      run: async (ctx) => {
        // The honesty gate, SOFT by design: probe what actually RUNS — the namespace smoke on the
        // target cluster and the generated Application's ArgoCD status — and put both truths into the
        // step log BEFORE any row is written, so an adopt is never a silent leap of faith. It REFUSES
        // NOTHING: a suspended/missing/crash-looping app is still adoptable (the pointer is the record
        // of intent, and adopting is precisely how the operator gets the row-keyed run kinds back to fix
        // or remove it), and an unreachable slave must not strand the adoption either — the Consumers
        // card re-probes live per row anyway. Fanned with allSettled so one failing read still yields
        // the other, exactly like the live route.
        const t = loadAdoptTarget(ctx.db, p);
        const appName = consumerArgoAppName(t.name, t.stage);
        const { clusterReader, argoReader, argoNamespace } = await ports.resolver.resolve(t.clusterId);
        const [smokeRes, argoRes] = await Promise.allSettled([
          clusterReader.smoke(t.name),
          argoReader.getApplication(argoNamespace, appName),
        ]);
        if (smokeRes.status === "fulfilled") {
          const s = smokeRes.value;
          const up = s.workloads.filter((w) => w.available).length;
          ctx.log(
            "meta",
            `live cluster: namespace ${t.name} ${s.namespaceExists ? "exists" : "does NOT exist"}, ${up}/${s.workloads.length} workload(s) available, external secrets ${s.externalSecretsReady ? "ready" : "NOT ready"}`,
          );
        } else {
          ctx.log("meta", `live cluster state could not be read (${errText(smokeRes.reason)}) — recorded as unknown, not as healthy; the Consumers card will show the live truth per row`);
        }
        if (argoRes.status === "fulfilled") {
          const a = argoRes.value;
          ctx.log(
            "meta",
            a === null
              ? `Application ${appName} does not exist in ${argoNamespace} — nothing is generated right now (a suspended pointer, or the appset has not caught up); the pointer stays the record of intent and the adopt continues`
              : `Application ${appName}: sync=${a.sync}, health=${a.health}${a.message ? ` (${a.message})` : ""}`,
          );
        } else {
          ctx.log("meta", `ArgoCD could not be read (${errText(argoRes.reason)}) — recorded as unknown, not as synced`);
        }
        ctx.checkpoint({
          application: appName,
          ...(smokeRes.status === "fulfilled"
            ? { namespaceExists: smokeRes.value.namespaceExists, workloadsAvailable: smokeRes.value.workloads.filter((w) => w.available).length, workloadsTotal: smokeRes.value.workloads.length, externalSecretsReady: smokeRes.value.externalSecretsReady }
            : { smokeError: errText(smokeRes.reason) }),
          ...(argoRes.status === "fulfilled"
            ? argoRes.value === null
              ? { applicationExists: false }
              : { applicationExists: true, argoSync: argoRes.value.sync, argoHealth: argoRes.value.health }
            : { argoError: errText(argoRes.reason) }),
        });
      },
    },
    {
      name: "record-inventory",
      title: "Record the consumer in inventory (reconstructed from the pointer)",
      run: async (ctx) => {
        // The run's ONE mutation, through the SAME writer onboard's record-inventory uses
        // (upsertAppRow — one upsert shape however a row comes to exist). The pointer is RE-READ here
        // rather than trusted from the earlier step: steps are independently resumable, and the row
        // must be written from what the pointer says NOW. Every pointer field is copied VERBATIM —
        // above all repoCredentialId, which is the sealed credential-store id the offboard/purge
        // teardown will open; it is never re-sealed or re-minted here.
        const t = loadAdoptTarget(ctx.db, p);
        const current = await readStageRegistration(ports, t);
        // The row's status mirrors the registration's own `suspended` field, not a blanket "active":
        // a suspended unit renders with no workloads, and recording it "active" would put the wrong
        // lifecycle run kind on its card. The registration is the record of intent; the row repeats it.
        const status = current.suspended ? ("suspended" as const) : ("active" as const);
        localTx(ctx, (tx) =>
          upsertAppRow(tx, {
            clusterId: t.clusterId,
            name: t.name,
            stage: t.stage,
            repoUrl: current.repoURL,
            chartPath: current.chartPath,
            repoCredentialId: current.repoCredentialId ?? null,
            provenance: "adopted", // reconstructed from the registration — NEVER "manager" (gate-validated)
            status,
            lastRunId: ctx.runId,
          }),
        );
        ctx.checkpoint({ status, provenance: "adopted" });
        ctx.log(
          "meta",
          `consumer ${t.name} recorded on cluster ${t.clusterId} (${t.stage}, provenance adopted, status ${status}) — ` +
            `row reconstructed from the registration${current.repoCredentialId ? `, sealed repo credential ${current.repoCredentialId} copied verbatim` : ", no repo credential recorded on the registration"}. ` +
            "The consumer now appears under Consumers and every row-keyed run kind (offboard/suspend/resume) can reach it.",
        );
      },
    },
  ];
}

export function makeAdoptConsumerDef(ports: AdoptConsumerPorts): RunDefinition<AdoptConsumerParams> {
  return {
    kind: "consumer-adopt",
    paramsSchema: AdoptConsumerParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const t = loadAdoptTarget(db, params);
      // Refused at plan time too (fast feedback, before an approval exists) — and AGAIN in
      // read-pointer, because approve re-validates nothing and the inventory may gain the row in
      // between (a finishing onboard, another adopt). One rule, asked at both ends.
      const tracked = findUnsettledRow(db, t);
      if (tracked) {
        throw errValidation(
          `consumer "${t.name}" is already tracked on cluster ${t.clusterId} (row ${tracked.id}, status ${tracked.status}) — it is on the Consumers list, so there is nothing to adopt`,
        );
      }
      const stepDefs = adoptSteps(ports, params);
      return {
        kind: "consumer-adopt",
        // No app row exists yet (that is the point), so adopt targets the CLUSTER — exactly like
        // onboard's plan and purge's.
        targetKind: "cluster",
        targetId: t.clusterId,
        summary:
          `Adopt consumer "${t.name}" on ${t.domain} (${t.stage}) by NAME: reconstruct its missing inventory row from the GitOps registration ` +
          `registrations/${t.name}/${t.stage}.yaml. The run attests the target cluster, reads the registration, records the LIVE ` +
          `cluster + ArgoCD state into the run log (soft — a suspended or missing app is still adoptable), then writes the row with ` +
          `provenance "adopted" and the registration's repo/chart/credential copied verbatim. NOTHING is deployed, validated or changed on ` +
          `the cluster — the only mutation is the inventory row that makes the consumer visible and offboardable again.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        // The registration read rides the BOOKS worktree (registrations.fetchResetBranch hard-resets it),
        // so the books branch is the lock that matters — the same key every registration WRITER
        // claims. Without it a concurrent offboard resets that worktree between this run's fetch and
        // its read, and adopt reconstructs a row from a tree mid-rewrite. The consumer's own cluster
        // branch is claimed beside it, so an adopt cannot interleave with the runs that rewrite that
        // branch (deploy-slave, redeploy, release).
        // No master-kube lock: unlike purge, adopt writes nothing on any cluster.
        locks: [{ resource: "git-branch", key: ports.registrations.branch }, { resource: "git-branch", key: t.domain }],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => adoptSteps(ports, params),
  };
}
