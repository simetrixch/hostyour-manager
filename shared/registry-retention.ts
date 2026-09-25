// Retention policy for the central registry cleanup. PURE — no IO. This is the "how many of each do
// we keep?" half of the registry reaper, factored out so the whole owner rule is unit-testable
// without a live registry. The IO half (the carrier search, catalog/tags, digest resolve + DELETE)
// lives in server/ (the registry-cleanup domain + the zot adapter); this module only DECIDES.
//
// THE OWNER RULE. Per image repository, keep:
//   - the last 10 STABLE releases (stable == the prod channel), and
//   - the last 10 NON-STABLE releases (alpha + beta SHARE one pot; a tag that carries no release
//     grammar at all falls into the non-stable pot too),
//   - everything older than that is a delete candidate.
// HARD SAFETY FLOOR (always wins): a tag a carrier PINS is never a delete candidate, regardless of
// age or pot count — a running deployment must never lose its image. That floor is the `referenced`
// set, union'd into keep UNCONDITIONALLY, before any count-trim can drop a tag.
import { parseReleaseTag } from "./release.ts";

/** The two retention pots the owner rule keeps independently:
 *  - "stable"     — a release on the prod channel (parseReleaseTag(...).channel === "stable").
 *  - "non-stable" — alpha + beta releases (they SHARE this pot), plus any tag whose base does not
 *                   match the release grammar at all (parseReleaseTag === null). */
export type RetentionClass = "stable" | "non-stable";

export interface ClassifiedTag {
  klass: RetentionClass;
  /** The ts14 (UTC yyyyMMddHHmmss) recovered from a release tag — the chronological sort key. Absent
   *  for a tag that carries no grammar; the caller must order those by push time instead. */
  ts14?: string;
}

/** The `-<sha7>` image-tag suffix the release pipeline appends: a release IMAGE tag is
 *  `<releaseTag>-<sha7>`, sha7 == exactly 7 lowercase hex. Stripped before parseReleaseTag so the
 *  release grammar matches the base. A bare release tag (no sha7) is left intact — its final segment is
 *  the 14-digit ts14, not 7 hex preceded by a dash, so it never mis-strips. */
const SHA7_SUFFIX = /-[0-9a-f]{7}$/;

/**
 * Classify one registry image tag into its retention pot (+ its ts14 when it is a release tag).
 * Strips the `-<sha7>` image suffix, then runs shared/release.ts parseReleaseTag on the remainder:
 *   channel "stable"        -> { klass: "stable",     ts14 }
 *   channel "alpha"|"beta"  -> { klass: "non-stable", ts14 }
 *   parseReleaseTag === null (anything off-grammar) -> { klass: "non-stable" }
 */
export function classifyImageTag(tag: string): ClassifiedTag {
  const base = tag.replace(SHA7_SUFFIX, "");
  const parsed = parseReleaseTag(base);
  if (parsed === null) return { klass: "non-stable" }; // off-grammar -> non-stable pot, no ts14
  if (parsed.channel === "stable") return { klass: "stable", ts14: parsed.ts14 };
  return { klass: "non-stable", ts14: parsed.ts14 }; // alpha + beta share the non-stable pot
}

/** One registry tag as the planner sees it. `ts14`/`pushedAt` are BOTH sort inputs: classifyImageTag
 *  fills ts14 from the release grammar; an off-grammar tag has neither from the grammar, so the caller
 *  MAY supply `pushedAt` (the registry push time) as the fallback chronological key. */
export interface RepoTag {
  tag: string;
  /** ts14 (UTC yyyyMMddHHmmss) — preferred sort key. Usually derived by the planner via classifyImageTag;
   *  a caller may also pass it for a tag it already parsed. */
  ts14?: string;
  /** Registry push time (any Date.parse-able string) — the fallback sort key for a tag with no ts14.
   *  Optional: the caller passes it only when it has it. */
  pushedAt?: string;
}

export interface RetentionPlan {
  /** Tags to KEEP — the last-N of each pot UNION the referenced floor. Order is repoTags input order. */
  keep: string[];
  /** Tags to DELETE — everything not kept. A referenced tag is NEVER here. */
  delete: string[];
}

export interface PlanRetentionInput {
  repoTags: RepoTag[];
  /** The HARD safety floor: the bare tags of this repo that a carrier pins. A tag in here is NEVER
   *  deleted, regardless of age or pot count. A referenced tag NOT present in repoTags is simply
   *  ignored (no error) — the caller may pass a repo-scoped or a superset set. */
  referenced: Set<string>;
  /** How many stable releases to keep per repo (default 10). */
  keepStable?: number;
  /** How many non-stable releases to keep per repo (default 10). */
  keepNonStable?: number;
}

/** ts14 "yyyyMMddHHmmss" (UTC) -> epoch ms, or null when it is not 14 well-formed digits. Converting to
 *  epoch (rather than comparing the raw string) lets a ts14 and an ISO pushedAt be ordered against each
 *  other on ONE numeric axis — the non-stable pot mixes alpha/beta (ts14) with off-grammar (pushedAt). */
function ts14ToEpochMs(ts14: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts14);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

/** The tag's effective chronological key as epoch ms: ts14 first, then pushedAt, else null (no time
 *  known). A null-time tag is treated as OLDEST (most trimmable); the referenced floor still protects
 *  it if it is pinned, so an imperfect order can never drop a deployed image. */
function effectiveEpochMs(t: RepoTag): number | null {
  if (t.ts14) {
    const e = ts14ToEpochMs(t.ts14);
    if (e !== null) return e;
  }
  if (t.pushedAt) {
    const e = Date.parse(t.pushedAt);
    if (!Number.isNaN(e)) return e;
  }
  return null;
}

/** Newest-first comparator. Tags WITH a time sort ahead of tags WITHOUT one; equal-or-both-missing
 *  times fall back to a deterministic tag-string order so the plan is stable across runs. */
function byNewestFirst(a: RepoTag, b: RepoTag): number {
  const ea = effectiveEpochMs(a);
  const eb = effectiveEpochMs(b);
  if (ea !== null && eb !== null) {
    if (ea !== eb) return eb - ea;
  } else if (ea !== null) {
    return -1; // a is timed, b is not -> a is "newer"
  } else if (eb !== null) {
    return 1; // b is timed, a is not -> b is "newer"
  }
  // both missing, or identical epoch -> deterministic tiebreak (tag string, descending)
  return a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0;
}

/**
 * Decide which of a repo's tags to keep and which to delete under the owner rule.
 *
 * keep = referenced(floor)  ∪  last10Stable(repo)  ∪  last10NonStable(repo).
 *
 * The referenced floor is union'd UNCONDITIONALLY and evaluated FIRST — a referenced tag is never a
 * delete candidate, no matter how old. delete = repoTags − keep. Both lists preserve repoTags input
 * order; a referenced tag is guaranteed absent from `delete`.
 */
export function planRetention(input: PlanRetentionInput): RetentionPlan {
  const keepStable = input.keepStable ?? 10;
  const keepNonStable = input.keepNonStable ?? 10;

  const stable: RepoTag[] = [];
  const nonStable: RepoTag[] = [];
  for (const rt of input.repoTags) {
    const c = classifyImageTag(rt.tag);
    // The tag's OWN grammar ts14 (from classifyImageTag) wins over a caller-supplied ts14 so a caller
    // can never mis-sort a release tag; the caller's pushedAt is kept as the fallback key.
    const ts14 = c.ts14 ?? rt.ts14;
    const enriched: RepoTag = {
      tag: rt.tag,
      ...(ts14 !== undefined ? { ts14 } : {}),
      ...(rt.pushedAt !== undefined ? { pushedAt: rt.pushedAt } : {}),
    };
    (c.klass === "stable" ? stable : nonStable).push(enriched);
  }
  stable.sort(byNewestFirst);
  nonStable.sort(byNewestFirst);

  const keptByCount = new Set<string>();
  for (const rt of stable.slice(0, keepStable)) keptByCount.add(rt.tag);
  for (const rt of nonStable.slice(0, keepNonStable)) keptByCount.add(rt.tag);

  const keep: string[] = [];
  const del: string[] = [];
  for (const rt of input.repoTags) {
    // referenced FIRST (the hard floor), then the per-pot count. Either one keeps the tag.
    if (input.referenced.has(rt.tag) || keptByCount.has(rt.tag)) keep.push(rt.tag);
    else del.push(rt.tag);
  }
  return { keep, delete: del };
}
