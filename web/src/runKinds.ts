import { RUN_FAMILY, type RunKind } from "../../shared/enums.ts";

/** The CONSUMER lifecycle run family (the ONB block of shared/enums.ts). The Consumers section's
 *  runs tab filters the ONE shared runs list to exactly these kinds. Read from RUN_FAMILY, the ONE
 *  declaration of the grouping — the same one the run-definitions.total boot check asserts the run definitions
 *  against, so the tab and the boot check can never disagree about what the family is.
 *
 *  Filter by KIND, never by targetId: an `onboard` run freezes targetKind "cluster" + targetId a
 *  clusterId (the app row does not exist yet at plan time), while offboard/suspend/resume target the
 *  app — so a `targetId === consumerId` filter would drop every onboard run AND mismatch.
 *  `adopt-consumer` too: it targets the CLUSTER (a detected consumer has no app row to target). */
export const CONSUMER_RUN_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(RUN_FAMILY.consumer);

/** The TENANT lifecycle run family (the TNT block of shared/enums.ts). The Tenants section's runs tab
 *  filters the ONE shared runs list to exactly these kinds — the tenant analogue of CONSUMER_RUN_KINDS,
 *  read from the same RUN_FAMILY declaration. Same KIND-not-targetId rule: a `create-tenant` run freezes
 *  targetKind "cluster" + targetId a clusterId (the tenant row does not exist yet at plan time), while
 *  add-app/remove-app + the tenant lifecycle target the tenant — so a `targetId === tenantId` filter
 *  would drop every create-tenant run. tenant-purge belongs here for the SAME reason `purge` belongs to
 *  the consumer set: it targets the CLUSTER (an orphan has no tenant row to target), so only a kind
 *  filter surfaces it at all. */
export const TENANT_RUN_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(RUN_FAMILY.tenant);

/** The three run kinds that touch a host's ~/.ssh/authorized_keys. Listed rather than read off
 *  RUN_FAMILY, because they are only PART of the cluster family — the two sets above happen to be
 *  whole families and this one never can be, since adopt and deploy-slave belong to the same family
 *  and to a different page. Every literal here is a RunKind, so a rename in shared/enums.ts breaks
 *  this build rather than quietly emptying the tab. */
export const OPERATOR_KEY_RUN_KINDS: ReadonlySet<RunKind> = new Set<RunKind>([
  "operator-key-place", "operator-key-remove", "authorized-keys-read",
]);
