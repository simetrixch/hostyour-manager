// The release-tag grammar has ONE statement in this process — RELEASE_TAG_RE in shared/release.ts,
// which cluster-marking.ts puts in the schema of a cluster map's `release:` field, so it decides what
// this Controller accepts as a pin. Outside the process there is a MIRROR of it: `global.releaseTagFilter`
// in the platform repo's platform/values-common.yaml. The image-builder Trigger fires on
// `^refs/tags/deploy/<stage>/<filter>$` and the consumer-build release pipeline re-verifies the tag
// against `^<filter>$`, so that literal decides what the build plane accepts.
//
// Nothing derives one from the other — they are two literals in two repositories — and a byte between
// them fails nothing at the moment it is written. It produces a tag one side accepts and the other
// rejects: a release that builds and cannot be pinned, or a pin nothing ever built. This module is
// what makes the two comparable, in the one place both are present: a running Controller with the
// platform repo configured (server/boot/selfchecks.ts).
//
// It takes the SAME route to the platform repo the channel ceiling takes (channel-stages.ts) — the
// PlatformRepo port, the trunk, and the same file — which is why the path and the branch come from
// that reader's two constants rather than from a second pair spelled here: one way to the platform's
// own values, not two that can point at different files.
//
// Boundary: domain layer — shared/ and the git PlatformRepo port only, like channel-stages beside it.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { RELEASE_TAG_RE } from "../../../shared/release.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "./channel-stages.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The slice of platform/values-common.yaml this reader takes. Everything else in the file is ignored. */
const ReleaseTagFilterFile = z.object({
  global: z.object({ releaseTagFilter: z.string().min(1) }).optional(),
});

/** Read the build plane's copy of the grammar off the trunk. A missing or malformed
 *  `global.releaseTagFilter` is a typed error naming the file: "the two agree" and "I could not read
 *  the other side" are different answers, and the second one must never be given as the first. */
export async function readReleaseTagFilter(repo: PlatformRepo): Promise<string> {
  const raw = await repo.withBranch(CHANNEL_STAGES_BRANCH, (trunk) => trunk.readFile(CHANNEL_STAGES_PATH));
  if (raw === null) throw errNotFound(`${CHANNEL_STAGES_PATH} on the platform repo's ${CHANNEL_STAGES_BRANCH} branch`);
  const parsed = ReleaseTagFilterFile.safeParse(parseYaml(raw));
  if (!parsed.success || parsed.data.global?.releaseTagFilter === undefined) {
    throw errValidation(
      `${CHANNEL_STAGES_PATH} carries no readable global.releaseTagFilter — the build plane's copy of the release grammar is missing or malformed`,
    );
  }
  return parsed.data.global.releaseTagFilter;
}

/** Assert the mirror IS the grammar. The file states the INNER pattern, without anchors, so the
 *  Trigger's CEL can compose it into a longer ref match; anchored it must be RELEASE_TAG_RE character
 *  for character. The refusal prints BOTH literals, because the fix is a diff of exactly these two
 *  and an operator who only reads "they differ" has to go and find them. */
export function assertMirrorsReleaseGrammar(filter: string): void {
  const anchored = `^${filter}$`;
  if (anchored === RELEASE_TAG_RE.source) return;
  throw errValidation(
    `the release grammar has drifted — the Controller accepts ${RELEASE_TAG_RE.source} (shared/release.ts RELEASE_TAG_RE), ` +
    `the build plane accepts ${anchored} (${CHANNEL_STAGES_PATH} global.releaseTagFilter, anchored), ` +
    "so there are release tags one side mints and the other refuses",
  );
}
