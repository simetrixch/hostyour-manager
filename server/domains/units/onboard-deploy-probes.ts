// The deployable form's probes (hostyour-manager#208): the target's deploy-state, which
// attest-target re-asks at run time (step 0 of a mutating run stays a step), and the unit's DNS
// record — free, this cluster's already, another cluster's, or a leftover. The build steps' probes
// are the unit's (plugins/unit/server/build-probes.ts), and both answer in its finding shape.
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { consumerUnitHost } from "#unit/shared/unit-host.ts";
import { readStandingHost } from "#unit/server/unit-dns.ts";
import { preflightCheck, unmeasuredCheck } from "#unit/server/build-probes.ts";

/** attest-target's probe: the target's deploy-state stands and names this domain. */
export async function probeTarget(ports: OnboardPorts, p: DeployableOnboardParams): Promise<PreflightCheck[]> {
  const { clusterReader } = await ports.resolver.resolve(p.clusterId);
  const state = await clusterReader.readDeployState();
  if (!state) return [preflightCheck("target.deploy-state", `The target cluster ${p.domain}`, "hard", "fail", "carries no hostyour-cloud deploy-state", "is it a provisioned hostyour cluster?")];
  if (state.domain !== p.domain) return [preflightCheck("target.deploy-state", `The target cluster ${p.domain}`, "hard", "fail", `reports ${state.domain} in its deploy-state`)];
  return [preflightCheck("target.deploy-state", `The target cluster ${p.domain}`, "hard", "pass", `deploy-state generation ${state.generation}`)];
}

/** provision-dns's probe: the record's standing, judged the way the step judges it. */
export async function probeDns(ports: OnboardPorts, p: DeployableOnboardParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const recordName = consumerUnitHost(p.host, p.stage, p.unitApex);
  const title = `The DNS record ${recordName}`;
  if (!ports.dns) return [unmeasuredCheck("dns.record", title, "no DNS provider is wired on this manager")];
  const out: PreflightCheck[] = [];
  const judged = await readStandingHost(ports.dns, ctx.db, { recordName, clusterFqdn: p.domain, signal: ctx.signal });
  out.push(judged.kind === "free" ? preflightCheck("dns.record", title, "hard", "pass", "is free; the run creates it")
    : judged.kind === "ours" ? preflightCheck("dns.record", title, "hard", "pass", `already points at ${p.domain}`)
      : judged.kind === "leftover" ? preflightCheck("dns.record", title, "hard", "warn", `stands as ${judged.type} ${judged.content}, which points at no cluster of this installation; the run replaces it`)
        : preflightCheck("dns.record", title, "hard", "fail", `points at ${judged.cluster}, a cluster of this installation`, "offboard the unit there first"));
  return out;
}
