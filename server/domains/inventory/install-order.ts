// THE ORDER AN INSTALLATION'S PROGRAMS RUN IN, as the platform repo's trunk states it, and the one
// thing in this repository that reads it.
//
// The declaration lives on the trunk beside the version pins and states, per role, the ordered list
// of deployment programs an installation runs. It states no slave sequence: half of a slave's steps
// are this manager's own acts — placing the engine, moving a checkout onto the branch just cut,
// minting and spending a join credential — and a list of only the program rows would describe a shape
// nobody can follow. So the run kind keeps its steps, and what is read here is the ORDER of the
// programs the two have in common.
//
// WHY READING IT AT ALL IS THE POINT. A declaration nothing consumes looks exactly like one that is
// obeyed. Its own header says nobody reads it, and three of its sentences were false for days before
// a person happened to notice. A reader is what makes a row's being wrong VISIBLE — and this one is
// deliberately a reader and not a driver: a run that composed its steps out of a file on a remote
// trunk would fail to plan when that trunk is unreachable, which is a worse failure than the one it
// would prevent.
//
// Boundary: domain layer — shared/ and the git PlatformRepo port only, like ansiwise-pin beside it.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The file the order lives in, on the platform repo. A LITERAL of that repository's tree, which is
 *  why its test seeds a literal of its own rather than this constant — a fixture that seeds what the
 *  reader reads agrees with the reader whatever the platform repository holds. */
export const INSTALL_ORDER_PATH = "clusters/platform/install-order.yaml";

/** The branch it is read off — the trunk every install branch descends from, where a fact that has to
 *  be one fact for every installation stands. */
export const INSTALL_ORDER_BRANCH = PRODUCT_BRANCH;

/** The role whose sequence this reader takes. The declaration states one list per role and carries
 *  only this one today; a role it does not state is an absence this reader reports rather than an
 *  empty list, because an empty order and an unstated order are not the same answer. */
export const INSTALL_ORDER_ROLE = "master";

/** The slice of the declaration this reader takes: the ordered program names of one role. Everything
 *  else in the file — the engine path, the catalogue paths, every `needs` list — is ignored here,
 *  because nothing in this repository acts on it. */
const InstallOrderFile = z.object({
  sequence: z.record(z.string(), z.array(z.object({ program: z.string().min(1) })).min(1)),
});

/** The ordered program names one role's sequence states. Throws a typed error naming the file, the
 *  branch and the role — there is no default, for ansiwise-pin's reason: an order this process
 *  supplied on its own would be a second answer to a question the declaration exists to answer once. */
export async function readInstallOrder(repo: PlatformRepo, role: string = INSTALL_ORDER_ROLE): Promise<string[]> {
  const raw = await repo.withBranch(INSTALL_ORDER_BRANCH, (trunk) => trunk.readFile(INSTALL_ORDER_PATH));
  if (raw === null) throw errNotFound(`${INSTALL_ORDER_PATH} on the platform repo's ${INSTALL_ORDER_BRANCH} branch`);
  const parsed = InstallOrderFile.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw errValidation(
      `${INSTALL_ORDER_PATH} on ${INSTALL_ORDER_BRANCH} carries no readable sequence of programs — ` +
      "that file states the order an installation's programs run in, and a sequence nothing can read states nothing",
    );
  }
  const stated = parsed.data.sequence[role];
  if (stated === undefined) {
    throw errValidation(
      `${INSTALL_ORDER_PATH} on ${INSTALL_ORDER_BRANCH} states no sequence for the role "${role}" — it states: ` +
      `${Object.keys(parsed.data.sequence).join(", ") || "(no role at all)"}`,
    );
  }
  return stated.map((row) => row.program);
}

/** What holding a run's programs against the declaration answered. `held` names the programs both
 *  sides carry, in the order the run runs them; `unstated` names the ones the run runs that the
 *  declaration does not mention, so a clean answer can never mean nobody was looking. */
export interface OrderVerdict {
  agrees: boolean;
  held: string[];
  unstated: string[];
  /** Set when they disagree: which program the run runs out of the stated order, and after what. */
  detail: string | null;
}

/**
 * Do the programs a run drives, in the order it drives them, follow the order the declaration states?
 *
 * The run may drive FEWER programs than the declaration lists — a slave runs three of the master's
 * five — so the question is whether the shared programs are a SUBSEQUENCE of the stated order, not
 * whether the two lists are equal. A program the run drives that the declaration does not state is
 * neither agreement nor disagreement: the declaration says outright that it states no slave sequence,
 * so a program belonging to a run kind of its own — `tailnet-disconnect`, `tailnet-reconnect` — is
 * expected to be unstated. It is NAMED rather than counted, because a verdict that hid it would let
 * the whole set drift out of the declaration and still read green.
 */
export function holdsInstallOrder(runPrograms: readonly string[], stated: readonly string[]): OrderVerdict {
  const held: string[] = [];
  const unstated: string[] = [];
  for (const program of runPrograms) {
    if (stated.includes(program)) held.push(program);
    else unstated.push(program);
  }
  let at = -1;
  for (const [i, program] of held.entries()) {
    const position = stated.indexOf(program);
    if (position <= at) {
      return {
        agrees: false,
        held,
        unstated,
        detail:
          `this run drives ${program} after ${held[i - 1] ?? "(nothing)"}, but ${INSTALL_ORDER_PATH} states ` +
          `${stated.join(" -> ")} — one of the two has been changed without the other`,
      };
    }
    at = position;
  }
  return { agrees: true, held, unstated, detail: null };
}
