// The tenant app-type CATALOG — the dynamic source of truth for the
// create-tenant wizard's app picker. A tenant's per-app stack is named after an "app-type": the
// per-app ApplicationSet layers charts/example-engine/values-<app>.yaml AFTER values.yaml +
// values-<stage>.yaml, so a VALID app name is exactly one for which such an overlay EXISTS in
// catalog. Free-text app names that have no overlay fail the T4 "apps resolved" gate at plan
// time; discovering the catalog from the repo (never a hardcoded list) lets the wizard only ever offer
// names T4 will accept.
//
// Boundary: a domain module (same layer + the SAME catalog RepoReader as validate-tenant.ts). It
// depends only on the git RepoReader PORT + shared/tenant.ts (the reserved-name law) — never an adapter
// impl and never node IO (the clone/list/dispose is the port's job). The name filtering
// (parseAppCatalog) is a PURE function unit-tested against a fixture list; listTenantAppCatalog is the
// port orchestration; makeAppCatalogProvider adds the cheap in-memory TTL cache + fail-soft the HTTP
// read route relies on so the wizard never blank-screens on a catalog hiccup.
import type { RepoReader } from "../../adapters/git/port.ts";
import { appName } from "../../../shared/tenant.ts";
import { parse as parseYaml } from "yaml";
import { ConsumerManifestSchema } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";

// The chart directory whose values-<app>.yaml overlays name the app types is NOT a constant here.
// It is `perApp.engine.chart` of the tenant product's own manifest (TenantSpecSchema), passed in by
// the caller that already read it. A literal `charts/example-engine` stood here — the cloud base
// naming a chart of one product in order to list the app types of every product it hosts.

/** values-<name>.yaml file-name shape; the capture group is the candidate app-type. The bare
 *  values.yaml (no `-<name>` suffix) never matches, so the chart base is excluded for free. */
const VALUES_OVERLAY_RE = /^values-(.+)\.yaml$/;

/** Overlay names that are NOT app-types: the per-stage overlays every chart layers plus the shared
 *  `common` overlay. These are the ONLY names this filter excludes — a name that would collide with a
 *  standing member is not knowable here, see parseAppCatalog. */
export const RESERVED_OVERLAY_NAMES = new Set<string>(["dev", "test", "prod", "common"]);

/** PURE: turn an engine-chart directory listing into the sorted tenant app-type catalog. Keep only
 *  values-<name>.yaml overlays; drop the stage/common overlays; keep only names the appName schema
 *  accepts (a defensive belt against a stray/renamed file); de-dupe + sort for a stable picker order.
 *
 *  It does NOT exclude names that collide with a standing member, and cannot: the catalog is the
 *  PRODUCT's list of app types, while the standing members are a fact about ONE tenant. It used to
 *  drop {auth, jobs, report} here, which is three component names of one product filtered out of every
 *  catalog of every product. The collision is caught where both sides are known — the superRefine on
 *  TenantRegistrationSchema, which holds an app name against that tenant's own members. */
export function parseAppCatalog(entries: string[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const m = VALUES_OVERLAY_RE.exec(entry);
    const name = m?.[1];
    if (name === undefined) continue;
    if (RESERVED_OVERLAY_NAMES.has(name)) continue;
    if (!appName.safeParse(name).success) continue;
    names.add(name);
  }
  return [...names].sort();
}

/** What a single catalog fetch needs: the same catalog pin + read credential validateTenant clones
 *  with. ref is the trunk (CATALOG_CHART_BRANCH — the charts are product, not installation state,
 *  so they never move to the books branch); the catalog is not pin-sensitive — it reflects
 *  the current tip, since it only ever GROWS the set of names the wizard may offer. */
export interface ListAppCatalogDeps {
  repo: RepoReader;
  repoURL: string;
  ref: string;

  credentialId?: string;
  signal?: AbortSignal;
}

/** Clone the tenant product's repo at ref (the SAME RepoReader validateTenant uses), list its engine
 *  chart directory, and parse the overlays into the app-type catalog. THROWS on a clone/read failure — the caller
 *  (makeAppCatalogProvider) turns that into the fail-soft fallback; the throwaway workdir is always
 *  disposed (finally), exactly like validate-tenant.ts. */
export async function listTenantAppCatalog(deps: ListAppCatalogDeps): Promise<string[]> {
  const cloned = await deps.repo.cloneAtRef({
    repoURL: deps.repoURL,
    ref: deps.ref,
    ...(deps.credentialId ? { credentialId: deps.credentialId } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  try {
    // The engine chart path comes from the product's OWN manifest, read from the clone this call
    // already made — `perApp.engine.chart` of TenantSpecSchema. A literal `charts/example-engine` stood
    // here, which is the cloud base naming a chart of one product to list the app types of every
    // product it hosts. The provider is built at boot and holds no spec, so the read happens here.
    const manifestText = await deps.repo.readFile(cloned.workdir, TENANT_MANIFEST_PATH);
    if (manifestText === null) throw errValidation(`${TENANT_MANIFEST_PATH} is absent on the tenant product's repo — the app-type catalog is the values-<app>.yaml overlays of the engine chart it declares`);
    const manifest = ConsumerManifestSchema.parse(parseYaml(manifestText));
    if (!manifest.tenant) throw errValidation(`${TENANT_MANIFEST_PATH} declares no tenant fan-out — there is no engine chart to list app types from`);
    const entries = await deps.repo.listDir(cloned.workdir, manifest.tenant.perApp.engine.chart);
    return parseAppCatalog(entries);
  } finally {
    await deps.repo.dispose(cloned.workdir);
  }
}

/** The route-facing catalog reader: list() returns the catalog, cached in memory with a short TTL so a
 *  wizard load is cheap (the overlays change rarely — a clone-per-load would be wasteful), and FAIL-SOFT.
 *  Any clone/read error logs + serves the prior good cache when there is one, else [] — the create-tenant
 *  wizard degrades to an "app catalog unavailable" note, never a blank screen, and onboarding with no apps
 *  still works. */
export interface AppCatalogProvider {
  list(signal?: AbortSignal): Promise<string[]>;
}

/** Minimal structured-log sink (pino warn-shaped) so this domain module observes a failed fetch without
 *  importing the concrete Logger type. wire-onboarding.ts binds it to logger.warn. */
export type CatalogWarn = (fields: Record<string, unknown>, msg: string) => void;

export interface AppCatalogProviderDeps {
  repo: RepoReader;
  repoURL: string;
  ref: string;
  credentialId?: string;
  warn: CatalogWarn;
  /** Cache freshness window; defaults to 5 min. */
  ttlMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

export function makeAppCatalogProvider(deps: AppCatalogProviderDeps): AppCatalogProvider {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  let cache: { apps: string[]; at: number } | null = null;
  return {
    async list(signal?: AbortSignal): Promise<string[]> {
      const t = now();
      if (cache && t - cache.at < ttlMs) return cache.apps; // fresh — one clone per TTL window, not per load
      try {
        const apps = await listTenantAppCatalog({
          repo: deps.repo,
          repoURL: deps.repoURL,
          ref: deps.ref,
          ...(deps.credentialId ? { credentialId: deps.credentialId } : {}),
          ...(signal ? { signal } : {}),
        });
        cache = { apps, at: t };
        return apps;
      } catch (e) {
        // Fail-soft: serve the last good catalog (STALE) if we ever had one, else []. Re-cache with a
        // fresh timestamp so a persistent catalog outage does NOT re-clone on every wizard load —
        // the staleness/retry cadence is bounded by the same TTL.
        const apps = cache?.apps ?? [];
        cache = { apps, at: t };
        deps.warn(
          { err: e instanceof Error ? e.message : String(e), repoURL: deps.repoURL, ref: deps.ref, servedStale: apps.length > 0 },
          "tenant app-catalog fetch failed — serving fallback",
        );
        return apps;
      }
    },
  };
}
