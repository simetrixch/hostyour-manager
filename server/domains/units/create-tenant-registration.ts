// The create-tenant `write-registration` step — the composer of registrations/<guid>/<stage>.yaml.
// Split out of create-tenant.run.ts (like create-tenant-activate.ts) so that file stays under its
// line budget and the ONE place the registration is composed is a single, testable unit.
//
// The inverse is already armed by then (record-provisional registered the shared teardown, whose
// first step git-rm's exactly this file). ONE file per tenant per stage; the gate report is NOT
// written to git (it lives in the run record). Overwrite-idempotent on resume;
// TenantRegistrationSchema.parse re-validates as a belt.
import { and, eq } from "drizzle-orm";
import type { Step } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import { mintTenantGuid } from "../../kernel/ids.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import type { TenantBuildRuntime } from "./tenant-builds.ts";
import { TenantRegistrationSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { errInternal, errValidation } from "../../kernel/errors.ts";
import { resolveUnitQuota } from "#unit/server/unit-size.ts";
import { probeDeploy } from "./tenant-probes.ts";
import { stagePinsOf } from "./tenant-versions.ts";
import { bundleReleaseRefusal, stepLog, throwEngineLineRefusal } from "./engine-line.ts";
import { tenants } from "../../db/schema/inventory.ts";

/** The reset nonce a fresh tenant starts at, in its registration. Nothing acts on a change to it: no
 *  reconciler on this platform reads it, so nothing drops the tenant's databases and restarts its pods
 *  for the boot-seeds to repopulate, and a data reset has no mechanism. The field stays because it is
 *  a mandatory part of the registration schema and whatever answers "what is a data reset" will key
 *  on it. */
const INITIAL_RESET_NONCE = "1";

export function writeRegistrationStep(ports: TenantOnboardPorts, p: CreateTenantParams, runtime: TenantBuildRuntime): Step {
  return {
    name: "write-registration",
    title: "Commit the tenant registration (GitOps deploy)",
    probe: () => probeDeploy(ports, p),
    run: async (ctx) => {
      // The bundle's tag: the one the apps-repo steps read off the release in this pass. A pass
      // resumed after them has none, and a registration naming an image without its tag would hand
      // the engines nothing to mount — refused here, naming the retry, never written.
      const appsImageTag = runtime.appsImageTag;
      if (p.appsImage && !appsImageTag) {
        throw errValidation(`the tag the apps bundle ${p.appsImage} was built at is not in this pass's memory — onboard-build-only reads it off the release; retry from that step, because the registration cannot name an image the engines cannot mount`);
      }
      // The tenant starts on the newest available version of every build, fixed as its own: a later
      // release moves the stage pin and leaves this tenant where it is (#296).
      const approvedTags = await stagePinsOf((chart) => ports.registrations.listPinnedBuilds(p.stage, chart), p.members);
      // The bundle this pass built, judged against every version the tenant starts on (none held before):
      // a build unit of this run may have pinned a version the plan could not judge (engine-line.ts).
      throwEngineLineRefusal(await bundleReleaseRefusal(ports, { appsRepo: p.appsRepo, appsImageTag }, {}, approvedTags, stepLog(ctx)), `tenant ${p.subdomain} cannot start on these versions`);
      const registration: TenantRegistration = TenantRegistrationSchema.parse({
        cluster: p.cluster,
        subdomain: p.subdomain,
        // The tenant's own bundle, or none: the schema defaults the two the tenants ApplicationSet
        // reads bare to the empty string; the repository reaches no chart and stands only where
        // there is one.
        ...(p.appsRepo ? { appsRepo: p.appsRepo } : {}),
        appsImage: p.appsImage,
        appsImageTag,
        // As the approved validation froze them: this copy is the one the CHARTS read, and it must
        // say what the tenant WAS created with, not what the manifest says when it is read back.
        members: p.members, identityProvider: p.identityProvider,
        routing: p.routing,
        apps: p.apps,
        // Resolved HERE, at write time, against the size table as it stands now — see the params
        // field. Per MEMBER: every member namespace of this tenant gets this ceiling.
        quota: resolveUnitQuota(ctx.db, p.size, {
          // A tenant brings no database of its own: its members claim the cluster's shared MongoDB
          // replica set, and no tenant runs a PostgreSQL. So its quota is the base row alone.
          postgresql: false, mongodb: "shared",
        }),
        seedUsers: p.seedUsers,
        ...(p.demo ? { demo: true as const } : {}),
        approvedTags,
        resetNonce: INITIAL_RESET_NONCE,
        suspended: false,
        quiesced: false,
      });
      const { commit } = await ports.registrations.commitTenant({ stage: p.stage, guid: p.guid, registration, runId: ctx.runId });
      ctx.db.update(tenants).set({ approvedTags, updatedAt: new Date() }).where(and(eq(tenants.guid, p.guid), eq(tenants.stage, p.stage))).run();
      ctx.checkpoint({ commit, registration: `registrations/${p.guid}/${p.stage}.yaml` });
      ctx.log("meta", `tenant registration committed to the deploy repository (${commit}) — the ArgoCD on ${p.cluster} will now generate + sync the fan-out`);
    },
  };
}

const GUID_MINT_ATTEMPTS = 8; // CSPRNG guid space is 32^12; a live collision is astronomically unlikely

/** Mint a guid the registrations tree does not already hold at this stage. The 32^12 CSPRNG space makes
 *  a first-try free guid overwhelmingly likely; exhausting the bounded retry is INTERNAL (never reuse). */
export async function mintFreeGuid(ports: TenantOnboardPorts, stage: Stage): Promise<string> {
  for (let i = 0; i < GUID_MINT_ATTEMPTS; i++) {
    const candidate = mintTenantGuid();
    // The question is only "does a registrations/<candidate>/<stage>.yaml stand", so this reads through
    // the TOLERANT scan and treats ABSENT as the one answer that means the guid is FREE. The strict
    // readTenant THROWS on a body it cannot parse — failing an entire create-tenant plan over a
    // candidate it should simply have discarded — while its null covers only an absent file.
    // "unreadable" means the guid IS taken (a file stands at that path), so the loop moves on and the
    // guid is never handed out twice.
    if ((await ports.registrations.scanTenant(stage, candidate)).status === "absent") return candidate;
  }
  throw errInternal(`could not mint a free tenant guid after ${GUID_MINT_ATTEMPTS} attempts`);
}
