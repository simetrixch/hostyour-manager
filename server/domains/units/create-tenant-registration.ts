// The create-tenant `write-registration` step — the composer of registrations/<guid>/<stage>.yaml.
// Split out of create-tenant.run.ts (like create-tenant-activate.ts) so that file stays under its
// line budget and the ONE place the registration is composed is a single, testable unit.
//
// The inverse is already armed by then (record-provisional registered the shared teardown, whose
// first step git-rm's exactly this file). ONE file per tenant per stage; the gate report is NOT
// written to git (it lives in the run record). Overwrite-idempotent on resume;
// TenantRegistrationSchema.parse re-validates as a belt.
import type { Step } from "../../executor/types.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import type { TenantBuildRuntime } from "./tenant-builds.ts";
import { TenantRegistrationSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { errValidation } from "../../kernel/errors.ts";
import { resolveUnitQuota } from "#unit/server/unit-size.ts";
import { probeCatalog } from "./tenant-probes.ts";

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
    probe: () => probeCatalog(ports, p),
    run: async (ctx) => {
      // The bundle's tag: the one the apps-repo steps read off the release in this pass. A pass
      // resumed after them has none, and a registration naming an image without its tag would hand
      // the engines nothing to mount — refused here, naming the retry, never written.
      const appsImageTag = runtime.appsImageTag;
      if (p.appsImage && !appsImageTag) {
        throw errValidation(`the tag the apps bundle ${p.appsImage} was built at is not in this pass's memory — onboard-build-only reads it off the release; retry from that step, because the registration cannot name an image the engines cannot mount`);
      }
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
        resetNonce: INITIAL_RESET_NONCE,
        suspended: false,
        quiesced: false,
      });
      const { commit } = await ports.registrations.commitTenant({ stage: p.stage, guid: p.guid, registration, runId: ctx.runId });
      ctx.checkpoint({ commit, registration: `registrations/${p.guid}/${p.stage}.yaml` });
      ctx.log("meta", `tenant registration committed to catalog (${commit}) — the ArgoCD on ${p.cluster} will now generate + sync the fan-out`);
    },
  };
}
