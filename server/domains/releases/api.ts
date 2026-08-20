// The RELEASE surface — which version an installation stands on, and which version each of its
// platform apps runs. The platform could raise a version and could not show one anywhere; this is
// where that question is answered.
//
// An INSTALLATION is a registered cluster. Its FQDN is its install branch (clusters.domain), and
// that branch carries both halves of the answer:
//
//   the CLUSTER's release — the `release` key of clusters/active/<fqdn>.yaml on the books branch,
//   written by the release run's set-pin step and by nothing else. The install branch is regenerated
//   from exactly that tag, so the pin and the branch state are one statement.
//
//   the APPS' versions — the `builds[]` pins of apps/<app>/values-<stage>.yaml ON THAT BRANCH, at
//   the cluster's OWN stage. An install branch stands on the release the cluster actually runs,
//   which can be older than the trunk, so the trunk's pins would answer a different question.
//
// NOTHING HERE ENUMERATES ANYTHING ITSELF. The app pins arrive from the ONE pin search whose result
// is also the registry reaper's protected floor (searchPlatformApps, domains/registry-cleanup), bound
// at the composition root and handed in as a function — so what this surface reports and what
// retention refuses to delete come from one walk of one set of branches.
//
// DEGRADE LOUD, per half. A cluster's release and an installation's app pins fail independently: the
// maps may read while the search cannot run, and either failure names itself rather than shrinking
// into an empty list. `apps: null` is the same rule one level down — the branch was never read, which
// is not "the branch pins nothing".
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import type { AppReleaseView, InstallationReleaseView, ReleasesView } from "../../../shared/api-types.ts";
import type { GlobSearch } from "../../../shared/pin.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import { clusterReleaseRead, readClusterReleases } from "../inventory/cluster-marking.ts";

export interface ReleasesApiDeps {
  db: Db;
  /** The repo the cluster maps stand in. Absent ⇒ not configured; every release reads "unknown" with
   *  that as its reason, and the rows are still answered from the database. */
  platformRepo?: PlatformRepo;
  /** The platform-app class of THE pin search, bound to this installation's hostyour-cloud
   *  (boot/wire.ts). A function rather than the repo, so this domain keeps its distance from both the
   *  git port and the domain that owns the search. Absent ⇒ the same not-configured answer. */
  readPlatformAppPins?: () => Promise<GlobSearch>;
}

/** The clusters this installation knows, with the server each one runs on — one row per installation.
 *  Sorted master first and then by name, the same order listServers projects in, so the Releases panel
 *  and the Servers page put the same machine in the same place. */
function installationRows(db: Db) {
  return db
    .select({
      serverId: servers.id,
      name: servers.name,
      role: servers.role,
      branch: clusters.domain,
      stage: clusters.stage,
    })
    .from(clusters)
    .innerJoin(servers, eq(clusters.serverId, servers.id))
    .all()
    .sort((a, b) => Number(isMasterRole(b.role)) - Number(isMasterRole(a.role)) || a.name.localeCompare(b.name));
}

/** The pins of ONE branch at ONE stage, as the surface states them. Keyed "<branch>\0<stage>" so a
 *  cluster's row is one lookup and a stage's pins never leak into a neighbouring stage's row. */
function pinsByBranchStage(search: GlobSearch): Map<string, AppReleaseView[]> {
  const byKey = new Map<string, AppReleaseView[]>();
  for (const hit of search.hits) {
    // The platform-app class reads only the per-stage files, so every hit of it names a stage; the
    // stage-less pin file belongs to the tenant catalog, which this surface does not read.
    if (hit.stage === null) continue;
    const key = `${hit.branch}\0${hit.stage}`;
    const app: AppReleaseView = { app: hit.chart, build: hit.pin.name, image: hit.pin.image, tag: hit.pin.tag };
    byKey.set(key, [...(byKey.get(key) ?? []), app]);
  }
  for (const apps of byKey.values()) apps.sort((a, b) => a.app.localeCompare(b.app) || a.build.localeCompare(b.build));
  return byKey;
}

export async function buildReleasesView(deps: ReleasesApiDeps): Promise<ReleasesView> {
  const releases = await readClusterReleases(deps.platformRepo);
  // The rows and their release pins are answered whatever the app search does — those come from the
  // database and the cluster maps, and half an answer beats none.
  const rows = installationRows(deps.db).map((r) => ({ ...r, release: clusterReleaseRead(r.branch, releases) }));
  const unsearched = (envelope: Pick<ReleasesView, "error" | "reason">): ReleasesView => ({
    ...envelope,
    installations: rows.map((r): InstallationReleaseView => ({ ...r, apps: null })),
  });

  if (!deps.readPlatformAppPins) return unsearched({ reason: "onboarding-not-configured" });
  let search: GlobSearch;
  try {
    search = await deps.readPlatformAppPins();
  } catch (e) {
    return unsearched({ error: e instanceof Error ? e.message : String(e) });
  }
  const read = new Set(search.branches);
  const byKey = pinsByBranchStage(search);
  return {
    installations: rows.map(
      (r): InstallationReleaseView => ({
        ...r,
        apps: read.has(r.branch) ? byKey.get(`${r.branch}\0${r.stage}`) ?? [] : null,
      }),
    ),
  };
}

/** GET-only, behind the protected chokepoint like every other read. */
export function registerReleaseRoutes(app: Hono<AppEnv>, deps: ReleasesApiDeps): void {
  app.get("/api/releases", async (c) => c.json(await buildReleasesView(deps)));
}
