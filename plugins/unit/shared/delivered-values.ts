// THE VALUES THE CONSUMERS APPLICATIONSET DELIVERS to a unit's chart, beside its own values files:
// hostyour-cloud clusters/argocd/files/consumers-appset.yaml, the `valuesObject` of the unit's own
// source. They come from the unit's registration, which the Manager writes from the manifest, and
// from the cluster's map. The sandbox gate renders a chart with exactly these, so a chart that
// guards a delivered value passes the gate where ArgoCD's render passes, and fails where it fails.
// delivered-values.appset.test.ts holds this composition to the ApplicationSet's own render.
import type { Stage } from "#core/shared/enums.ts";
import { consumerUnitHost, stageApex } from "./unit-host.ts";

export interface DeliveredValuesInput {
  /** The unit's public host label (shared/consumer.ts consumerHostLabel). */
  hostLabel: string;
  stage: Stage;
  /** The cluster map's `global.unitApex`. */
  unitApex: string;
  /** The cluster map's `global.apiHost`, where an SMTP entry is delivered; "" where the map has none, as
   *  clusters/argocd fills `__API_HOST__`. */
  apiHost: string;
  /** The manifest's `databases`, `keyPatterns` and `channelPatterns`, copied verbatim into the registration. */
  databases: readonly string[];
  keyPatterns: readonly string[];
  channelPatterns: readonly string[];
  /** The manifest's `smtpEntry`, where it declares one; the registration attests it. */
  smtpEntry?: { service: string; port: number } | undefined;
}

/** A list as the ApplicationSet's YAML delivers it: its `range` over an empty list leaves the key with no
 *  items, which YAML reads as null, so a chart meets null and never [] there. */
const asDelivered = (items: readonly string[]): string[] | null => (items.length > 0 ? [...items] : null);

/** What the ApplicationSet hands the unit's chart at its onboarding: running, not quiesced. */
export function deliveredValues(input: DeliveredValuesInput): Record<string, unknown> {
  return {
    suspended: false,
    quiesced: false,
    unitHost: consumerUnitHost(input.hostLabel, input.stage, input.unitApex),
    global: { stageApex: stageApex(input.unitApex, input.stage) },
    mongodb: { databases: asDelivered(input.databases) },
    redis: { keyPatterns: asDelivered(input.keyPatterns), channelPatterns: asDelivered(input.channelPatterns) },
    ...(input.smtpEntry ? { smtpEntry: { service: input.smtpEntry.service, port: input.smtpEntry.port, address: input.apiHost } } : {}),
  };
}
