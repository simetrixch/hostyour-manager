import { z } from "zod";
import { addCpu, addMemory, timesCpu, timesMemory } from "./quantity.ts";

// The size of a UNIT — one consumer, or one member namespace of a tenant. A size is what the unit is
// sold: the ceiling its namespace may request and burst to. Shared by both families on purpose, so
// there is ONE vocabulary and one table behind it rather than a consumer notion and a tenant notion
// that drift.
//
// WHERE THE NUMBERS LIVE, and why not here. The three presets below are the SEED — what a fresh
// installation starts with. The table an installation actually runs on lives in the Manager's own
// inventory (server/db/schema/inventory.ts, unitSizes), because it has to be editable while the
// platform runs: a size is a commercial fact, and it changes without a release.
//
// HOW A CHANGE REACHES A CLUSTER. Not by a chart reading this table — no cluster can read the
// Manager's database. The Manager RESOLVES the size when it writes a unit's registration, so the
// registration carries the four figures literally, and ArgoCD delivers them like every other value in
// it. A registration therefore states what its unit gets, with nothing to look up; the cost is that
// changing the table means rewriting the registrations that name that size, which is a git commit per
// unit and visible as such.
//
// A CONSUMER CANNOT DECLARE ITS OWN. There is deliberately no size field in ConsumerManifestSchema:
// the manifest is written by the customer, and a customer choosing their own ceiling is not a ceiling.
// The platform assigns it, and the manifest says only WHAT the consumer runs — its own PostgreSQL,
// its own MongoDB and with how many members — never how big any of it is.

/** The size names. The same three words the PostgreSQL presets use
 *  (hostyour-cloud/apps/postgresql/values-size-<size>.yaml), and a unit has exactly ONE of them: its
 *  application and its databases are all sized by it. "A medium application with a large database"
 *  is deliberately not expressible — one size governs the whole unit, which is the only shape in
 *  which the ceiling stays something an operator can reason about. */
export const UNIT_SIZE = ["small", "medium", "large"] as const;
export type UnitSize = (typeof UNIT_SIZE)[number];
export const UnitSizeSchema = z.enum(UNIT_SIZE);

/** WHAT a size is being asked for. A unit's namespace holds its application and, when it brings
 *  them, its own databases — and each weighs differently, so each has its own row per size. The
 *  quota a unit gets is their SUM, worked out from what it actually brings:
 *
 *      quota = base(size) + postgresql(size)? + mongodb(size) x members
 *
 *  Three components, three sizes, nine rows the operator adjusts — against 84 if every combination
 *  were its own row, which is a table nobody maintains. The parts stay visible in the UI, so the one
 *  number a unit gets can be read back to where it came from. */
export const SIZE_COMPONENT = ["base", "postgresql", "mongodb"] as const;
export type SizeComponent = (typeof SIZE_COMPONENT)[number];
export const SizeComponentSchema = z.enum(SIZE_COMPONENT);

/** How a unit runs MongoDB. Not a size and not a price: `standalone` is ONE member and MongoDB
 *  serves NO TRANSACTIONS from one — a replica set is what makes them work, which is why this
 *  platform's own products need `replicaset` and why the choice belongs to a consumer whose
 *  application may not. `shared` is the default and means the cluster's own replica set, the one
 *  every tenant uses; the member counts below are what the quota multiplies by. */
export const MONGODB_MODE = ["shared", "standalone", "replicaset"] as const;
export type MongodbMode = (typeof MONGODB_MODE)[number];
export const MongodbModeSchema = z.enum(MONGODB_MODE);
export const MONGODB_MEMBERS: Record<MongodbMode, number> = { shared: 0, standalone: 1, replicaset: 3 };

/** The six figures one namespace is bounded by — the ResourceQuota hostyour-cloud/apps/unit-quota
 *  renders, field for field. Strings for the resource quantities because that is what Kubernetes takes
 *  and what preserves "500m" and "1Gi" as written; numbers for the two counts, which are counts. */
export const UnitQuotaSchema = z.object({
  requestsCpu: z.string().min(1),
  requestsMemory: z.string().min(1),
  limitsCpu: z.string().min(1),
  limitsMemory: z.string().min(1),
  pods: z.number().int().positive(),
  persistentVolumeClaims: z.number().int().positive(),
});
export type UnitQuota = z.infer<typeof UnitQuotaSchema>;

/**
 * The seed table: what a fresh installation starts with, per COMPONENT and size. Once seeded it is the
 * DATABASE that answers, so editing these changes what the NEXT installation starts with, never what a
 * running one uses.
 *
 * Read it as three tables of three rows, which is what the Sizes screen shows:
 *
 *   base         what the unit's own application gets
 *   postgresql   what ONE PostgreSQL instance gets, when the unit brings its own
 *   mongodb      what ONE MongoDB MEMBER gets — multiplied by 1 for a standalone, 3 for a replica set
 *
 * WHERE THE NUMBERS COME FROM, measured on a real installation:
 *
 *   - The platform itself schedules ~4.3 vCPU / ~10.2 GiB of requests, and these figures were derived
 *     against a smallest supported machine of 8 vCPU / 16 GiB, which leaves all units together
 *     roughly 3.7 vCPU and 5.8 GiB.
 *     THAT FLOOR IS NOT THE ONE THE PLATFORM ADMITS. The gate that actually admits a machine asks
 *     for 2 processors and about 3.8 GiB. On a machine at THAT floor the platform's own requests
 *     do not fit at all, so every figure below rests on a floor nothing enforces. The two cannot
 *     both stand, and which of them is wrong is not readable from either side — it is stated here
 *     rather than left implicit, because a derivation resting on a floor nothing enforces is a
 *     number with no source at all.
 *   - `base` covers the application alone. A tenant member namespace sums to at most 200m/384Mi (an
 *     app: engine + front), and a consumer's own chart is its own business — small doubles that and
 *     the larger sizes double again.
 *   - `postgresql` is the chart's own preset plus its metrics exporter (10m/32Mi):
 *     25m/256Mi at small, 100m/1Gi at medium, 250m/2Gi at large, rounded up to leave the exporter room.
 *     NO surge factor: apps/postgresql runs the Recreate strategy — two pods never exist at once.
 *   - `mongodb` is one member. The platform's own shared set runs its members at 250m/512Mi requested
 *     and bursts to 4 vCPU / 4Gi (apps/mongodb/values-prod.yaml), which is this table's `medium`.
 *   - The `base` figures carry a factor of two, and that is arithmetic rather than headroom: an
 *     application Deployment runs one replica under the default RollingUpdate strategy, whose maxSurge
 *     rounds up to 1, so old and new pod exist at once during every deploy and both count. A quota
 *     that fits the steady state exactly does not slow a deploy down, it deadlocks it.
 */
export const UNIT_SIZE_SEED: Record<SizeComponent, Record<UnitSize, UnitQuota>> = {
  base: {
    small:  { requestsCpu: "400m", requestsMemory: "1Gi", limitsCpu: "1500m", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 },
    medium: { requestsCpu: "800m", requestsMemory: "2Gi", limitsCpu: "3", limitsMemory: "4Gi", pods: 16, persistentVolumeClaims: 2 },
    large:  { requestsCpu: "1600m", requestsMemory: "4Gi", limitsCpu: "6", limitsMemory: "8Gi", pods: 32, persistentVolumeClaims: 4 },
  },
  postgresql: {
    small:  { requestsCpu: "50m", requestsMemory: "512Mi", limitsCpu: "600m", limitsMemory: "1Gi", pods: 2, persistentVolumeClaims: 1 },
    medium: { requestsCpu: "150m", requestsMemory: "1536Mi", limitsCpu: "1200m", limitsMemory: "2560Mi", pods: 2, persistentVolumeClaims: 1 },
    large:  { requestsCpu: "300m", requestsMemory: "2560Mi", limitsCpu: "2200m", limitsMemory: "4608Mi", pods: 2, persistentVolumeClaims: 1 },
  },
  mongodb: {
    small:  { requestsCpu: "100m", requestsMemory: "512Mi", limitsCpu: "1", limitsMemory: "2Gi", pods: 1, persistentVolumeClaims: 1 },
    medium: { requestsCpu: "250m", requestsMemory: "1Gi", limitsCpu: "2", limitsMemory: "4Gi", pods: 1, persistentVolumeClaims: 1 },
    large:  { requestsCpu: "500m", requestsMemory: "2Gi", limitsCpu: "4", limitsMemory: "8Gi", pods: 1, persistentVolumeClaims: 1 },
  },
};

/** What a unit BRINGS, which is what decides how much of the table applies to it. Not a second size:
 *  the databases run at the unit's own size, so this says only whether they are there and, for
 *  MongoDB, how many members it takes. */
export interface UnitComposition {
  postgresql: boolean;
  mongodb: MongodbMode;
}

/** The one quota a unit gets: base + postgresql + mongodb x members, summed as Kubernetes quantities.
 *  Returned with its PARTS so a screen can show where the number came from — a ceiling nobody can
 *  trace back is a ceiling nobody checks. */
export function composeQuota(
  table: Record<SizeComponent, Record<UnitSize, UnitQuota>>,
  size: UnitSize,
  brings: UnitComposition,
): { quota: UnitQuota; parts: { component: SizeComponent; members: number; each: UnitQuota }[] } {
  const members = MONGODB_MEMBERS[brings.mongodb];
  const parts: { component: SizeComponent; members: number; each: UnitQuota }[] = [
    { component: "base", members: 1, each: table.base[size] },
    ...(brings.postgresql ? [{ component: "postgresql" as const, members: 1, each: table.postgresql[size] }] : []),
    ...(members > 0 ? [{ component: "mongodb" as const, members, each: table.mongodb[size] }] : []),
  ];
  const quota: UnitQuota = {
    requestsCpu: addCpu(...parts.map((p) => timesCpu(p.each.requestsCpu, p.members))),
    requestsMemory: addMemory(...parts.map((p) => timesMemory(p.each.requestsMemory, p.members))),
    limitsCpu: addCpu(...parts.map((p) => timesCpu(p.each.limitsCpu, p.members))),
    limitsMemory: addMemory(...parts.map((p) => timesMemory(p.each.limitsMemory, p.members))),
    pods: parts.reduce((n, p) => n + p.each.pods * p.members, 0),
    persistentVolumeClaims: parts.reduce((n, p) => n + p.each.persistentVolumeClaims * p.members, 0),
  };
  return { quota, parts };
}

/** The quota a unit of this size gets out of the SEED table for what it brings — what a fresh
 *  installation resolves before anyone edits the table, and the one value a fixture needs. Defaults to
 *  a unit that brings no database of its own, which is most of them. */
export function seedQuota(size: UnitSize, brings: UnitComposition = { postgresql: false, mongodb: "shared" }): UnitQuota {
  return composeQuota(UNIT_SIZE_SEED, size, brings).quota;
}

/** The size a unit gets when nobody named one. `small` for the same reason the PostgreSQL chart
 *  defaults to it: a render that states no size must land on the frugal preset, never the generous
 *  one, or an unattended path quietly hands out the largest ceiling the platform sells. */
export const DEFAULT_UNIT_SIZE: UnitSize = "small";
