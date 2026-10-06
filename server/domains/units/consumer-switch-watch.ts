// What a consumer's Application renders after the Manager flips one of the registration's two
// switches, `suspended` or `quiesced`. The render from before the flip is Synced and Healthy too, and
// the consumers ApplicationSet regenerates the Application from git only on its next poll, minutes
// after the commit. So a wait reads the switch's value off the chart source ArgoCD last compared, and
// refreshes the ApplicationSet and the Application first, so that it does not sit out the poll.
import type { StepCtx } from "../../executor/types.ts";
import type { ArgoAppStatus, ClusterKubeResolver } from "../../adapters/kube/port.ts";
import { errValidation } from "../../kernel/errors.ts";

export type ConsumerSwitch = "suspended" | "quiesced";

/** The consumer chart's source: the repository and path the registration names. */
export interface ConsumerChart {
  repoURL: string;
  chartPath: string;
}

/** The switch's value on every source of the consumer chart, as ArgoCD last compared it. */
const switchValues = (s: ArgoAppStatus, chart: ConsumerChart, name: ConsumerSwitch): unknown[] =>
  (s.syncSources ?? []).filter((src) => src.repoURL === chart.repoURL && src.path === chart.chartPath).map((src) => src.valuesObject?.[name]);

/** Whether the Application renders the switch `name` as `on` (an absent value reads as off), with no
 *  refresh still queued, Synced and Healthy. */
export function rendersSwitch(s: ArgoAppStatus, chart: ConsumerChart, name: ConsumerSwitch, on: boolean): boolean {
  const values = switchValues(s, chart, name);
  return !s.refreshRequested && s.sync === "Synced" && s.health === "Healthy" && values.length > 0 &&
    values.every((v) => (on ? v === true : v === false || v === undefined));
}

/** Refresh the consumers ApplicationSet and the Application `appName`, then wait until it renders the
 *  switch `name` as `on`. `render` names that state in the refusal, e.g. "running" for suspended off. */
export async function watchConsumerSwitch(
  ports: { resolver: ClusterKubeResolver; argoWatchTimeoutMs: number },
  ctx: StepCtx,
  target: { clusterId: string; appName: string; chart: ConsumerChart },
  name: ConsumerSwitch,
  on: boolean,
  render: string,
): Promise<void> {
  const { argoReader, argoNamespace } = await ports.resolver.resolve(target.clusterId);
  await argoReader.refreshApplicationSet(argoNamespace, "consumer-apps");
  await argoReader.refreshApplications(argoNamespace, [target.appName]);
  const converged = (s: ArgoAppStatus): boolean => rendersSwitch(s, target.chart, name, on);
  const status = await argoReader.watchApplication(argoNamespace, target.appName, converged, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
  if (!converged(status)) {
    const seen = switchValues(status, target.chart, name).map(String).join(",") || "no source of the chart";
    throw errValidation(`Application ${target.appName} did not reach Synced/Healthy on the ${render} render — last seen ${name}=${seen}, sync=${status.sync}, health=${status.health}${status.refreshRequested ? ", a refresh still queued" : ""}${status.message ? ` (${status.message})` : ""}`);
  }
}
