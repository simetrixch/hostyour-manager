// The channel ceiling: which stages a release channel may reach. There is exactly ONE table and it
// does not live here — it is `global.channelStages` in the platform repo's clusters/platform/values-common.yaml,
// enforced in the release pipeline at the point that writes a pin. This module is a READER of that
// file and nothing else, which is what makes two things true at once: a table change reaches the
// manager without a manager release, and every caller in this process answers the same question
// the same way. A second table in manager code would be a copy, and a copy is the defect.
//
// Read off the TRUNK, and that is a decision rather than a leftover: the channel policy is the
// platform's, not any installation's, so it is product and lives where the product lives. Every
// install branch carries a copy of the same file, but reading it there would make the ceiling depend
// on which cluster is asked and on how old that cluster's pin is. This is the one branch reference in
// the Manager that stays on the trunk while the books moved off it.
//
// Boundary: domain layer — shared/ and the git PlatformRepo port only, like cluster-marking beside it.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { RELEASE_CHANNEL, type ReleaseChannel } from "../../../shared/release.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { PLATFORM_VALUES_COMMON } from "../../../shared/cluster-values.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The file the one table lives in, on the platform repo. The SAME constant the values chain names
 *  as its first layer (shared/cluster-values.ts), so a rename of that path cannot move the chain and
 *  leave this reader pointing at a file the repository stopped having — which is exactly what it
 *  did. */
export const CHANNEL_STAGES_PATH = PLATFORM_VALUES_COMMON;

/** The branch the table is read off — the trunk every install branch descends from. */
export const CHANNEL_STAGES_BRANCH = PRODUCT_BRANCH;

/** The table itself: channel -> the stages that channel may reach. Partial, because the file states
 *  the channels it states — a channel missing from it reaches nothing, which is the safe direction. */
export type ChannelStages = Partial<Record<ReleaseChannel, Stage[]>>;

/** The slice of that file this reader takes. Everything else in it is ignored. */
const ChannelStagesFile = z.object({
  global: z.object({ channelStages: z.record(z.enum(RELEASE_CHANNEL), z.array(z.enum(STAGE))) }).optional(),
});

/** Read the one table. A missing or malformed `global.channelStages` is a typed error naming the file:
 *  a ceiling nobody can read must stop the caller, never default to something permissive. */
export async function readChannelStages(repo: PlatformRepo): Promise<ChannelStages> {
  const raw = await repo.withBranch(CHANNEL_STAGES_BRANCH, (trunk) => trunk.readFile(CHANNEL_STAGES_PATH));
  if (raw === null) throw errNotFound(`${CHANNEL_STAGES_PATH} on the platform repo's ${CHANNEL_STAGES_BRANCH} branch`);
  const parsed = ChannelStagesFile.safeParse(parseYaml(raw));
  if (!parsed.success || parsed.data.global?.channelStages === undefined) {
    throw errValidation(`${CHANNEL_STAGES_PATH} carries no readable global.channelStages — the channel table is missing or malformed`);
  }
  return parsed.data.global.channelStages;
}

/** May a release on `channel` reach a cluster marked `stage`? Throws naming the channel, the stage and
 *  the stages that channel DOES reach, so the operator reads the rule off the refusal rather than
 *  having to look the table up. `what` names the thing being refused (the tag, the unit) in the message. */
export function assertChannelReaches(table: ChannelStages, channel: ReleaseChannel, stage: Stage, what: string): void {
  const allowed = table[channel] ?? [];
  if (allowed.includes(stage)) return;
  throw errValidation(
    `${what} is on the ${channel} channel, which reaches ${allowed.length > 0 ? allowed.join(", ") : "no stage"} — ` +
    `the target is marked ${stage}, so this release may not go there (${CHANNEL_STAGES_PATH} global.channelStages)`,
  );
}
