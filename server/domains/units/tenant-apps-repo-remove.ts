import type { Step, StepCtx } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";

// A TENANT'S APPS BUNDLE GOES WITH ITS LAST APP (hostyour-manager#217). The build-only registration
// of the tenant's own apps repository (`<bundle>-<subdomain>`, tenant-apps-tree.ts) stands as long
// as an app of the tenant does: remove-app takes it back when the app it drops was the last one, and
// every tenant removal (offboard, purge, the replace and abort teardowns) takes it back with the
// tenant. Two things go together, because they were written together by tenant-apps-repo: the
// bundle's build-only registration (registrations/<unit>/build.yaml), and — where the tenant stays —
// the bundle's three fields on its registration, so the tenant is its platform alone again and the
// next add-app creates afresh.
//
// THE REPOSITORY ON GITHUB STANDS (#241). No run of this Manager deletes a repository: the App's
// installation owner is the customer's owner, so every repository it reaches is the customer's, and
// the one purge that deleted through the App took three of the customer's base repositories with it.
// The step says the repository stands; the owner deletes it by hand once it is to go. Idempotent on
// a resume: a registration already cleared carries nothing to take back.

export interface TenantAppsRepoTarget {
  stage: Stage;
  guid: string;
}

/** Removes the tenant's apps build registration and (where `clear`) the bundle fields of its
 *  registration. `clear` is for a tenant that STAYS (remove-app); a removal whose next step git-rms
 *  the registration has nothing to clear. */
export async function removeTenantAppsRegistration(ctx: StepCtx, ports: TenantLifecyclePorts, t: TenantAppsRepoTarget, opts: { clear: boolean }): Promise<void> {
  const current = await ports.registrations.readTenant(t.stage, t.guid);
  if (!current?.entry.appsRepo) {
    ctx.log("meta", `tenant ${t.guid} records no apps repository — nothing to take back`);
    return;
  }
  const { appsRepo, appsImage } = current.entry;
  ctx.log("meta", `repository ${appsRepo} stands — this Manager deletes no repository (#241); it is the owner's to delete by hand once it is to go`);
  if (ports.buildRegistrations) {
    const { removed } = await ports.buildRegistrations.removeBuildRegistration(appsImage, ctx.runId);
    ctx.log("meta", removed ? `build registration of ${appsImage} removed` : `build registration of ${appsImage} already absent`);
  } else {
    ctx.log("meta", `no build registrations are wired on this manager — registrations/${appsImage}/build.yaml stays`);
  }
  if (opts.clear) {
    const { commit } = await ports.registrations.clearTenantAppsRepo(t.stage, t.guid, ctx.runId);
    ctx.log("meta", `tenant ${t.guid} is its platform alone again — the bundle cleared from its registration (${commit}); the next add-app creates a repository afresh`);
  }
}

/** The step a tenant removal composes ahead of the pointer's removal: the target is frozen. */
export function removeTenantAppsRegistrationStep(ports: TenantLifecyclePorts, name: string, t: TenantAppsRepoTarget): Step {
  return {
    name,
    title: `Remove the tenant's apps build registration; the repository stands`,
    run: (ctx) => removeTenantAppsRegistration(ctx, ports, t, { clear: false }),
  };
}
