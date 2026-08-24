// The concrete RegistryProbe (tenant ensure-images): a plain fetch of the OCI distribution
// manifest endpoint https://<registryHost>/v2/<repo>/manifests/<tag> — the SAME probe the
// image-guard PreSync hook curls (apps/manager/templates/imageguard-job.yaml), reimplemented
// manager-side. Auth is the basic-auth `auth` value out of the mounted manager-registry-pull
// dockerconfigjson (the pull credential the Deployment's imagePullSecrets already reference); the
// file is read FRESH per probe because kubelet refreshes secret-volume files in a running pod, so
// an ESO resync lands without a restart. An adapter, so the IO (fetch + fs) lives here — the
// domain step drives it through the RegistryProbe port.
import { readFile } from "node:fs/promises";
import type { RegistryProbe, ImageRef, RegistryMaintenance, ManifestDigest } from "./port.ts";
import { AppError } from "../../kernel/errors.ts";

/** The manifest media types the probe accepts — OCI image/index + docker v2 manifest/list, the
 *  exact Accept set the image-guard probe sends (a registry may 404 an unlisted media type). */
const MANIFEST_ACCEPT =
  "application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json," +
  "application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json";

function upstream(msg: string): AppError {
  return new AppError("UPSTREAM", `registry probe: ${msg}`);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The base64 basic-auth value for `registryHost` out of a mounted dockerconfigjson —
 * `.auths[<host>].auth`, the EXACT host and nothing else. The host is chain-resolved
 * (zot.<build-plane>), so it can name a registry the mounted credential does not cover; presenting
 * some other entry's value would turn that misconfiguration into a misleading 401 from a foreign
 * registry, so a missing entry fails naming the host and the entries the file does carry.
 * Unreadable file / invalid JSON / no matching entry ⇒ UPSTREAM (fail closed): the manager-side
 * registry clients never degrade to a guess. `credentialLabel` names the credential in the error so
 * a missing pull vs push secret is told apart. Read FRESH per call because kubelet refreshes
 * secret-volume files in a running pod (an ESO resync lands without a restart).
 */
async function readDockerConfigAuth(dockerConfigPath: string, registryHost: string, credentialLabel: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(dockerConfigPath, "utf8");
  } catch (e) {
    throw upstream(`could not read ${credentialLabel} at ${dockerConfigPath} (is its ExternalSecret synced?): ${errMsg(e)}`);
  }
  let auths: Record<string, { auth?: unknown } | undefined>;
  try {
    auths = (JSON.parse(raw) as { auths?: Record<string, { auth?: unknown }> }).auths ?? {};
  } catch (e) {
    throw upstream(`the dockerconfigjson at ${dockerConfigPath} is not valid JSON: ${errMsg(e)}`);
  }
  const auth = auths[registryHost]?.auth;
  if (typeof auth !== "string" || auth.length === 0) {
    const carried = Object.keys(auths);
    throw upstream(
      `the dockerconfigjson at ${dockerConfigPath} carries no auth entry for ${registryHost} ` +
      `(it carries: ${carried.length ? carried.join(", ") : "none"}) — the ${credentialLabel} must cover the registry the target cluster's values chain names`,
    );
  }
  return auth;
}

/** Compose a per-request timeout with the caller's cancel signal (HttpActivator's shape): a hung
 *  registry cannot stall past `timeoutMs`, while a caller abort still cancels promptly. Returns the
 *  effective signal + a cleanup that MUST run in a finally. */
function composeAbort(timeoutMs: number, outer: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(new Error(`registry request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onOuterAbort = (): void => timer.abort((outer as AbortSignal).reason);
  if (outer) {
    if (outer.aborted) timer.abort(outer.reason);
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  return {
    signal: timer.signal,
    done: (): void => {
      clearTimeout(t);
      if (outer) outer.removeEventListener("abort", onOuterAbort);
    },
  };
}

/** The `rel="next"` URL from an RFC-5988 Link header, as a host-relative path, or null. The OCI
 *  distribution catalog + tags endpoints paginate via this header — following it is what makes the
 *  reaper's catalog/tags reads COMPLETE (a partial list must never be trusted). */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(header);
  if (!m?.[1]) return null;
  const url = m[1];
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export interface HttpRegistryProbeConfig {
  /** Where the Deployment mounts the manager-registry-pull dockerconfigjson (a plain directory
   *  mount, so the file refreshes in the running pod after an ESO resync). */
  dockerConfigPath: string;
  /** Per-probe fetch budget; defaults to 15s (the image-guard probe's --max-time). */
  timeoutMs?: number;
}

export class HttpRegistryProbe implements RegistryProbe {
  constructor(private readonly cfg: HttpRegistryProbeConfig) {}

  async imageExists(ref: ImageRef, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    const auth = await this.readBasicAuth(ref.registryHost);
    // Compose a timeout with the caller's cancel signal so a hung registry cannot stall the run
    // past its budget, while a run cancel still aborts the fetch promptly (HttpActivator's shape).
    const timeoutMs = this.cfg.timeoutMs ?? 15_000;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`registry probe timed out after ${timeoutMs}ms`)), timeoutMs);
    const onOuterAbort = (): void => timer.abort((opts.signal as AbortSignal).reason);
    if (opts.signal) {
      if (opts.signal.aborted) timer.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      let res: Response;
      try {
        res = await fetch(`https://${ref.registryHost}/v2/${ref.repo}/manifests/${ref.tag}`, {
          method: "GET",
          headers: { accept: MANIFEST_ACCEPT, authorization: `Basic ${auth}` },
          signal: timer.signal,
          redirect: "manual", // never follow a redirect off the central registry (the credential is a header)
        });
      } catch (e) {
        throw upstream(`${ref.registryHost} is unreachable probing ${ref.repo}:${ref.tag}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await res.arrayBuffer().catch(() => undefined); // drain — a manifest body is small; never leak the stream
      if (res.status === 404) return false; // the tag is genuinely absent — buildable
      if (res.ok) return true;
      // 401/403/5xx/anything else: presence cannot be decided — fail closed, never guess.
      throw upstream(`the manifest probe for ${ref.repo}:${ref.tag} on ${ref.registryHost} answered HTTP ${res.status} — presence cannot be decided`);
    } finally {
      clearTimeout(t);
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }

  /** The base64 basic-auth value for the registry host out of the mounted manager-registry-pull
   *  dockerconfigjson (the pull credential). Delegates to the shared reader; fail-closed on an
   *  unreadable file or no usable entry. */
  private async readBasicAuth(registryHost: string): Promise<string> {
    return readDockerConfigAuth(this.cfg.dockerConfigPath, registryHost, "the mounted manager-registry-pull dockerconfigjson (the pull credential)");
  }
}

export interface HttpRegistryMaintenanceConfig {
  /** The central registry host this reaper prunes (zot.<master-domain>) — the LOCAL registry. All
   *  requests are `https://<registryHost>/v2/...` with the push credential's basic auth. */
  registryHost: string;
  /** Where the PUSH credential's dockerconfigjson is mounted. The push-user holds delete rights; a
   *  reaper mounted with the pull-only credential fails closed on its first DELETE (403). */
  dockerConfigPath: string;
  /** Per-request fetch budget; defaults to 30s (catalog/tags may be larger than a single manifest probe). */
  timeoutMs?: number;
}

/**
 * The concrete RegistryMaintenance (the registry reaper): the OCI distribution catalog + tags +
 * manifest-digest + delete endpoints, over the PUSH credential's basic auth. The auth value is read
 * FRESH per request from the mounted push dockerconfigjson (kubelet refreshes secret-volume files in a
 * running pod). Every method fails CLOSED — an undecidable outcome throws UPSTREAM — so the reaper
 * aborts with nothing deleted rather than acting on a partial read.
 */
export class HttpRegistryMaintenance implements RegistryMaintenance {
  constructor(private readonly cfg: HttpRegistryMaintenanceConfig) {}

  /** One authenticated request. Reads the push auth fresh, composes the timeout+cancel signal, and
   *  NEVER interprets status here (the caller decides which statuses are answers vs failures). An
   *  unreachable registry (fetch throw) becomes UPSTREAM. */
  private async request(method: string, path: string, headers: Record<string, string>, outer: AbortSignal | undefined): Promise<Response> {
    const auth = await readDockerConfigAuth(this.cfg.dockerConfigPath, this.cfg.registryHost, "the mounted registry push dockerconfigjson (the push credential)");
    const { signal, done } = composeAbort(this.cfg.timeoutMs ?? 30_000, outer);
    try {
      return await fetch(`https://${this.cfg.registryHost}${path}`, {
        method,
        headers: { ...headers, authorization: `Basic ${auth}` },
        signal,
        redirect: "manual", // never follow a redirect off the central registry (the credential is a header)
      });
    } catch (e) {
      throw upstream(`${this.cfg.registryHost} is unreachable for ${method} ${path}: ${errMsg(e)}`);
    } finally {
      done();
    }
  }

  async listRepos(opts: { signal?: AbortSignal } = {}): Promise<string[]> {
    const out: string[] = [];
    let path = "/v2/_catalog?n=1000";
    for (let page = 0; page < 100_000; page++) {
      const res = await this.request("GET", path, { accept: "application/json" }, opts.signal);
      const link = res.headers.get("link");
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        throw upstream(`the catalog GET ${path} answered HTTP ${res.status} — the catalog cannot be trusted as complete`);
      }
      let body: { repositories?: unknown };
      try {
        body = (await res.json()) as { repositories?: unknown };
      } catch (e) {
        throw upstream(`the catalog GET ${path} returned unparseable JSON: ${errMsg(e)}`);
      }
      if (!Array.isArray(body.repositories)) throw upstream(`the catalog GET ${path} has no repositories[] array`);
      for (const r of body.repositories) if (typeof r === "string") out.push(r);
      const next = nextLink(link);
      if (!next) break;
      path = next;
    }
    return out;
  }

  async listTags(repo: string, opts: { signal?: AbortSignal } = {}): Promise<string[]> {
    const out: string[] = [];
    let path = `/v2/${repo}/tags/list?n=1000`;
    for (let page = 0; page < 100_000; page++) {
      const res = await this.request("GET", path, { accept: "application/json" }, opts.signal);
      const link = res.headers.get("link");
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => undefined);
        return out; // no such repo -> no tags (the defined "absent" answer)
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        throw upstream(`the tags GET ${path} answered HTTP ${res.status} — the tag list cannot be trusted as complete`);
      }
      let body: { tags?: unknown };
      try {
        body = (await res.json()) as { tags?: unknown };
      } catch (e) {
        throw upstream(`the tags GET ${path} returned unparseable JSON: ${errMsg(e)}`);
      }
      if (body.tags === null || body.tags === undefined) {
        // a null tag list is a valid "no tags on this page" answer — not an error
      } else if (Array.isArray(body.tags)) {
        for (const tg of body.tags) if (typeof tg === "string") out.push(tg);
      } else {
        throw upstream(`the tags GET ${path} returned a non-array tags field`);
      }
      const next = nextLink(link);
      if (!next) break;
      path = next;
    }
    return out;
  }

  async resolveDigest(repo: string, tag: string, opts: { signal?: AbortSignal } = {}): Promise<ManifestDigest> {
    const res = await this.request("HEAD", `/v2/${repo}/manifests/${tag}`, { accept: MANIFEST_ACCEPT }, opts.signal);
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) {
      // 404 included ON PURPOSE: we resolve a tag we just listed, so its absence here is a race, not a
      // normal answer — fail closed rather than treat an unknown digest as "nothing to guard".
      throw upstream(`the manifest HEAD for ${repo}:${tag} answered HTTP ${res.status} — the digest cannot be resolved`);
    }
    const digest = res.headers.get("docker-content-digest");
    if (!digest) throw upstream(`the manifest HEAD for ${repo}:${tag} returned no Docker-Content-Digest header — the digest cannot be resolved`);
    return digest;
  }

  async deleteManifest(repo: string, digest: ManifestDigest, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const res = await this.request("DELETE", `/v2/${repo}/manifests/${digest}`, {}, opts.signal);
    await res.arrayBuffer().catch(() => undefined);
    // 202 Accepted is the spec success; 200 tolerated; 404 = already gone (idempotent).
    if (res.status === 202 || res.status === 200 || res.status === 404) return;
    throw upstream(`the manifest DELETE for ${repo}@${digest} answered HTTP ${res.status} — the deletion outcome is unclear`);
  }
}
