// G27, the unit host gate: the unit's host as the DNS provider answers it now, judged against this
// installation's own clusters, before a run writes anything. Every onboarding that gives a unit a
// host runs it, and every gate that quotes untrusted text caps it the same way.
import type { GateResult } from "#core/shared/gates.ts";
import { standingHostRefusal, type StandingHost } from "./unit-dns.ts";

// The manifest's build names and the chart's values file are UNTRUSTED input, and GateResultSchema
// caps expected/found/reason at 2000 chars — a report over the cap fails its own schema and would
// wedge the run instead of rejecting it. Every list built from repo content goes through this.
const TEXT_CAP = 600;
export const capGateText = (text: string): string => (text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text);

/** G27 unit host (HARD). The ZONE, read before the run writes anything: the unit's host
 *  `<label>.<stage apex>` as the DNS provider answers it now, judged against this installation's own
 *  clusters (unit-dns.ts readStandingHost). The name gates hold the host against registrations and
 *  tenant subdomains, never against the zone — and the zone is exactly what stopped a run at its
 *  thirteenth step after twelve writes (hostyour-manager#151: a record the abandoned installation's
 *  onboarding had left at the old slave's address).
 *
 *  Four readings, two verdicts: a free host and a host already pointing at the target pass; a host
 *  whose record points at no cluster of this installation passes too and SAYS that provision-dns
 *  will replace it, with what stands there as evidence; a host pointing at another cluster of this
 *  installation fails with the sentence provision-dns would refuse it with. `standing: null` is a
 *  Manager with no DNS provider: a deployable unit cannot be onboarded there at all, and this row
 *  says so before provision-dns would have said it at step thirteen. */
export function gateUnitHost(input: { host: string; unitName: string; clusterFqdn: string; standing: StandingHost | null }): GateResult {
  const expected = `the host ${input.host} is free, already points at ${input.clusterFqdn}, or carries a record that points at no cluster of this installation (what an installation that is gone left in the zone, which provision-dns replaces) — never another cluster of this installation`;
  const base = { id: "G27", title: "unit host", severity: "hard" as const, expected };
  const s = input.standing;
  if (s === null) {
    return {
      ...base, status: "fail",
      found: "no DNS provider is wired on this manager, so the zone could not be read",
      reason: "the unit's ONE public record is a mandatory part of this run kind (provision-dns fails loud without a provider); set CLOUDFLARE_DNS_API_TOKEN on the manager and plan the onboarding again",
      detail: "no DNS provider — the host cannot be measured",
    };
  }
  switch (s.kind) {
    case "free":
      return { ...base, status: "pass", found: `${input.host} is free — no record stands under it`, reason: null, detail: "host is free" };
    case "ours":
      return { ...base, status: "pass", found: `${input.host} already points at ${input.clusterFqdn} — a re-run of this onboarding, not a takeover`, reason: null, detail: "host already ours" };
    case "leftover":
      return {
        ...base, status: "pass",
        found: capGateText(`${input.host} stands as ${s.type} ${s.content}, which points at no cluster of this installation — what an installation that is gone left in the zone; provision-dns replaces it with a CNAME onto ${input.clusterFqdn}`),
        reason: null,
        detail: "host is a leftover of a gone installation — will be replaced",
        evidence: [{ source: "manager" as const, name: input.host, fieldPath: "standing", value: `${s.type} ${s.content}` }],
      };
    case "collision":
      return {
        ...base, status: "fail",
        found: capGateText(standingHostRefusal(input.host, input.unitName, s)),
        reason: "one stage of a unit has ONE host, and another cluster of this installation serves it — offboard the unit there first, or give the two clusters different unit_apex answers",
        detail: "host is served by another cluster of this installation",
        evidence: [{ source: "manager" as const, name: input.host, fieldPath: "standing", value: `CNAME ${s.cluster}` }],
      };
  }
}
