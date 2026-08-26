// THE ONE ONBOARDING THAT DOES NOT GO THROUGH THE GATE, and the reason it is a whole file of its
// own rather than a condition inside the planner.
//
// The product owner's decision: the Manager dispatches gate runs and nobody else; onboarding a
// consumer or a tenant goes through the gate; the FIRST INSTALLATION IN THE MASTER ROLE does not.
// The platform's own unit is onboarded by the last of the programs a first master runs, at a moment
// when there is no gate to run it through and no operator in front of a browser.
//
// A BRANCH THAT SKIPS THE GATE IS THE ONE BRANCH IN THIS SYSTEM WORTH BEING PARANOID ABOUT, so the
// admission is written as a list of conditions that must ALL hold, each one checkable, and the
// refusal names the first that did not. What it must never admit is a customer's unit, and the
// conditions are chosen against exactly that.
//
// WHY THE SHAPE ALONE IS NOT ENOUGH, measured in this file's own tests. The build-only form — "of a
// cluster and a stage, exactly one may be given, and a build-only unit is the one that names the
// stage" — is reachable from the wizard: OnboardRequest accepts `stage` from any caller
// (onboard.run.ts refineFormChoice), and any consumer whose manifest declares no chart onboards
// build-only. So a discriminator that were only the shape would let EVERY build-only consumer
// onboard ungated, which is the hole this file exists not to have. The shape stays as one condition
// among four; it carries none of the weight on its own.
//
// The unit's IDENTITY is what carries the weight, and it comes from the deployment
// (config.ts PLATFORM_UNIT_NAME) rather than from the request: a name a caller could put in the
// request is a name any caller can put in the request. Absent ⇒ no unit is ever exempt, which is
// the safe direction and the state of every Manager that does not install first masters.
import { parse as parseYaml } from "yaml";
import { ConsumerManifestSchema, CONSUMER_MANIFEST_PATH } from "../../../shared/consumer.ts";
import type { UngatedOnboard } from "../../../shared/gates.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { Plan } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { ReleaseChannel } from "../../../shared/release.ts";
import { DEFAULT_BRANCH_HEAD } from "./onboard-check.ts";
import type { OnboardParams } from "./onboard.run.ts";

/** The version stamped into every record this file writes. A plain string in the record (see
 *  UngatedOnboardSchema), bumped when what the record MEANS changes. */
const UNGATED_VERSION = "1";

/** What the admission is decided on. Every field is a fact the Manager holds or reads; none of it
 *  is anything the request asserts about itself except the name, which is compared against the
 *  deployment's value rather than trusted. */
export interface FirstMasterAdmission {
  /** config.platformUnitName — the deployment's name for the platform's own unit. Absent ⇒ closed. */
  platformUnitName: string | undefined;
  /** The unit being onboarded, as the request names it. */
  consumerName: string;
  /** True for the build-only form (no target cluster; the request names a stage). */
  buildOnly: boolean;
  /** Every unit name the books branch carries a registration for. Empty ⇒ nothing has ever been
   *  onboarded on this installation. */
  registeredUnits: readonly string[];
  /** The FQDN of the master cluster this Manager resolved for itself. Absent ⇒ there is no master
   *  row, and the build-only form has no target at all. */
  masterDomain: string | undefined;
}

/** Admitted, with every condition that admitted it — or refused, naming the first that did not. */
export type FirstMasterVerdict =
  | { admitted: true; admittedBy: string[] }
  | { admitted: false; refusedBecause: string };

/**
 * May THIS onboarding skip the gate? Pure, so the conditions can be tried one at a time from a test
 * that comes at the branch the way an attacker would — from the ordinary route.
 *
 * The four conditions, and what each one shuts out:
 *  1. The unit IS the platform's own, by the deployment's name for it. Shuts out every customer unit.
 *  2. The form is build-only. Shuts out anything that deploys, which is everything a gate renders.
 *  3. NOTHING has ever been onboarded on this installation. Shuts out the branch forever, on every
 *     platform that has run once — including a re-onboarding of the platform's own unit, which goes
 *     through the gate like everything else. This is the "FIRST installation" half, and it is the
 *     condition that cannot be got back once it is spent.
 *  4. A master cluster exists for this Manager to be about. The "in the MASTER role" half.
 */
export function admitFirstMasterUngated(input: FirstMasterAdmission): FirstMasterVerdict {
  if (input.platformUnitName === undefined) {
    return { admitted: false, refusedBecause: "this Manager names no platform unit (PLATFORM_UNIT_NAME is unset), so no onboarding may skip the gate" };
  }
  if (input.consumerName !== input.platformUnitName) {
    return { admitted: false, refusedBecause: `"${input.consumerName}" is not this platform's own unit ("${input.platformUnitName}")` };
  }
  if (!input.buildOnly) {
    return { admitted: false, refusedBecause: `"${input.consumerName}" is being onboarded to a target cluster — only the build-only form of the platform's own unit is exempt` };
  }
  if (input.registeredUnits.length > 0) {
    return {
      admitted: false,
      refusedBecause:
        `this installation already carries ${input.registeredUnits.length} registration(s) (${input.registeredUnits.join(", ")}), ` +
        "so this is not the first installation and the gate applies",
    };
  }
  if (input.masterDomain === undefined) {
    return { admitted: false, refusedBecause: "no cluster in the master role is registered, so there is no first master to install" };
  }
  return {
    admitted: true,
    admittedBy: [
      `the unit is this platform's own (PLATFORM_UNIT_NAME = "${input.platformUnitName}")`,
      "the form is build-only — nothing of this unit deploys",
      "no unit is registered on this installation yet, so this is its first installation",
      `the cluster in the master role is ${input.masterDomain}`,
    ],
  };
}

/**
 * What the ungated path reads instead of a gate report: the repo at its default-branch head, and
 * the manifest's own build names.
 *
 * The clone happens either way — it is the Manager's own act and the gate's repo-access proof rests
 * on it — so what is skipped here is the sandbox and nothing else. The manifest is parsed with
 * ConsumerManifestSchema, the SAME schema the sandbox's structure gate parses it with, off the SAME
 * path (shared/consumer.ts CONSUMER_MANIFEST_PATH): a second manifest reader with a second idea of
 * the contract is the mechanism this platform refuses to grow, so there is one schema and one path
 * and only the place of the read differs.
 *
 * IT REFUSES A MANIFEST THAT DECLARES A CHART. Such a manifest is a deployable unit, and a
 * deployable unit is not what the exemption is for — the gate is what renders a chart, so a chart
 * that reached here would be a chart nothing ever rendered.
 */
export async function readUngatedOnboard(
  deps: { repo: RepoReader; log: (line: string) => void; signal: AbortSignal },
  req: { repoURL: string; ref: string; consumerName: string; repoCredentialId?: string },
  about: { cluster: string; admittedBy: string[] },
): Promise<UngatedOnboard> {
  const cloned = await deps.repo.cloneAtRef({
    repoURL: req.repoURL,
    ref: req.ref,
    ...(req.repoCredentialId ? { credentialId: req.repoCredentialId } : {}),
    signal: deps.signal,
  });
  try {
    deps.log(`cloned ${req.repoURL} @ ${req.ref} -> ${cloned.resolvedSha}`);
    const raw = await deps.repo.readFile(cloned.workdir, CONSUMER_MANIFEST_PATH);
    if (raw === null) {
      throw errValidation(`${req.repoURL} carries no ${CONSUMER_MANIFEST_PATH} at ${req.ref} — the manifest is the entry point of the contract, and without it there is nothing to register`);
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw errValidation(`${CONSUMER_MANIFEST_PATH} in ${req.repoURL} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
    const manifest = ConsumerManifestSchema.safeParse(parsed);
    if (!manifest.success) {
      throw errValidation(`${CONSUMER_MANIFEST_PATH} in ${req.repoURL} is not a valid consumer manifest: ${manifest.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    if (manifest.data.name !== req.consumerName) {
      throw errValidation(`${CONSUMER_MANIFEST_PATH} declares name "${manifest.data.name}" but the onboarding names "${req.consumerName}" — a unit's name is its identity and the two must be the same word`);
    }
    if (manifest.data.chart !== undefined) {
      throw errValidation(`${CONSUMER_MANIFEST_PATH} declares a chart, so "${req.consumerName}" is a deployable unit — the ungated first-master path onboards a build-only unit, and nothing here renders a chart`);
    }
    const builds = manifest.data.builds.map((b) => b.name);
    if (builds.length === 0) {
      throw errValidation(`${CONSUMER_MANIFEST_PATH} declares no builds, so there is nothing for the release cycle to build and nothing to attest`);
    }
    return {
      ungatedVersion: UNGATED_VERSION,
      unit: req.consumerName,
      cluster: about.cluster,
      resolvedSha: cloned.resolvedSha,
      builds,
      admittedBy: about.admittedBy,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    await deps.repo.dispose(cloned.workdir);
  }
}

/**
 * THE UNGATED PLAN, whole: what an admitted first-master onboarding becomes. It stands here rather
 * than in the run file so the one branch that skips the gate is read in one place — the conditions
 * that admit it, the record it leaves and the plan it produces, all in the file whose name says
 * what it is.
 *
 * `steps` is passed in rather than imported: the steps a consumer onboard is composed of belong to
 * the run definition, and this function has no business knowing them. It also keeps the import
 * acyclic, since the run file imports this one.
 */
export async function planUngatedFirstMaster(
  deps: { repo: RepoReader; log: (line: string) => void; signal: AbortSignal; registrationBranch: string },
  req: { consumerName: string; repoURL: string; repoCredentialId: string; owner: string; version: string; channel: ReleaseChannel; stage: Stage },
  master: { clusterId: string; domain: string; admittedBy: string[] },
  steps: (params: OnboardParams) => { name: string; title: string }[],
): Promise<{ outcome: "planned"; params: OnboardParams; plan: Plan }> {
  const ungated = await readUngatedOnboard(
    { repo: deps.repo, log: deps.log, signal: deps.signal },
    { repoURL: req.repoURL, ref: DEFAULT_BRANCH_HEAD, consumerName: req.consumerName, repoCredentialId: req.repoCredentialId },
    { cluster: master.domain, admittedBy: master.admittedBy },
  );
  // Said on the run itself, line by line, and not only frozen into the params: the operator watching
  // the plan stream is the person who has to notice that nothing checked this repository.
  for (const reason of ungated.admittedBy) deps.log(`NOT GATED — ${reason}`);
  const params: OnboardParams = {
    form: "build-only",
    consumerName: req.consumerName,
    repoURL: req.repoURL,
    repoCredentialId: req.repoCredentialId,
    owner: req.owner,
    version: req.version,
    channel: req.channel,
    stage: req.stage,
    resolvedSha: ungated.resolvedSha,
    domain: master.domain,
    builds: ungated.builds,
    ungated,
  };
  const stepDefs = steps(params);
  return {
    outcome: "planned",
    params,
    plan: {
      kind: "consumer-onboard",
      targetKind: "cluster",
      targetId: master.clusterId,
      summary:
        `Onboard build-only unit "${req.consumerName}" (version ${req.version}, channel ${req.channel}, release run on ${req.stage}) ` +
        `WITHOUT A GATE RUN: ${stepDefs.length} steps. No gate has judged this repository — ${ungated.admittedBy.join("; ")}.`,
      steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
      targets: [],
      locks: [
        { resource: "git-branch", key: deps.registrationBranch },
        { resource: "master-kube", key: "m" },
      ],
      warnings: [`No gate ran for "${req.consumerName}". Approving registers a unit nothing has checked.`],
      requiredSecrets: [],
    },
  };
}
