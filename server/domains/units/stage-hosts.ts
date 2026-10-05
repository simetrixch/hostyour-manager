import { DnsZoneUnknownError, type DnsProvider } from "../../adapters/dns/port.ts";
import { prodHostOf, stageHost, stageHostProblem } from "#unit/shared/unit-host.ts";
import type { Stage } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";

// A dev or test host puts the stage directly before the zone that holds it (unit-host.ts stageHost),
// and the zone is the one the installation's DNS provider resolves. These read it per host.

type PlanLog = { log: (line: string) => void; signal?: AbortSignal };

/** The zone that holds `host`, or null where the provider holds none or none is configured. */
async function zoneOf(dns: DnsProvider | undefined, host: string, signal?: AbortSignal): Promise<string | null> {
  if (!dns) return null;
  try {
    return await dns.zoneName({ name: host, ...(signal ? { signal } : {}) });
  } catch (e) {
    if (e instanceof DnsZoneUnknownError) return null;
    throw e;
  }
}

/** Refuses the first of `typed` — the hosts an operator typed now for a tenant at `stage` — that breaks
 *  the stage rule, naming the host it would be. A caller passes only the hosts typed now: a previous
 *  host a move keeps as an alias, and one a run drops, are not judged. A host no zone of the provider
 *  holds, or any host where none is configured, cannot be judged; the plan log says so. */
export async function refuseOffStageHosts(dns: DnsProvider | undefined, typed: readonly string[], stage: Stage, ctx: PlanLog): Promise<void> {
  for (const host of typed) {
    const zone = await zoneOf(dns, host, ctx.signal);
    if (zone === null) {
      ctx.log(`the stage rule is not checked for ${host}: ${dns ? "no zone of this installation's DNS provider holds it" : "no DNS provider is configured on this manager"}, so its zone cannot be read`);
      continue;
    }
    const problem = stageHostProblem(host, zone, stage);
    if (problem !== null) throw errValidation(problem);
  }
}

/** The host at `target` of `host`, which stands at `source`: read back to its prod host and composed
 *  for `target`, both under the zone that holds it. "" stays "". THROWS where the zone cannot be read,
 *  or where `host` breaks the stage rule at `source`. */
export async function hostAtStage(dns: DnsProvider | undefined, host: string, source: Stage, target: Stage, signal?: AbortSignal): Promise<string> {
  if (!host) return "";
  const zone = await zoneOf(dns, host, signal);
  if (zone === null) {
    throw errValidation(`${dns ? `no zone of this installation's DNS provider holds ${host}` : "no DNS provider is configured on this manager"}, so the zone of ${host}, and with it its host at ${target}, cannot be read`);
  }
  const prod = prodHostOf(host, zone, source);
  if (prod === null) throw errValidation(`${stageHostProblem(host, zone, source)} — set it right at ${source} before adding ${target}`);
  return stageHost(prod, zone, target);
}
