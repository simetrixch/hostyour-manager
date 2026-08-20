// The version of the `ansiwise` binary a machine is given. There is exactly ONE pin and it does not
// live here — it is `cliTools.ansiwise.version` in the platform repo's platform/versions.yaml, the
// file that states what every component of this platform is pinned at and where each pin is
// written. This module is a READER of that file and nothing else, for the same reason the channel
// table beside it is read rather than copied: a second statement of a version is a place for two
// answers to the question "which ansiwise does this installation run".
//
// Read off the TRUNK, and that is a decision rather than a leftover. The binary is what RUNS the
// deployment programs, so it is placed before there is anything installation-specific to read it
// from — a machine at its first installation carries no install branch and no checkout at all.
//
// Boundary: domain layer — shared/ and the git PlatformRepo port only, like cluster-marking and
// channel-stages beside it.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The file the pin lives in, on the platform repo. */
export const ANSIWISE_PIN_PATH = "platform/versions.yaml";

/** The branch the pin is read off — the trunk every install branch descends from. */
export const ANSIWISE_PIN_BRANCH = PRODUCT_BRANCH;

/** The key that carries it, spelled as the file spells it — quoted in refusals so an operator reads
 *  the entry to write off the message instead of going to look for it. */
export const ANSIWISE_PIN_KEY = "cliTools.ansiwise.version";

/** The slice of platform/versions.yaml this reader takes. Everything else in the file — every other
 *  component, every stamp site, every upstream — is ignored. */
const VersionsFile = z.object({
  cliTools: z.object({ ansiwise: z.object({ version: z.string().min(1) }) }),
});

/** The pinned version, or a typed error naming the file, the branch and the key. There is no
 *  default: a placement that fell back to "the newest" or to whatever the caller holds would put a
 *  version on the machine that no file states, and nothing afterwards could say which one ran. */
export async function readAnsiwisePin(repo: PlatformRepo): Promise<string> {
  const raw = await repo.withBranch(ANSIWISE_PIN_BRANCH, (trunk) => trunk.readFile(ANSIWISE_PIN_PATH));
  if (raw === null) throw errNotFound(`${ANSIWISE_PIN_PATH} on the platform repo's ${ANSIWISE_PIN_BRANCH} branch`);
  const parsed = VersionsFile.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw errValidation(
      `${ANSIWISE_PIN_PATH} on ${ANSIWISE_PIN_BRANCH} carries no readable ${ANSIWISE_PIN_KEY} — ` +
      "the binary a machine is given is pinned there, so nothing can be placed until that entry states a version",
    );
  }
  return parsed.data.cliTools.ansiwise.version;
}
