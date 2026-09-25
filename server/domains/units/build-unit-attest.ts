// A REGISTERED build unit's builds, attested again before its release is re-run.
//
// The release pipeline takes the builds it may release from the build Application's render of
// registrations/<unit>/build.yaml, and refuses a build the unit's manifest declares and that render
// does not attest. A unit that renamed or added a build since its onboarding would therefore release
// nothing: its build.yaml is written again as the manifest declares the builds now, and the release is
// triggered only once the build Application has rendered exactly that list. The Application stands
// Synced at its old render already, so its sync alone proves nothing; what its last comparison
// rendered does.
import { errUpstream, errValidation } from "../../kernel/errors.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { MASTER_ARGO_NAMESPACE } from "../inventory/cluster-kube.ts";
import { unitBuildNamespace } from "./build-rbac.ts";
import { syncedAt, describeUnsynced } from "./tenant-watch.ts";
import type { OnboardPorts } from "./onboard.run.ts";

const sorted = (builds: readonly string[]): string => [...builds].sort().join(",");

/** The build list the build Application's last comparison rendered (unit.buildsJson), or null. */
export function renderedBuilds(status: ArgoAppStatus | undefined): string[] | null {
  for (const src of status?.syncSources ?? []) {
    const unit = src.valuesObject?.["unit"] as { buildsJson?: unknown } | undefined;
    if (typeof unit?.buildsJson !== "string") continue;
    try {
      const builds: unknown = JSON.parse(unit.buildsJson);
      if (Array.isArray(builds) && builds.every((b) => typeof b === "string")) return builds as string[];
    } catch {
      return null;
    }
  }
  return null;
}

/** Attest `builds` for the registered unit where its build.yaml attests others, keeping every other
 *  field of the standing registration, and wait until the build Application renders them. Nothing is
 *  written, and nothing is waited for, where the attested set already equals the manifest's. */
export async function attestBuildsAgain(
  ctx: StepCtx,
  ports: OnboardPorts,
  unit: string,
  builds: readonly string[],
): Promise<void> {
  const standing = await ports.registrations.readBuildRegistration(unit);
  if (!standing) throw errValidation(`build unit ${unit} is taken for registered, and its registrations/${unit}/build.yaml does not stand — plan the run again`);
  const attested = standing.entry.builds ?? [];
  if (sorted(attested) === sorted(builds)) return;
  // G16's rule, held here as at onboarding: a build name is one unit's. Two units attesting one name
  // push to one registry repository, and each release would move the other's pins.
  const taken = (await ports.registrations.listAttestedBuildNames(unit)).filter((a) => builds.includes(a.build));
  if (taken.length > 0) throw errValidation(`build unit ${unit} now declares ${taken.map((t) => `${t.build} (attested by ${t.unit})`).join(", ")} — a build name is one unit's; rename the build in ${unit}'s manifest`);
  const { entry } = standing;
  const { commit } = await ports.registrations.commitRegistration({
    unit: {
      name: unit, repoURL: entry.repoURL, ...(entry.owner ? { owner: entry.owner } : {}),
      ...(entry.onboardedAt ? { onboardedAt: entry.onboardedAt } : {}), suspended: entry.suspended, quiesced: entry.quiesced,
    },
    builds: [...builds],
    runId: ctx.runId,
  });
  ctx.log("meta", `${unit}: builds attested again (${commit}) — ${sorted(attested) || "none"} → ${sorted(builds)}, as its manifest declares them now`);
  if (!ports.buildArgo) throw errValidation(`the master ArgoCD reader is not wired — nothing can confirm that the build Application of ${unit} renders the new builds before its release`);
  const app = unitBuildNamespace(unit);
  const rendered = (byName: ArgoAppStatusMap): boolean => syncedAt([app])(byName) && sorted(renderedBuilds(byName.get(app)) ?? []) === sorted(builds);
  const byName = await ports.buildArgo.watchApplicationSet(MASTER_ARGO_NAMESPACE, [app], rendered, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
  if (!rendered(byName)) {
    const seen = renderedBuilds(byName.get(app));
    throw errUpstream(
      `${MASTER_ARGO_NAMESPACE}/${app} has not rendered the builds ${sorted(builds)} within ${Math.round(ports.argoWatchTimeoutMs / 1000)}s ` +
      `(${syncedAt([app])(byName) ? `it renders ${seen ? sorted(seen) : "no build list"}` : describeUnsynced([app], byName)}) — retry this step once it has; the attestation stands`,
    );
  }
  ctx.log("meta", `${app} renders ${sorted(builds)} — the release may build them`);
}
