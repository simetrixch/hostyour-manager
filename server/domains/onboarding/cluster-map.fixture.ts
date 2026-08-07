// The cluster maps the consumer onboard + teardown tests read a WEBHOOK HOST out of.
// clusters/active/<fqdn>.yaml is the one place `build-plane` stands, and setup-webhook, the offboard
// removal and the purge removal all name their address from it — so a test that pins an address has to
// pin a map rather than a stubbed answer, which is what this fixture is for.
//
// The shape it seeds is the case the platform allows and a single-cluster fixture cannot show: a unit
// deployed on a cluster that BUILDS ELSEWHERE. Every seeded cluster names m1.example in build-plane,
// so a hook of a unit on s1 stands at build.m1.example — never at the cluster the unit runs on.
//
// Each seeded map carries every key install.sh writes UNCONDITIONALLY — unit-apex and
// platform-domain included — so the tests built on this fixture read maps shaped like a real
// installation's, and a schema that refuses that shape fails here instead of on a fresh install.
import type { Stage } from "../../../shared/enums.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import {
  clusterMarkingPath, buildPlaneFqdnFromMarkings, type BuildPlaneFqdnResolver,
} from "../inventory/cluster-marking.ts";

/** The cluster every seeded map names as its build plane. */
const BUILD_PLANE = "m1.example";

/** The address that follows from BUILD_PLANE with the standard "build" subdomain — what a hook created
 *  from these maps stands at, and what a removal must ask GitHub to delete. */
export const BUILD_HOOK_URL = `https://build.${BUILD_PLANE}/github`;

/** Seed one map per named cluster onto `repo` and return a resolver bound to it. `stages` gives each
 *  cluster the ONE stage it carries. The cluster that IS the plane is marked master and names no master
 *  of its own; every other one is a slave managed by it, which is what install.sh writes. */
export function seedClusterMaps(repo: FakePlatformRepo, stages: Record<string, Stage>, plane: string = BUILD_PLANE): BuildPlaneFqdnResolver {
  for (const [fqdn, stage] of Object.entries(stages)) {
    const own = fqdn === plane;
    // platform-domain defaults to the unit apex in install.sh, so the fixture states the default.
    const map = `fqdn: "${fqdn}"\nstage: "${stage}"\nrole: "${own ? "master" : "slave"}"\nbuild-plane: "${plane}"\n${own ? "" : `master: "${plane}"\n`}unit-apex: "example.com"\nplatform-domain: "example.com"\n`;
    repo.seed(repo.booksBranch, clusterMarkingPath(fqdn), map);
  }
  return buildPlaneFqdnFromMarkings(repo);
}
