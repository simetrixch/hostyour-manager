// The Manager's RegistryProbe port (tenant ensure-images). The tenant fan-out charts pull every
// first-party image from the registry their cluster's values chain names (zot.<build-plane>); the
// ensure-images step asks THIS port whether a pinned <repo>:<tag> already exists there BEFORE the
// tenant pointer is written. A missing tag fails the run, and an undecidable probe fails closed.
//
// Kept a PORT (types only) so the domain step depends on the abstraction; the concrete fetch impl
// lives in registry-http.ts (the same /v2 manifest probe the image-guard PreSync hook curls, using
// the same mounted manager-registry-pull dockerconfigjson), the fake in testing/.

/** One registry-hosted image coordinate: the registry host + the repository path under it + the
 *  bare tag — exactly how the requiredImages entries split `<registryHost>/<repo>:<tag>`. */
export interface ImageRef {
  /** The registry host the tenant charts pull from (zot.<build-plane>, the target cluster's own). */
  registryHost: string;
  /** The repository under the host — a flat, single-segment name, e.g. "example-engine". */
  repo: string;
  /** The bare tag, e.g. "0.29.0". */
  tag: string;
}

export interface RegistryProbe {
  /** true iff the manifest for <registryHost>/<repo>:<tag> exists (a 2xx probe); false on a 404
   *  (the tag is missing). ANY other outcome — 401/5xx, unreachable registry, unreadable pull
   *  credential — THROWS: presence cannot be decided, so the caller fails closed rather than
   *  guessing (never skip a build on a broken probe, never rebuild a live tag on one either). */
  imageExists(ref: ImageRef, opts?: { signal?: AbortSignal }): Promise<boolean>;
}

/** A resolved manifest digest, e.g. "sha256:abc…". A registry DELETE is BY digest, never by tag,
 *  because ONE digest may back SEVERAL tags — the reaper resolves the digest and skips the delete when
 *  a KEPT tag shares it (registry-cleanup/reap.ts digest-sharing guard). */
export type ManifestDigest = string;

/**
 * The registry-MAINTENANCE port (the registry reaper): enumerate the catalog, list a repo's tags,
 * resolve a tag to its manifest digest, and DELETE a manifest by digest. Deliberately SEPARATE from
 * RegistryProbe: the reaper deletes, so its concrete adapter is directed at the PUSH credential (the
 * push-user holds delete rights; the pull-only credential the probe uses does not).
 *
 * Every method inherits RegistryProbe's fail-closed contract: an undecidable outcome — a non-2xx
 * status that is not the method's defined "absent" answer, an unreachable registry, an unreadable
 * credential, a missing digest header, unparseable JSON — THROWS. The reaper builds its keep-set from
 * these reads before it deletes anything, so a silently partial answer could drop a live tag; failing
 * closed aborts the whole run with nothing removed instead.
 */
export interface RegistryMaintenance {
  /** Every repository name in the catalog (GET /v2/_catalog, following pagination). Throws on any
   *  undecidable outcome (an incomplete catalog must never be treated as complete). */
  listRepos(opts?: { signal?: AbortSignal }): Promise<string[]>;
  /** Every tag on `repo` (GET /v2/<repo>/tags/list, following pagination). A genuinely absent repo
   *  (404) or a null tag list yields []. Any other undecidable outcome THROWS (a partial tag list could
   *  drop a live tag from the keep-set). */
  listTags(repo: string, opts?: { signal?: AbortSignal }): Promise<string[]>;
  /** Resolve <repo>:<tag> to its manifest digest (HEAD /v2/<repo>/manifests/<tag> →
   *  Docker-Content-Digest). Fail-closed: a missing header, a 404 (the tag vanished after we listed it —
   *  a race, never a normal answer), or any other non-2xx THROWS. */
  resolveDigest(repo: string, tag: string, opts?: { signal?: AbortSignal }): Promise<ManifestDigest>;
  /** Delete a manifest BY digest (DELETE /v2/<repo>/manifests/<digest>). 2xx ⇒ deleted; 404 ⇒ already
   *  gone (idempotent). Any other outcome THROWS — a delete that neither clearly succeeded nor was
   *  clearly a no-op must fail loud, never be assumed done. */
  deleteManifest(repo: string, digest: ManifestDigest, opts?: { signal?: AbortSignal }): Promise<void>;
}
