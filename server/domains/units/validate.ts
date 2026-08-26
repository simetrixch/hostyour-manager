// The onboard validation core. The gates run at ONBOARDING and nowhere
// else: the Manager clones the (possibly private) consumer repo ITSELF to resolve the ref (
// the read credential stays here), dispatches the gate PipelineRun (which clones the repo at that
// revision), streams the sandbox gates as they land, composes the runner's report with the
// manager-side gates, and returns the verdict.
//
// Every gate is HARD and UNCONDITIONAL — the composed report either passes or the
// onboarding is rejected. What a later sync could still get wrong is not asked here at all: the
// namespace fence, the allowed kinds, the Secret writer, the unit's one host and the restricted pod
// security are held by the AppProject, the ValidatingAdmissionPolicy and the namespace's Pod Security
// Admission label, all provisioned at onboarding, so they hold for every future release without a
// per-release check.
//
// This function is pure orchestration over the ports — no db, no executor, no timers of its own
// except the poll pacing — so it is exercised end-to-end against the in-memory fakes.
import type { RepoReader } from "../../adapters/git/port.ts";
import type { GateRunner } from "../../adapters/gate-runner/port.ts";
import type { GateReport, GateResult } from "../../../shared/gates.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { Stage } from "../../../shared/enums.ts";
import { AppError } from "../../kernel/errors.ts";
import { parse as parseYaml } from "yaml";
import { composeReport, gateBuildNameUniqueness, gateRepoAccess, gateBuildDeclaration, gateFqdnGrant, gateUnitName, gateUnitSize, type ForeignBuild, type ForeignFqdn } from "./gates/compose.ts";
import type { UnitComposition, UnitQuota, UnitSize } from "../../../shared/unit-size.ts";
import { mapBuildsToChartPins, type ChartPinMapping } from "./builds.ts";
import { unitApexFromChain } from "./admission-policy.ts";

/** The cluster's OWN FQDN (`global.domain`, stamped when the install branch is generated) off the values chain, read like
 *  unitApexFromChain — LAST file that states it wins. It anchors G19's infrastructure clause: the
 *  platform's own hostnames (vault.<fqdn>, argo.<fqdn>, build.<fqdn>, zot.<fqdn>) are composed
 *  under it and have no registration, so the attested-fqdn set cannot see them. Null when the chain
 *  states none — then there is no cluster FQDN to hold a declared name against, and the gate's
 *  other clauses still stand. */
function clusterDomainFromChain(files: readonly ClusterValueFile[]): string | null {
  let found: string | null = null;
  for (const file of files) {
    const parsed: unknown = parseYaml(file.content);
    const domain = (parsed as { global?: { domain?: unknown } } | null)?.global?.domain;
    if (typeof domain === "string" && domain.length > 0) found = domain;
  }
  return found;
}

/** What the operator submits from the wizard (the immutable identity of an onboard). */
export interface OnboardRequest {
  repoURL: string;
  /** The size the OPERATOR assigned this unit — never the consumer's to declare. G24 holds it
   *  against the composition the manifest declares. */
  size: UnitSize;
  /** The revision the gates check — the default branch head ("HEAD"): the onboarding validates
   *  what the repo IS, and only the release cycle ever turns a commit into something deployable. */
  ref: string;
  consumerName: string;
  repoCredentialId?: string; // a Manager-side credential id for a private repo
}

/** The platform-computed context the plan phase derives from the target cluster's plane config. */
export interface OnboardTarget {
  domain: string; // the GitOps branch the registration's cluster lives on, e.g. "s1.example"
  stage: Stage;
  /** The chart subpath inside the repo. ABSENT for a build-only unit — one that carries a build
   *  registration and no stage file, so nothing of it is ever deployed and there is no chart to
   *  render or to pin a build in. */
  chartPath?: string;
  /** The target cluster's values chain, read off its install branch — the render's cluster-value
   *  source (shared/cluster-values.ts). */
  clusterValueFiles: readonly ClusterValueFile[];
}

/** Reads the build names the OTHER units have attested. Registrations implements it over
 *  `registrations/<unit>/build.yaml` on the registration branch; G16 holds the candidate unit's
 *  declared names against the result. */
export interface AttestedBuildReader {
  listAttestedBuildNames(exceptUnit: string): Promise<ForeignBuild[]>;
}

/** Reads every attested extra FQDN except the candidate's own registration at the stage being
 *  onboarded (a re-onboard must not collide with itself). Registrations implements it over every
 *  `registrations/<unit>/<stage>.yaml` on the registration branch; G19 holds the candidate's
 *  declared fqdn against the result — the same unit's OTHER stages included, because the
 *  stage-less manifest fqdn would otherwise be attested at two stages. */
export interface AttestedFqdnReader {
  listAttestedFqdns(except: { unit: string; stage: Stage }): Promise<ForeignFqdn[]>;
}

/** Every subdomain a TENANT stands at, over every stage — TenantRegistrations.listTenantSubdomains over
 *  the catalog pointers. It is a second repo and therefore a dep of its own, not a method on
 *  the consumer registrations above. G23 holds the candidate unit name against it: the two spaces compose
 *  the same label under the same apex, and a tenant's session cookies are scoped to it (unit-dns.ts).
 *  Not optional: a reader that answered nothing would silently hand the gate a pass. */
export type TenantSubdomainReader = () => Promise<string[]>;

export interface ValidateDeps {
  repo: RepoReader;
  runner: GateRunner;
  /** The registration reader the uniqueness gates (G16 builds, G19 fqdn) are held against. Not
   *  optional: a gate that cannot read the other units' claims would have nothing to check. */
  registrations: AttestedBuildReader & AttestedFqdnReader;
  /** The tenant subdomains G23's host clause is held against (see TenantSubdomainReader). */
  tenantSubdomains: TenantSubdomainReader;
  /** Gate-line sink -> events rows (append-only). Called once per gate as it lands. */
  log: (line: string) => void;
  signal: AbortSignal;
  /** The Manager's confirmed-listening attestation for the must-fail probe targets. */
  attestListening: boolean;
  /** The size table, bound to the Manager's own inventory by the caller — G24 needs the six figures
   *  a size resolves to for what the unit brings, and this module holds no db of its own. */
  resolveQuota: (size: UnitSize, brings: UnitComposition) => UnitQuota;
  /** Poll pacing; the fake returns "done" on the first poll, so this never fires in tests. */
  pollIntervalMs?: number;
  /** Terminating deadline of the whole runner poll (default DEFAULT_POLL_BUDGET_MS). The sandbox
   *  CLI enforces its own job budget INSIDE the gate pod, but with the Tekton controller down or
   *  the CRDs unserved the PipelineRun never settles at all — this bound is what stops the poll
   *  then, instead of parking the onboard run in `planning` forever. The wiring passes a value a
   *  margin above the sandbox job budget, so a healthy run always settles first. */
  pollBudgetMs?: number;
}

export interface ValidationOutcome {
  verdict: "pass" | "fail";
  resolvedSha: string;
  report: GateReport; // the composed report (runner sandbox gates + manager-side gates)
  /** The build NAMES the manifest declared, present iff verdict === "pass"; null on any rejection.
   *  They are what the build registration attests. No image and no tag: the image name IS the build
   *  name, and the tag is the release pipeline's to mint. */
  builds: string[] | null;
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

/** A margin above the wiring's sandbox job budget (8 minutes), so the in-pod budget always fires
 *  first on a healthy run and this bound only catches a PipelineRun that never settles. */
const DEFAULT_POLL_BUDGET_MS = 10 * 60_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

/** Poll the runner to "done", streaming each sandbox gate exactly once as it lands. Bounded by
 *  pollBudgetMs: a PipelineRun that never settles (Tekton controller down, CRDs unserved) would
 *  otherwise be polled forever — the sandbox's own job budget runs inside the gate pod and cannot
 *  fire when no pod ever starts. */
async function pollToDone(deps: ValidateDeps, jobId: string): Promise<GateReport> {
  const streamed = new Set<string>();
  const budgetMs = deps.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (deps.signal.aborted) throw abortError();
    const progress = await deps.runner.poll(jobId);
    for (const g of progress.gatesSoFar) {
      if (!streamed.has(g.id)) {
        streamed.add(g.id);
        deps.log(`${g.id} ${g.status} — ${g.detail}`);
      }
    }
    if (progress.phase === "done") {
      if (!progress.report) throw new AppError("INTERNAL", "gate-runner reported done without a report");
      return progress.report;
    }
    if (Date.now() >= deadline) {
      throw new AppError("UPSTREAM", `the gate-run did not settle within ${budgetMs}ms — the Tekton controller may be down or the PipelineRun stuck unscheduled; the validation stops here instead of polling forever`);
    }
    await sleep(deps.pollIntervalMs ?? 1500, deps.signal);
  }
}

/** Clone -> resolve the revision (G17 access proof) -> dispatch the gate-run -> poll -> compose. The
 *  gate PipelineRun clones the repo ITSELF at that revision; the Manager passes the private-repo
 *  read credential id so the run can clone it. A hard-gate failure returns verdict "fail" with the
 *  full composed report so the operator sees every expected/found/reason. */
export async function validateOnboard(req: OnboardRequest, target: OnboardTarget, deps: ValidateDeps): Promise<ValidationOutcome> {
  const cloned = await deps.repo.cloneAtRef({
    repoURL: req.repoURL,
    ref: req.ref,
    ...(req.repoCredentialId ? { credentialId: req.repoCredentialId } : {}),
    signal: deps.signal,
  });
  deps.log(`cloned ${req.repoURL} @ ${req.ref} -> ${cloned.resolvedSha}`);
  try {
    const { jobId } = await deps.runner.submit({
      targetName: req.consumerName,
      stage: target.stage,
      // A build-only unit has no chart directory. The runner's structure gate keys its chart checks on
      // the manifest's own `chart:` block, which such a manifest does not carry, so nothing joins this.
      chartPath: target.chartPath ?? "",
      repoURL: req.repoURL,
      requestedRef: req.ref,
      resolvedSha: cloned.resolvedSha,
      clusterValueFiles: target.clusterValueFiles,
      mustFailTargetsConfirmedListening: deps.attestListening,
      ...(req.repoCredentialId ? { repoCredentialId: req.repoCredentialId } : {}),
    });
    let runnerReport: GateReport;
    try {
      runnerReport = await pollToDone(deps, jobId);
    } catch (err) {
      // Abort, a poll error, or the poll budget: the run's objects still stand in the gate
      // namespace — above all the PAT-bearing credential Secret — and a poll that never returns
      // "done" means the runner's own settled-path reap never fires. cancel() is that reap;
      // best-effort, so the original error (what the operator must read) is never replaced.
      await deps.runner.cancel(jobId).catch(() => undefined);
      throw err;
    }

    // The builds the unit DECLARES — the manifest is the only source; nothing is derived from a
    // pipeline inventory or a naming prefix any more.
    const declaredBuilds = (runnerReport.manifest?.builds ?? []).map((b) => b.name);

    // G18's chart half reads the per-stage values file of the pinned chart. A unit without a chartPath
    // is build-only, and the half reports that instead of failing on a file that cannot exist.
    let chart: { path: string; stage: Stage; mapping: ChartPinMapping } | null = null;
    if (target.chartPath !== undefined) {
      const source = `${target.chartPath}/values-${target.stage}.yaml`;
      const valuesStageYaml = await deps.repo.readFile(cloned.workdir, source);
      chart = { path: target.chartPath, stage: target.stage, mapping: mapBuildsToChartPins({ declaredBuilds, source, valuesStageYaml }) };
    }

    // WHAT THE UNIT BRINGS, off the manifest — G24's input. Null for a build-only unit: nothing of
    // it deploys, so it holds no namespace and there is no quota to bound. The two fields are the
    // ones that both add an Argo source of their own and add a component to the quota sum.
    const brings: UnitComposition | null =
      target.chartPath === undefined
        ? null
        : {
            postgresql: (runnerReport.manifest?.services ?? []).includes("postgresql"),
            mongodb: runnerReport.manifest?.mongodb ?? "shared",
          };

    const foreignBuilds = await deps.registrations.listAttestedBuildNames(req.consumerName);
    // Read unconditionally: the unit's platform host is composed from its name whether or not the
    // manifest declares an extra fqdn, so the tenant-subdomain clause of G23 always has an object.
    const tenantSubdomains = await deps.tenantSubdomains();

    // G19's inputs exist only where a fqdn is declared: the attested set is read then (a stage file
    // that fails its schema throws loud there, and only there), and the two structural anchors come
    // off the target's values chain — empty for a build-only target, whose manifest cannot carry a
    // fqdn anyway. The chain read excludes only the candidate's own registration at THIS stage, so
    // its other stages' attestations count as taken.
    const declaredFqdn = runnerReport.manifest?.fqdn ?? null;
    const unitApex = declaredFqdn !== null && target.clusterValueFiles.length > 0 ? unitApexFromChain(target.clusterValueFiles) : null;
    const clusterDomain = declaredFqdn !== null ? clusterDomainFromChain(target.clusterValueFiles) : null;
    const foreignFqdns = declaredFqdn !== null ? await deps.registrations.listAttestedFqdns({ unit: req.consumerName, stage: target.stage }) : [];

    const managerGates: GateResult[] = [
      gateRepoAccess({ ok: true, detail: `cloned ${req.repoURL} at ${cloned.resolvedSha}` }),
      // The name first: it is the identity every later fact hangs off (namespace, AppProject,
      // build namespace, host), so a reserved name is refused before uniqueness is even asked.
      gateUnitName({ unitName: req.consumerName, tenantSubdomains }),
      gateBuildNameUniqueness({ unitName: req.consumerName, buildNames: declaredBuilds, foreignBuilds }),
      gateBuildDeclaration({ declaredBuilds, chart }),
      gateFqdnGrant({ unitName: req.consumerName, fqdn: declaredFqdn, unitApex, clusterDomain, foreignFqdns }),
      gateUnitSize({ unitName: req.consumerName, size: req.size, brings, quota: brings ? deps.resolveQuota(req.size, brings) : null }),
    ];
    for (const g of managerGates) deps.log(`${g.id} ${g.status} — ${g.detail}`);

    const report = composeReport(runnerReport, managerGates);

    return {
      verdict: report.verdict,
      resolvedSha: cloned.resolvedSha,
      report,
      builds: report.verdict === "pass" ? declaredBuilds : null,
    };
  } finally {
    await deps.repo.dispose(cloned.workdir);
  }
}
