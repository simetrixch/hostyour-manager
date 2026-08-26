// The cluster maps the consumer onboard + teardown tests read a WEBHOOK HOST out of.
// clusters/active/<fqdn>.yaml is the one place `global.buildPlane` stands, and setup-webhook, the offboard
// removal and the purge removal all name their address from it — so a test that pins an address has to
// pin a map rather than a stubbed answer, which is what this fixture is for.
//
// The shape it seeds is the case the platform allows and a single-cluster fixture cannot show: a unit
// deployed on a cluster that BUILDS ELSEWHERE. Every seeded cluster names m1.example in global.buildPlane,
// so a hook of a unit on s1 stands at build.m1.example — never at the cluster the unit runs on.
//
// Each seeded map carries every key the branch program writes UNCONDITIONALLY — unitApex and
// platformDomain included — so the tests built on this fixture read maps shaped like a real
// installation's, and a schema that refuses that shape fails here instead of on a fresh install.
import type { Stage } from "../../../shared/enums.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { buildPlaneFqdnFromMarkings, type BuildPlaneFqdnResolver } from "../inventory/cluster-marking.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

/** The cluster every seeded map names as its build plane. */
const BUILD_PLANE = "m1.example";

/** The address that follows from BUILD_PLANE with the standard "build" subdomain — what a hook created
 *  from these maps stands at, and what a removal must ask GitHub to delete. */
export const BUILD_HOOK_URL = `https://build.${BUILD_PLANE}/github`;

/** Seed one map per named cluster onto `repo` and return a resolver bound to it. `stages` gives each
 *  cluster the ONE stage it carries. The cluster that IS the plane is marked master and names no master
 *  of its own; every other one is a slave managed by it, which is what the branch program writes. */
export function seedClusterMaps(repo: FakePlatformRepo, stages: Record<string, Stage>, plane: string = BUILD_PLANE): BuildPlaneFqdnResolver {
  for (const [fqdn, stage] of Object.entries(stages)) {
    const own = fqdn === plane;
    // platformDomain defaults to the unit apex in the branch program, so the fixture states it.
    // TWO BLOCKS, because the file has two readers. The flat top level is what the reconciler
    // generators select on and the schema is strict about; `global` is what the charts read, and
    // is where every address stands. A fixture that writes one flat block is a map no installation
    // produces, and a test built on it proves nothing about the file a fresh install writes.
    const map =
      `stage: "${stage}"` + "\n" +
      `role: "${own ? "master" : "slave"}"` + "\n\n" +
      "global:" + "\n" +
      `  domain: "${fqdn}"` + "\n" +
      `  buildPlane: "${plane}"` + "\n" +
      (own ? "" : `  master: "${plane}"` + "\n") +
      `  unitApex: "example.com"` + "\n" +
      `  platformDomain: "example.com"` + "\n";
    repo.seed(repo.booksBranch, clusterMapPath(fqdn), map);
  }
  return buildPlaneFqdnFromMarkings(repo);
}
