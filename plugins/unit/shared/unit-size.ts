import { z } from "zod";
import { addCpu, addMemory, timesCpu, timesMemory } from "./quantity.ts";

// The size of a UNIT — one consumer, or one member namespace of a tenant. A size is what the unit is
// sold: the ceiling its namespace may request and burst to. Shared by both families on purpose, so
// there is ONE vocabulary and one table behind it rather than a consumer notion and a tenant notion
// that drift.
//
// WHERE THE NUMBERS LIVE, and why not here. The three presets below are the SEED — what a fresh
// installation starts with. The table an installation actually runs on lives in the Manager's own
// inventory (plugins/unit/server/schema.ts, unitSizes), because it has to be editable while the
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

/** The size names, smallest first. `small`, `medium` and `large` are the words the PostgreSQL presets
 *  use (hostyour-cloud/apps/postgresql/values-size-<size>.yaml) and the ids every registration written
 *  before the other three existed stores, so they keep their spelling. A unit has ONE size for its
 *  application, and each data part of its own (PostgreSQL, MongoDB) has its own size, which starts as
 *  the unit's at onboarding and moves only when Set size names it: a small application with a large
 *  database is a real customer. The quota stays one sum the operator can read back part by part
 *  (composeQuota's parts). Not every size has a row for every component (see UNIT_SIZE_SEED): a size
 *  a unit's parts have no row for is not offered to it. */
export const UNIT_SIZE = ["xsmall", "small", "medium", "large", "xlarge", "xxlarge"] as const;
export type UnitSize = (typeof UNIT_SIZE)[number];
export const UnitSizeSchema = z.enum(UNIT_SIZE);

/** What an operator reads: the letter, beside the stored id. */
export const UNIT_SIZE_LETTER: Record<UnitSize, string> = { xsmall: "XS", small: "S", medium: "M", large: "L", xlarge: "XL", xxlarge: "XXL" };

/** The sizes a tenant may be put on. XL and XXL are seeded but held back: every digita pod runs one
 *  replica, so what they add beyond L is memory nobody's request can use until the engine and the web
 *  front run several replicas. */
export const TENANT_SIZE = ["xsmall", "small", "medium", "large"] as const satisfies readonly UnitSize[];
export const TenantSizeSchema = z.enum(TENANT_SIZE);

/** WHAT a size is being asked for. A unit's namespace holds its application and, when it brings
 *  them, its own databases — and each weighs differently, so each has its own row per size. The
 *  quota a unit gets is their SUM, worked out from what it actually brings:
 *
 *      quota = app(size) + postgresql(size)? + mongodb(size) x members
 *
 *  where `app` is `base` for a consumer's own application and `member` for one member namespace of a
 *  tenant, whose pods are the product's and were measured as such. A handful of rows per component the
 *  operator adjusts — against hundreds if every combination were its own row, which is a table nobody
 *  maintains. The parts stay visible in the UI, so the one number a unit gets can be read back to
 *  where it came from. */
export const SIZE_COMPONENT = ["base", "postgresql", "mongodb", "member"] as const;
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
 * Read it as four tables, which is what the Sizes screen shows:
 *
 *   base         what a consumer's own application gets (all six sizes)
 *   postgresql   what ONE PostgreSQL instance gets, when the unit brings its own (all six sizes)
 *   mongodb      what ONE MongoDB MEMBER gets — multiplied by 1 for a standalone, 3 for a replica set
 *                (all six sizes)
 *   member       what ONE member namespace of a tenant gets (all six sizes)
 *
 * A consumer is offered only the sizes its parts have rows for; the extra consumer sizes wait for
 * figures of their own rather than borrowing a tenant's.
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
 *   - `member` rests on no machine floor: its requests were measured on a digita tenant's pods with
 *     one and two people working (twice the largest member at XS, scaled x2, x4, x8, x12, x16 above),
 *     and its limits are the owner's. The same factor of two holds: the pods' shapes per size are the
 *     product's, and the Manager refuses a size whose rendered pods do not fit it twice. 8 pods,
 *     because the quota counts terminated pods too, and two leftovers must not block the next
 *     rollout's surge pod. 1 claim, the schema's minimum; tenant members claim none. On top of all
 *     that, each member row holds one CERT_SOLVER: cert-manager runs it in the member's namespace while
 *     a certificate of the member is issued or renewed, and a rollout must not wait for it to end.
 */
/** The pod cert-manager starts in a member namespace for an HTTP-01 challenge, at the figures it sets
 *  on it. It stands until the challenge passes, and every renewal starts one again. */
export const CERT_SOLVER: UnitQuota = { requestsCpu: "10m", requestsMemory: "64Mi", limitsCpu: "100m", limitsMemory: "64Mi", pods: 1, persistentVolumeClaims: 0 };

const withSolver = (q: UnitQuota): UnitQuota => ({
  requestsCpu: addCpu(q.requestsCpu, CERT_SOLVER.requestsCpu), requestsMemory: addMemory(q.requestsMemory, CERT_SOLVER.requestsMemory),
  limitsCpu: addCpu(q.limitsCpu, CERT_SOLVER.limitsCpu), limitsMemory: addMemory(q.limitsMemory, CERT_SOLVER.limitsMemory),
  pods: q.pods + CERT_SOLVER.pods, persistentVolumeClaims: q.persistentVolumeClaims,
});

export const UNIT_SIZE_SEED = {
  base: {
    // xsmall is half of small, xlarge 1.5 x large and xxlarge 2 x large: the member rows' steps.
    xsmall: { requestsCpu: "200m", requestsMemory: "512Mi", limitsCpu: "750m", limitsMemory: "1Gi", pods: 8, persistentVolumeClaims: 1 },
    small:  { requestsCpu: "400m", requestsMemory: "1Gi", limitsCpu: "1500m", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 },
    medium: { requestsCpu: "800m", requestsMemory: "2Gi", limitsCpu: "3", limitsMemory: "4Gi", pods: 16, persistentVolumeClaims: 2 },
    large:  { requestsCpu: "1600m", requestsMemory: "4Gi", limitsCpu: "6", limitsMemory: "8Gi", pods: 32, persistentVolumeClaims: 4 },
    xlarge: { requestsCpu: "2400m", requestsMemory: "6Gi", limitsCpu: "9", limitsMemory: "12Gi", pods: 48, persistentVolumeClaims: 6 },
    xxlarge: { requestsCpu: "3200m", requestsMemory: "8Gi", limitsCpu: "12", limitsMemory: "16Gi", pods: 64, persistentVolumeClaims: 8 },
  },
  // The data rows of the three new sizes are the cloud's presets (hostyour-cloud apps/postgresql and
  // apps/mongodb values-size-<size>.yaml), PostgreSQL's with its exporter, rounded up as above.
  postgresql: {
    xsmall: { requestsCpu: "25m", requestsMemory: "256Mi", limitsCpu: "400m", limitsMemory: "512Mi", pods: 2, persistentVolumeClaims: 1 },
    small:  { requestsCpu: "50m", requestsMemory: "512Mi", limitsCpu: "600m", limitsMemory: "1Gi", pods: 2, persistentVolumeClaims: 1 },
    medium: { requestsCpu: "150m", requestsMemory: "1536Mi", limitsCpu: "1200m", limitsMemory: "2560Mi", pods: 2, persistentVolumeClaims: 1 },
    large:  { requestsCpu: "300m", requestsMemory: "2560Mi", limitsCpu: "2200m", limitsMemory: "4608Mi", pods: 2, persistentVolumeClaims: 1 },
    xlarge: { requestsCpu: "450m", requestsMemory: "3584Mi", limitsCpu: "3200m", limitsMemory: "6656Mi", pods: 2, persistentVolumeClaims: 1 },
    xxlarge: { requestsCpu: "600m", requestsMemory: "4608Mi", limitsCpu: "4200m", limitsMemory: "8704Mi", pods: 2, persistentVolumeClaims: 1 },
  },
  mongodb: {
    xsmall: { requestsCpu: "50m", requestsMemory: "256Mi", limitsCpu: "500m", limitsMemory: "1Gi", pods: 1, persistentVolumeClaims: 1 },
    small:  { requestsCpu: "100m", requestsMemory: "512Mi", limitsCpu: "1", limitsMemory: "2Gi", pods: 1, persistentVolumeClaims: 1 },
    medium: { requestsCpu: "250m", requestsMemory: "1Gi", limitsCpu: "2", limitsMemory: "4Gi", pods: 1, persistentVolumeClaims: 1 },
    large:  { requestsCpu: "500m", requestsMemory: "2Gi", limitsCpu: "4", limitsMemory: "8Gi", pods: 1, persistentVolumeClaims: 1 },
    xlarge: { requestsCpu: "750m", requestsMemory: "3Gi", limitsCpu: "6", limitsMemory: "12Gi", pods: 1, persistentVolumeClaims: 1 },
    xxlarge: { requestsCpu: "1", requestsMemory: "4Gi", limitsCpu: "8", limitsMemory: "16Gi", pods: 1, persistentVolumeClaims: 1 },
  },
  member: {
    xsmall: withSolver({ requestsCpu: "100m", requestsMemory: "576Mi", limitsCpu: "2", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 }),
    small: withSolver({ requestsCpu: "200m", requestsMemory: "1152Mi", limitsCpu: "4", limitsMemory: "4Gi", pods: 8, persistentVolumeClaims: 1 }),
    medium: withSolver({ requestsCpu: "400m", requestsMemory: "2304Mi", limitsCpu: "6", limitsMemory: "6Gi", pods: 8, persistentVolumeClaims: 1 }),
    large: withSolver({ requestsCpu: "800m", requestsMemory: "4608Mi", limitsCpu: "8", limitsMemory: "10Gi", pods: 8, persistentVolumeClaims: 1 }),
    xlarge: withSolver({ requestsCpu: "1200m", requestsMemory: "6912Mi", limitsCpu: "8", limitsMemory: "15Gi", pods: 8, persistentVolumeClaims: 1 }),
    xxlarge: withSolver({ requestsCpu: "1600m", requestsMemory: "9216Mi", limitsCpu: "8", limitsMemory: "20Gi", pods: 8, persistentVolumeClaims: 1 }),
  },
} satisfies SizeTable;

/** The seed read by a component and size only known at run time. */
const SEED: SizeTable = UNIT_SIZE_SEED;

/** The sizes a component has seed rows for, smallest first. The table's rows are the seed's: boot
 *  inserts the absent ones and the Sizes screen edits, never adds, so this is what every
 *  installation holds. */
export const seededSizes = (component: SizeComponent): UnitSize[] => UNIT_SIZE.filter((s) => SEED[component][s] !== undefined);

/** The components a unit's quota is summed from, each with how many times it counts. */
export function quotaParts(brings: UnitComposition): { component: SizeComponent; members: number }[] {
  const members = MONGODB_MEMBERS[brings.mongodb];
  return [
    { component: brings.app ?? "base", members: 1 },
    ...(brings.postgresql ? [{ component: "postgresql" as const, members: 1 }] : []),
    ...(members > 0 ? [{ component: "mongodb" as const, members }] : []),
  ];
}

/** The sentence that names a size a unit's parts have no row for. */
export const missingRow = (component: SizeComponent, size: UnitSize): string =>
  `the size table holds no "${component}" row for size "${size}" — that size is not offered for what this unit brings`;

/** What a unit BRINGS, which is what decides how much of the table applies to it. Not a size: it
 *  says only whether its databases are there and, for MongoDB, how many members it takes. What size
 *  each runs at is PartSizes. */
/** A size table: component -> size -> figures, holding only the rows that exist. */
export type SizeTable = Record<SizeComponent, Partial<Record<UnitSize, UnitQuota>>>;

export interface UnitComposition {
  /** Whose application the namespace runs: a consumer's (`base`, the default) or a tenant member's. */
  app?: "base" | "member";
  postgresql: boolean;
  mongodb: MongodbMode;
}

/** A tenant brings no database of its own: its members claim the cluster's shared MongoDB replica set
 *  and no tenant runs a PostgreSQL, so each member namespace's quota is the member row alone. */
export const TENANT_BRINGS: UnitComposition = { app: "member", postgresql: false, mongodb: "shared" };

/** The data parts a unit may run of its own, each with a size and a volume of its own. */
export const DATA_PART = ["postgresql", "mongodb"] as const;
export type DataPart = (typeof DATA_PART)[number];

/** Each data part's size, beside the unit's `size` (the application's). The consumers ApplicationSet
 *  reads `dig "sizes" "<part>" .size`, so a part without one runs at the unit's size, and the key is a
 *  map or absent: its dig fails on null or a list, and stops the whole set. */
export const PartSizesSchema = z.object({ postgresql: UnitSizeSchema.optional(), mongodb: UnitSizeSchema.optional() });
export type PartSizes = z.infer<typeof PartSizesSchema>;

/** Each data part's volume, as the quantity its claim was created with — for MongoDB, each member's.
 *  A claim cannot grow on these clusters (microk8s-hostpath expands nothing) and its spec is immutable,
 *  so it is written once and no resize touches it: Set size changes CPU and memory only. */
export const PartVolumesSchema = z.object({ postgresql: z.string().regex(/^[0-9]+[MGT]i$/).optional(), mongodb: z.string().regex(/^[0-9]+[MGT]i$/).optional() });
export type PartVolumes = z.infer<typeof PartVolumesSchema>;

/** The volume a data part is created with, per size. The three old sizes' are the presets' own, which
 *  is what every claim written before the pin was created from; the new sizes have no preset volume
 *  for the appset to fall back to, so their pin is the only thing that sizes the claim. */
export const ONBOARDING_VOLUME: Record<DataPart, Record<UnitSize, string>> = {
  postgresql: { xsmall: "2Gi", small: "5Gi", medium: "20Gi", large: "50Gi", xlarge: "100Gi", xxlarge: "200Gi" },
  mongodb: { xsmall: "5Gi", small: "10Gi", medium: "40Gi", large: "100Gi", xlarge: "200Gi", xxlarge: "400Gi" },
};

/** The size a component of a unit runs at: a data part its own when it has one, all else the unit's. */
export const sizeOf = (component: SizeComponent, size: UnitSize, sizes: PartSizes = {}): UnitSize =>
  component === "postgresql" || component === "mongodb" ? sizes[component] ?? size : size;

/** The data parts a unit runs of its own. */
export const dataParts = (brings: UnitComposition): DataPart[] =>
  DATA_PART.filter((p) => (p === "postgresql" ? brings.postgresql : MONGODB_MEMBERS[brings.mongodb] > 0));

/** What an onboarding writes beside `size`: every part it runs at that one size, each pinned to that
 *  size's volume. Neither key for a unit with no data part of its own. */
export function partSizing(size: UnitSize, brings: UnitComposition): { sizes?: PartSizes; volumes?: PartVolumes } {
  const parts = dataParts(brings);
  if (parts.length === 0) return {};
  return {
    sizes: Object.fromEntries(parts.map((p) => [p, size])),
    volumes: Object.fromEntries(parts.map((p) => [p, ONBOARDING_VOLUME[p][size]])),
  };
}

/** The metrics exporter a MongoDB of the unit's own runs beside its members: ONE pod per instance,
 *  whatever the member count, so it is no row of the per-member `mongodb` table. Its figures are the
 *  ones the cloud's chart sets on it (the shared set's exporter uses 15m/44Mi live). Without them the
 *  exporter takes its share from `base`, and a unit whose own pods fill `base` gets an exporter that
 *  never schedules. */
export const MONGODB_EXPORTER: UnitQuota = { requestsCpu: "15m", requestsMemory: "48Mi", limitsCpu: "100m", limitsMemory: "128Mi", pods: 1, persistentVolumeClaims: 0 };

/** The one quota a unit gets: base + postgresql + mongodb x members (+ its exporter), summed as Kubernetes quantities.
 *  Returned with its PARTS so a screen can show where the number came from — a ceiling nobody can
 *  trace back is a ceiling nobody checks. */
export function composeQuota(
  table: SizeTable,
  size: UnitSize,
  brings: UnitComposition,
  sizes: PartSizes = {},
): { quota: UnitQuota; parts: { component: SizeComponent | "mongodb-exporter"; members: number; each: UnitQuota }[] } {
  const parts: { component: SizeComponent | "mongodb-exporter"; members: number; each: UnitQuota }[] = quotaParts(brings).map((p) => {
    const at = sizeOf(p.component, size, sizes);
    const each = table[p.component][at];
    if (!each) throw new Error(missingRow(p.component, at));
    return { ...p, each };
  });
  if (MONGODB_MEMBERS[brings.mongodb] > 0) parts.push({ component: "mongodb-exporter", members: 1, each: MONGODB_EXPORTER });
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
export function seedQuota(size: UnitSize, brings: UnitComposition = { postgresql: false, mongodb: "shared" }, sizes: PartSizes = {}): UnitQuota {
  return composeQuota(UNIT_SIZE_SEED, size, brings, sizes).quota;
}

/** The size a unit gets when nobody named one. `small` for the same reason the PostgreSQL chart
 *  defaults to it: a render that states no size must land on the frugal preset, never the generous
 *  one, or an unattended path quietly hands out the largest ceiling the platform sells. */
export const DEFAULT_UNIT_SIZE = "small" satisfies UnitSize;
