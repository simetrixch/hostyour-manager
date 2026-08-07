// The registry reaper — the in-cluster program that prunes aged images from the central registry
// under the owner rule (keep the last 10 stable + 10 non-stable per repository), with the HARD safety
// floor that any tag a carrier PINS is never deleted. This module is the DOMAIN orchestration; the
// decision (planRetention) is pure in shared/registry-retention.ts, the floor comes out of the ONE
// pin search (./search.ts), and the IO is behind ports.
//
// SAFETY IS THE TOP GOAL — this program DELETES images; a bug destroys a running deployment. The
// guardrails, in force here:
//   - THE FLOOR IS THE SEARCH. The referenced set is exactly what searchCarriers finds, so the floor
//     and the release bump read the same three carrier classes and cannot disagree about what is
//     pinned. A floor built from some other tree can go silently empty when that tree moves; this one
//     cannot, because the thing it reads is the thing that writes the pins.
//   - AN EMPTY FLOOR ABORTS. A run whose search found no pin at all is refused BEFORE any delete plan
//     exists. Nothing that deploys pins nothing, so an empty floor means the search did not see what
//     it was supposed to see — and every aged tag of every repository would be on the delete plan.
//   - FAIL-CLOSED: every read (the search, listRepos, listTags, resolveDigest) can only ABORT the
//     whole run — nothing is deleted on a bad read. An incomplete floor could omit a live tag, so a
//     partial read is never acted on.
//   - KEEP-SET FIRST: the floor is union'd into keep BEFORE any count-trim. A referenced tag is
//     unconditionally kept, regardless of age.
//   - DRY_RUN: the {keep, delete} plan is logged in FULL every run; a dry run skips only the DELETE calls.
//   - DIGEST-SHARING GUARD: DELETE is by digest, and one digest may back several tags — a delete-tag
//     whose digest is ALSO a kept tag's digest is SKIPPED (deleting it would strip the kept tag too).
//   - SCOPE: only OUR repositories are ever touched. With flat image names ours are exactly the
//     single-segment ones; a multi-segment name (library/redis, …) is a pull-through cache the
//     registry manages under its own retention, and the floor says nothing about those.
//
// Reads run in phases so ALL reads (including every digest resolve) complete before the FIRST delete:
// a failure anywhere in the read phases aborts with nothing removed.
import type { RegistryMaintenance, ManifestDigest } from "../../adapters/registry/port.ts";
import { pinKey } from "../../../shared/pin.ts";
import { planRetention } from "../../../shared/registry-retention.ts";
import { searchCarriers, type SearchDeps } from "./search.ts";

/** The minimal logger the reaper needs — pino's Logger satisfies it, and a test passes a spy. */
export interface ReapLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface ReapDeps extends SearchDeps {
  /** The registry maintenance client (push credential) — catalog/tags/digest/delete. */
  registry: RegistryMaintenance;
  logger: ReapLogger;
  /** When true the DELETE calls are SKIPPED — the plan is still logged in full. The entrypoint defaults
   *  this to true so a missing/garbled flag can never delete by accident. */
  dryRun: boolean;
  keepStable?: number;
  keepNonStable?: number;
  signal?: AbortSignal;
}

export interface RepoPlan {
  repo: string;
  keep: string[];
  delete: string[];
}

export interface ReapResult {
  dryRun: boolean;
  /** How many pins the search found, across all three carrier classes. */
  referencedCount: number;
  repos: RepoPlan[];
  /** The (repo, digest) manifests actually deleted (empty on a dry run or when nothing aged out), each
   *  with the tag(s) that pointed at it. */
  deleted: { repo: string; digest: ManifestDigest; tags: string[] }[];
}

/** OUR repositories in the catalog: the single-segment ones. An image name is the flat build name, so
 *  a "/" in a repository name means it is not one of ours — it is a pull-through cache of an upstream
 *  registry, which the registry evicts on its own schedule and which no carrier pins. */
function isOurs(repo: string): boolean {
  return !repo.includes("/");
}

/**
 * Run the reaper once. Returns the plan + what was deleted. THROWS (fail-closed, nothing deleted) on
 * any read error and on an empty floor — the caller entrypoint turns a throw into exit 1.
 */
export async function reap(deps: ReapDeps): Promise<ReapResult> {
  const sig = deps.signal ? { signal: deps.signal } : {};

  // ── PHASE 1 — the referenced safety floor: the pin search, unchanged. Any read error aborts here,
  // before a single delete. `referenced` is keyed "<image>:<tag>" and builds[].image IS the repository
  // name, so the keys match the catalog exactly.
  const hits = await searchCarriers(deps, deps.signal);
  const referenced = new Set(hits.map((h) => pinKey(h.pin)));
  if (referenced.size === 0) {
    throw new Error(
      "registry-reaper: the referenced floor is EMPTY — the pin search over the unit charts, the catalog catalog and the hostyour-cloud platform apps found nothing. " +
        "Anything deployed pins an image, so an empty floor means the search did not see what it should have, and every aged tag would be on the delete plan. Refusing to prune; nothing deleted.",
    );
  }
  deps.logger.info(
    { carriers: new Set(hits.map((h) => h.carrier)).size, pins: hits.length, referenced: referenced.size },
    "registry-reaper: referenced floor built from the pin search",
  );

  // ── PHASE 2 — plan retention per in-scope repo. Still all reads, no delete yet.
  const allRepos = await deps.registry.listRepos(sig);
  const repoPlans: RepoPlan[] = [];
  for (const repo of allRepos.filter(isOurs)) {
    const tags = await deps.registry.listTags(repo, sig);
    const referencedForRepo = new Set<string>();
    for (const tag of tags) if (referenced.has(`${repo}:${tag}`)) referencedForRepo.add(tag);
    const plan = planRetention({
      // Only {tag} is supplied. Release tags carry a ts14 (recovered by classifyImageTag), so stable and
      // alpha/beta are ordered by real mint time. A tag with no ts14 has no true recency and sorts by a
      // deterministic tag-string tiebreak instead. That is SAFE (only NON-referenced tags are trimmed and
      // every pinned tag is protected by the exact-match floor), but among aged, non-referenced
      // off-grammar tags "the last 10" is unspecified. Pass a registry `created` time as pushedAt here if
      // true recency is ever needed — planRetention already supports it.
      repoTags: tags.map((tag) => ({ tag })),
      referenced: referencedForRepo,
      ...(deps.keepStable !== undefined ? { keepStable: deps.keepStable } : {}),
      ...(deps.keepNonStable !== undefined ? { keepNonStable: deps.keepNonStable } : {}),
    });
    repoPlans.push({ repo, keep: plan.keep, delete: plan.delete });
    deps.logger.info(
      { repo, keep: plan.keep, delete: plan.delete, referenced: [...referencedForRepo] },
      "registry-reaper: repo retention plan",
    );
  }

  // ── PHASE 3 — resolve digests (STILL reads) and build the delete plan with the digest-sharing guard.
  // Every resolveDigest runs BEFORE any deleteManifest, so a resolve failure fails closed with nothing removed.
  const deletePlan: { repo: string; digest: ManifestDigest; tags: string[] }[] = [];
  for (const { repo, keep, delete: del } of repoPlans) {
    if (del.length === 0) continue;
    // Digest of every KEPT tag — the guard set. A delete tag sharing one of these digests is skipped.
    const keepDigests = new Set<ManifestDigest>();
    for (const tag of keep) keepDigests.add(await deps.registry.resolveDigest(repo, tag, sig));
    // Group the delete tags by digest, dropping any digest a kept tag shares.
    const byDigest = new Map<ManifestDigest, string[]>();
    for (const tag of del) {
      const digest = await deps.registry.resolveDigest(repo, tag, sig);
      if (keepDigests.has(digest)) {
        deps.logger.warn({ repo, tag, digest }, "registry-reaper: SKIP delete — digest is shared with a kept tag");
        continue;
      }
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), tag]);
    }
    for (const [digest, tags] of byDigest) deletePlan.push({ repo, digest, tags });
  }
  deps.logger.info({ dryRun: deps.dryRun, manifests: deletePlan.length, plan: deletePlan }, "registry-reaper: delete plan resolved (all reads complete)");

  // ── PHASE 4 — the ONLY writes. Skipped entirely on a dry run.
  const deleted: { repo: string; digest: ManifestDigest; tags: string[] }[] = [];
  if (deps.dryRun) {
    deps.logger.info({ manifests: deletePlan.length }, "registry-reaper: DRY_RUN — no manifests deleted");
  } else {
    for (const d of deletePlan) {
      await deps.registry.deleteManifest(d.repo, d.digest, sig);
      deps.logger.info({ repo: d.repo, digest: d.digest, tags: d.tags }, "registry-reaper: deleted manifest");
      deleted.push(d);
    }
  }

  return { dryRun: deps.dryRun, referencedCount: referenced.size, repos: repoPlans, deleted };
}
