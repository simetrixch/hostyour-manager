// What an ungated build reads instead of a gate report: the repository at its default-branch head
// and its manifest's own build names. The consumer family admits the one onboarding that may skip
// the gate (first-master.ts); the tenant family builds the units its fan-out pulls from this way,
// because the tenant gates judged that fan-out at plan.
import { parse as parseYaml } from "yaml";
import { ConsumerManifestSchema, CONSUMER_MANIFEST_PATH } from "#core/shared/consumer.ts";
import type { UngatedOnboard } from "#core/shared/gates.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import type { RepoReader } from "#core/server/adapters/git/port.ts";

/** The version stamped into every record this file writes. A plain string in the record (see
 *  UngatedOnboardSchema), bumped when what the record MEANS changes. */
const UNGATED_VERSION = "1";

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
