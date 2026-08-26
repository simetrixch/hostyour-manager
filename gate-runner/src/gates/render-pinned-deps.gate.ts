// gate-runner/src/gates/render-pinned-deps.gate.ts
// G3 "render + pinned deps" (hard) — the render PHASE that also produces ctx.rendered +
// ctx.dependencies for every later gate. The dependency pin comes first: a chart with dependencies must pin
// them (a committed Chart.lock, or a fully vendored charts/ with no remote repositories) — a version
// range with no lock is a FAIL, because the resolved dep can drift after validation. Then
// `helm dependency build`, then `helm template` per declared env (public egress only — a private/
// RFC1918 dep fails the build), then kubeconform against the target k8s minor. The lock check is pure
// (unit-tested); the helm/kubeconform calls need the tools and are integration-tested on the live clusters.
import { writeFile } from "node:fs/promises";
import { parse } from "yaml";
import type { GateResult, ResolvedDependency } from "../../../shared/gates.ts";
import { splitAtChartValues, type ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { RenderedDoc } from "./gate.ts";
import { fail, pass } from "./result.ts";
import { run, ExecError } from "../exec.ts";
import { parseRenderedDocs } from "../render-docs.ts";

const ID = "G3";
const TITLE = "render + pinned deps";
const SEVERITY = "hard" as const;
const EXPECTED =
  "the chart renders per declared env with pinned dependencies (Chart.lock or vendored charts/), no <no value>, and passes kubeconform";

const RANGE = /[\^~><*x|]|\s-\s/; // a helm/semver version that is NOT an exact pin

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface DependencyLockResult {
  ok: boolean;
  dependencies: ResolvedDependency[];
  reason: string | null; // set when !ok
}

/** PURE dependency-pin check over the repo files. `Chart.yaml` dependencies must be pinned: a committed
 *  `Chart.lock` (records the resolved set + a digest) pins any range; otherwise every dependency must
 *  be vendored under `charts/` with no remote `repository` and an exact version. */
export function checkDependencyLock(files: ReadonlyMap<string, string>, chartPath: string): DependencyLockResult {
  const base = chartPath.replace(/\/+$/, "");
  const chartYaml = files.get(`${base}/Chart.yaml`);
  if (chartYaml === undefined) {
    return { ok: false, dependencies: [], reason: `no Chart.yaml at ${base}/Chart.yaml — the chart path is not a Helm chart` };
  }
  let chart: Record<string, unknown>;
  try {
    chart = asObject(parse(chartYaml));
  } catch {
    return { ok: false, dependencies: [], reason: `${base}/Chart.yaml is not valid YAML` };
  }
  const deps = asArray(chart.dependencies).map(asObject);
  if (deps.length === 0) return { ok: true, dependencies: [], reason: null };

  const lockText = files.get(`${base}/Chart.lock`);
  if (lockText !== undefined) {
    let lock: Record<string, unknown>;
    try {
      lock = asObject(parse(lockText));
    } catch {
      return { ok: false, dependencies: [], reason: `${base}/Chart.lock is not valid YAML` };
    }
    const digest = str(lock.digest);
    if (digest === "") {
      return { ok: false, dependencies: [], reason: `${base}/Chart.lock carries no digest — it does not pin the dependency set` };
    }
    const resolved: ResolvedDependency[] = asArray(lock.dependencies)
      .map(asObject)
      .map((d) => ({ name: str(d.name), version: str(d.version), digest }));
    return { ok: true, dependencies: resolved, reason: null };
  }

  // No lock: require every dependency vendored under charts/ with an exact version and no remote repo.
  const resolved: ResolvedDependency[] = [];
  for (const d of deps) {
    const name = str(d.name);
    const version = str(d.version);
    const repo = str(d.repository);
    if (repo !== "" && !repo.startsWith("file://")) {
      return { ok: false, dependencies: [], reason: `dependency "${name}" has a remote repository (${repo}) but no Chart.lock — pin it with a committed Chart.lock` };
    }
    if (RANGE.test(version) || version === "") {
      return { ok: false, dependencies: [], reason: `dependency "${name}" version "${version}" is not an exact pin and there is no Chart.lock` };
    }
    const vendored = [...files.keys()].some((p) => p.startsWith(`${base}/charts/${name}/`) || p === `${base}/charts/${name}.tgz`);
    if (!vendored) {
      return { ok: false, dependencies: [], reason: `dependency "${name}" is neither vendored under ${base}/charts/ nor pinned by a Chart.lock` };
    }
    resolved.push({ name, version, digest: `vendored:${version}` });
  }
  return { ok: true, dependencies: resolved, reason: null };
}

export interface RenderInput {
  workspace: string;
  chartPath: string;
  targetName: string;
  envs: readonly string[]; // manifest.envs — render every declared env
  /** The target cluster's values chain, VERBATIM and in layering order (shared/cluster-values.ts). */
  clusterValueFiles: readonly ClusterValueFile[];
  files: ReadonlyMap<string, string>;
  kubeVersion: string; // e.g. "1.30.0" — kubeconform target
  depBuildMs: number;
  renderMs: number;
  signal: AbortSignal; // the whole-job budget / DELETE cancellation — kills a stuck helm mid-run
}

export interface RenderOutcome {
  result: GateResult;
  rendered: RenderedDoc[];
  dependencies: ResolvedDependency[];
}

/** Where one chain file is staged in the workspace. The index keeps the layering order visible and
 *  the flattened chain path keeps the name recognisable in a helm error. */
export function stagedClusterValuePath(workspace: string, index: number, chainPath: string): string {
  return `${workspace}/.gate-cluster-values-${index}-${chainPath.replaceAll("/", "-")}`;
}

/** The `helm template` argv for one env. Values come from FILES only, never `--set`, and they layer
 *  in the order the ApplicationSet lists them: the platform's files, then the chart's own two, then
 *  the cluster's own map, which wins over everything. Nothing the Manager computed enters the render.
 *
 *  THE CHART'S FILES SIT IN THE MIDDLE and that position is the whole point. Layering the chain
 *  entirely after them would let the platform's defaults beat a chart value the deploy lets the
 *  chart set; layering it entirely before would let the chart beat the cluster's own map, which the
 *  deploy does not. Either way an approved render and a deployed render say different things, which
 *  is the one outcome this chain exists to make impossible. */
export function renderArgs(
  targetName: string,
  chartDir: string,
  env: string,
  staged: { beforeChart: readonly string[]; afterChart: readonly string[] },
): string[] {
  return [
    "template",
    targetName,
    chartDir,
    "--namespace",
    targetName,
    ...staged.beforeChart.flatMap((path) => ["-f", path]),
    "-f",
    `${chartDir}/values.yaml`,
    "-f",
    `${chartDir}/values-${env}.yaml`,
    ...staged.afterChart.flatMap((path) => ["-f", path]),
  ];
}

function g3Fail(reason: string, found: string): GateResult {
  return fail({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found, reason });
}

/** The render phase. Integration-tested on the live clusters (needs helm + kubeconform). */
export async function runRender(input: RenderInput): Promise<RenderOutcome> {
  const lock = checkDependencyLock(input.files, input.chartPath);
  if (!lock.ok) {
    return { result: g3Fail(lock.reason ?? "dependencies are not pinned", "dependency pinning check failed"), rendered: [], dependencies: [] };
  }

  const chartDir = input.chartPath.replace(/\/+$/, "");
  const budgetBytes = 32 * 1024 * 1024;

  // Stage the cluster's values chain next to the clone so helm can layer the SAME bytes ArgoCD does.
  // Written under the workspace root, outside the chart, so the chart's own file set is untouched
  // (the static gates already read their files map before this point).
  const stagedChain: { path: string; staged: string }[] = [];
  for (const [i, file] of input.clusterValueFiles.entries()) {
    const staged = stagedClusterValuePath(input.workspace, i, file.path);
    try {
      await writeFile(staged, file.content, "utf8");
    } catch (e) {
      return {
        result: g3Fail(`could not stage the cluster values file ${file.path}: ${String(e)}`, `staging ${file.path} failed`),
        rendered: [],
        dependencies: lock.dependencies,
      };
    }
    stagedChain.push({ path: file.path, staged });
  }
  // Where the chart's own values.yaml and values-<env>.yaml go, decided by the chain definition and
  // not by this file, so the two cannot come apart.
  const split = splitAtChartValues(stagedChain);
  const stagedSplit = { beforeChart: split.beforeChart.map((e) => e.staged), afterChart: split.afterChart.map((e) => e.staged) };

  if (lock.dependencies.length > 0) {
    try {
      await run("helm", ["dependency", "build", chartDir], { cwd: input.workspace, timeoutMs: input.depBuildMs, maxBytes: budgetBytes, signal: input.signal });
    } catch (e) {
      const msg = e instanceof ExecError ? e.stderr.slice(0, 800) || e.message : String(e);
      return { result: g3Fail(`helm dependency build failed (a private/RFC1918 dependency is rejected here): ${msg}`, "dependency build failed"), rendered: [], dependencies: lock.dependencies };
    }
  }

  const rendered: RenderedDoc[] = [];
  for (const env of input.envs) {
    const args = renderArgs(input.targetName, chartDir, env, stagedSplit);
    let stream: string;
    try {
      stream = (await run("helm", args, { cwd: input.workspace, timeoutMs: input.renderMs, maxBytes: budgetBytes, signal: input.signal })).stdout;
    } catch (e) {
      const msg = e instanceof ExecError ? e.stderr.slice(0, 800) || e.message : String(e);
      return { result: g3Fail(`helm template failed for env "${env}": ${msg}`, `render failed for env ${env}`), rendered: [], dependencies: lock.dependencies };
    }
    if (stream.includes("<no value>")) {
      return { result: g3Fail(`the render for env "${env}" contains "<no value>" — a template referenced a missing value`, `<no value> in env ${env}`), rendered: [], dependencies: lock.dependencies };
    }
    const docs = parseRenderedDocs(stream, env);
    rendered.push(...docs);

    // kubeconform over the env's rendered stream (offline schemas bundled in the image). execFile
    // does not pipe stdin, so the render is staged to a workspace file and validated from there.
    // -ignore-missing-schemas: a compliant consumer chart ALWAYS renders CRD instances kubeconform has
    // no built-in schema for (ExternalSecret + SecretStore from ESO — required by G7 — plus our own
    // ServiceClaim). Without this flag -strict would hard-reject them, so no compliant chart could pass.
    // The core Kubernetes resources (Deployment/Service/Ingress/...) are still fully validated; the CRDs
    // are covered elsewhere (G7 checks the secret path; the provisioner validates ServiceClaim at apply).
    const renderFile = `${input.workspace}/.gate-render-${env}.yaml`;
    try {
      await writeFile(renderFile, stream, "utf8");
    } catch (e) {
      return { result: g3Fail(`could not stage the render for kubeconform (env "${env}"): ${String(e)}`, `stage failed for env ${env}`), rendered: [], dependencies: lock.dependencies };
    }
    try {
      await run("kubeconform", ["-strict", "-ignore-missing-schemas", "-summary", "-kubernetes-version", input.kubeVersion, renderFile], {
        cwd: input.workspace,
        timeoutMs: input.renderMs,
        maxBytes: budgetBytes,
        signal: input.signal,
      });
    } catch (e) {
      const msg = e instanceof ExecError ? e.stderr.slice(0, 800) || e.message : String(e);
      return { result: g3Fail(`kubeconform rejected the render for env "${env}": ${msg}`, `schema validation failed for env ${env}`), rendered: [], dependencies: lock.dependencies };
    }
  }

  return {
    result: pass({
      id: ID,
      title: TITLE,
      severity: SEVERITY,
      expected: EXPECTED,
      found:
        `rendered ${rendered.length} document(s) across ${input.envs.length} env(s) with ${lock.dependencies.length} pinned dependency(ies) ` +
        `over the cluster values chain ${input.clusterValueFiles.map((f) => f.path).join(" -> ")}; no <no value>; kubeconform clean.`,
    }),
    rendered,
    dependencies: lock.dependencies,
  };
}
