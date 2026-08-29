import { errValidation } from "../../../kernel/errors.ts";
import { assertWord, type PlacementMachine } from "./place-ansiwise.ts";
import { CATALOG_CHECKOUT } from "./machine-state.ts";

// BRINGING A MACHINE'S CATALOGUE FORWARD, in the same act that places its engine.
//
// WHAT IS WRONG WITHOUT IT. `deploy-cluster`'s `require_cli_tool_versions` row asserts that the
// engine on a machine matches the pin — and the pin it compares against is the one stamped into the
// CATALOGUE on that machine, while the engine is placed from the pin on the platform repo's trunk.
// The catalogue is refreshed by a `git_clone` row of a program, and a program is itself read out of
// the catalogue, so on the first run after any pin move a machine carries the new engine and the old
// programs and the assertion fails. Measured on apps4.digitacloud.app on 2026-08-27, on every pin
// move that evening: "ansiwise is at 0.5.7-alpha-20260827121634 and the program pins
// 0.5.3-alpha-20260826225248".
//
// IT REFRESHES AND NEVER CLONES, and that is what makes it need no credential of ours. A machine
// that already lives carries the checkout with its own origin and its own read credential, put there
// by the `git_clone` row that made it — so the fetch here authenticates with what the MACHINE holds,
// and this manager composes no credential into anything. A machine that carries no catalogue is left
// exactly as it was and says so: cloning one is a program's row and stays one, because only that row
// knows the origin and the credential by name, and it reads both out of files rather than off a
// command line.
//
// AND IT STANDS ON NO BRANCH OF OUR CHOOSING. The branch is read OFF the machine and the fetch and
// the reset are made onto that same branch, so this brings a machine's catalogue to the head of the
// branch its own installation put it on and can never move it to another one. Which branch that is
// belongs to the installation and is not a value this repository holds.
//
// UNELEVATED, and that is the ownership rule doing the work rather than a convenience. The catalogue
// belongs to the account this manager reaches the machine as (machine-state.ts), so git accepts the
// tree as its own. Raised, git would refuse it as a foreign checkout and everything the fetch wrote
// would come back root-owned — the loop that produced four repairs in one night.
//
// SIX COMMANDS AND NO SHELL, which is the law of the module this borrows its machine from
// (place-ansiwise.ts): every word is held against that module's guard before it is sent, so a branch
// name a shell would read as syntax is REFUSED rather than quoted. The reading is `test -d`, whose
// whole answer is its exit code, and the four git commands each state their directory with `-C`
// rather than being placed in one by a `cd`.

/** What the machine's catalogue was brought from and to. `branch` absent is a machine that carries
 *  no catalogue at all — the one outcome that is neither a change nor a fault. */
/** WHERE A CATALOGUE COMES FROM WHEN A MACHINE HAS NONE, and what opens it.
 *
 *  THE CREDENTIAL STAYS WITH THIS MANAGER AND IS NEVER LEFT ON THE MACHINE. It rides in for the one
 *  command that needs it and the two files carrying it are removed in the same act, so a slave holds
 *  no token of ours afterwards — the one this manager has is write-capable on the catalogue
 *  (kernel/config.ts, CATALOG_WRITE_PAT), and a write credential on every machine of an installation
 *  is a widening nobody asked for. The price is that a machine cannot bring its own catalogue
 *  forward, which is the same thing said the other way round: bringing it forward is this manager's
 *  act, and it can perform it whenever it is asked to. */
export interface CatalogueOrigin {
  /** The repository, as an address git can clone. */
  repoURL: string;
  /** A credential that may read it. */
  token: string;
  /** The account the checkout is to belong to — /srv is root's, so it is made FOR that account. */
  account: string;
  /** What raises the one command that makes a directory under /srv. */
  elevationPassword: string;
}

export interface CatalogueVerdict {
  branch?: string;
  from?: string;
  to?: string;
}

/** One command's wall clock. A fetch of one repository over the machine's own network, the same
 *  budget the platform tree's refresh is given (live-cluster.kit.ts). */
const COMMAND_TIMEOUT_MS = 2 * 60_000;

/** Where the credential lives for as long as one clone takes. Under /tmp and not in the checkout,
 *  because what is written into the checkout stays there and this must not. */
const ASKPASS = "/tmp/.manager-catalogue-askpass";
const TOKEN_FILE = "/tmp/.manager-catalogue-token";

/** git asks this for a username and a password, one at a time, and it answers from the file beside
 *  it. The token is never an argument of a command, so it stands in no process list. */
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  "case \"$1\" in",
  "  Username*) printf 'x-access-token' ;;",
  `  *) cat ${TOKEN_FILE} ;;`,
  "esac",
  "",
].join("\n");

/** The words that put this manager's credential in front of ONE git command, or nothing at all where
 *  the caller holds none — a machine whose own checkout carries a credential needs neither. */
function reading(origin: CatalogueOrigin | undefined): string[] {
  return origin === undefined ? [] : ["env", `GIT_ASKPASS=${ASKPASS}`, "GIT_TERMINAL_PROMPT=0"];
}

/** How long one clone of the catalogue may take. A fetch is a delta and the clone is the whole tree,
 *  so it is given more than the commands around it. */
const CLONE_TIMEOUT_MS = 5 * 60_000;

/** Makes the checkout a machine has none of, for the account that will read it.
 *
 *  TWO ACTS AND NOT ONE. /srv belongs to root, so the directory is MADE elevated and handed to the
 *  operating account; the clone itself then runs as that account, which is what leaves a tree git
 *  accepts as its own afterwards. It is the same one act ansiwise-git's git_clone performs for a
 *  checkout under /srv, and for the same reason. */
async function cloneCatalogue(machine: PlacementMachine, origin: CatalogueOrigin): Promise<void> {
  const elevated = Buffer.from(`${origin.elevationPassword}
`, "utf8");
  const made = await machine.run(
    ["sudo", "-S", "install", "-d", "-m", "755", "-o", origin.account, "-g", origin.account, CATALOG_CHECKOUT],
    { timeoutMs: COMMAND_TIMEOUT_MS, stdin: elevated },
  );
  if (made.code !== 0) {
    throw errValidation(
      `${machine.name} could not be given ${CATALOG_CHECKOUT} for ${origin.account} (exit ${made.code}) — /srv belongs ` +
      "to root, so the directory is made elevated and handed over before anything is cloned into it. Read what the " +
      "command wrote in the run log; the elevation password this run carries is what raises it",
    );
  }

  const cloned = await machine.run(
    [...reading(origin), "git", "clone", "--quiet", origin.repoURL, CATALOG_CHECKOUT],
    { timeoutMs: CLONE_TIMEOUT_MS },
  );
  if (cloned.code !== 0) {
    throw errValidation(
      `${machine.name} could not clone the catalogue from ${origin.repoURL} into ${CATALOG_CHECKOUT} (exit ` +
      `${cloned.code}) — every program this run drives is read out of that checkout. Read what git wrote in the run ` +
      "log: a credential that does not open that repository, and a machine with no route to it, are the two it says",
    );
  }
  machine.log(`${machine.name}: cloned the catalogue into ${CATALOG_CHECKOUT} from ${origin.repoURL}`);
}

/** The directory git is pointed at, and the `.git` inside it — the thing git itself decides by, which
 *  is why the reading asks for that and not for the directory beside it. */
const CATALOG_GIT = `${CATALOG_CHECKOUT}/.git`;

/** Brings the machine's catalogue to the head of the branch it stands on, or reports that the
 *  machine carries none.
 *
 *  Every failure is NAMED rather than left inside an exit code: what the caller has to know is which
 *  of the four machines it is looking at — one with no catalogue, one on a detached HEAD, one whose
 *  origin its own credential no longer opens, and one whose tree belongs to root. */
export async function refreshCatalogue(machine: PlacementMachine, origin?: CatalogueOrigin): Promise<CatalogueVerdict> {
  if (origin !== undefined) {
    await machine.putFile(ASKPASS, Buffer.from(ASKPASS_SCRIPT, "utf8"), 0o700);
    await machine.putFile(TOKEN_FILE, Buffer.from(origin.token, "utf8"), 0o600);
  }
  try {
    return await broughtForward(machine, origin);
  } finally {
    // BOTH FILES GO, on every path out. A token left under /tmp is a token on a machine, and this
    // one is write-capable on the catalogue.
    if (origin !== undefined) await machine.run(["rm", "-f", ASKPASS, TOKEN_FILE], { timeoutMs: COMMAND_TIMEOUT_MS });
  }
}

/** The act itself, with the credential already standing where git will ask for it. */
async function broughtForward(machine: PlacementMachine, origin: CatalogueOrigin | undefined): Promise<CatalogueVerdict> {
  const present = await machine.run(["test", "-d", CATALOG_GIT], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (present.code !== 0) {
    if (origin === undefined) {
      machine.log(
        `${machine.name} carries no catalogue at ${CATALOG_CHECKOUT} and this manager holds no address to clone one ` +
        "from — set CATALOG_REPO and CATALOG_WRITE_PAT, which is the pair it clones the catalogue with everywhere " +
        "else, and this step makes the checkout every program of this run is read out of",
      );
      return {};
    }
    await cloneCatalogue(machine, origin);
  }

  const stood = await machine.run(["git", "-C", CATALOG_CHECKOUT, "symbolic-ref", "--short", "HEAD"], { timeoutMs: COMMAND_TIMEOUT_MS });
  const branch = stood.stdout.trim();
  if (stood.code !== 0 || branch.length === 0) {
    throw errValidation(
      `${CATALOG_CHECKOUT} on ${machine.name} stands on no branch — git answers a detached HEAD there (exit ` +
      `${stood.code}), and a checkout that names no branch has no head to be brought to. Stand it on the branch this ` +
      "installation's catalogue is read from, then run this again",
    );
  }
  // The branch came off the MACHINE, so it is held against the same guard every other word is: a
  // name with a space or a shell character in it is refused here rather than escaped into a command.
  assertWord(branch, `branch ${CATALOG_CHECKOUT} stands on`);

  const before = await machine.run(["git", "-C", CATALOG_CHECKOUT, "rev-parse", "--short", "HEAD"], { timeoutMs: COMMAND_TIMEOUT_MS });
  const fetched = await machine.run([...reading(origin), "git", "-C", CATALOG_CHECKOUT, "fetch", "origin", branch], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (fetched.code !== 0) {
    throw errValidation(
      `${machine.name} could not fetch ${branch} into ${CATALOG_CHECKOUT} (exit ${fetched.code}) — the programs this run ` +
      "drives are read out of that checkout, and the version it stamps is what the cluster program asserts the placed " +
      "engine against. The fetch authenticates with the credential the machine's own checkout carries, so read what git " +
      "wrote in the run log: an origin that credential no longer opens, and a tree that belongs to root rather than to " +
      `${machine.name}'s operating account, are the two it says out loud`,
    );
  }
  const moved = await machine.run(["git", "-C", CATALOG_CHECKOUT, "reset", "--hard", `origin/${branch}`], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (moved.code !== 0) {
    throw errValidation(
      `${machine.name} fetched ${branch} and would not stand ${CATALOG_CHECKOUT} on it (exit ${moved.code}) — the machine ` +
      "now holds the new programs and still reads the old ones. Read what git wrote in the run log",
    );
  }
  const after = await machine.run(["git", "-C", CATALOG_CHECKOUT, "rev-parse", "--short", "HEAD"], { timeoutMs: COMMAND_TIMEOUT_MS });

  const from = before.stdout.trim();
  const to = after.stdout.trim();
  machine.log(
    from === to
      ? `${machine.name}: ${CATALOG_CHECKOUT} already stood on the head of ${branch} at ${to} — nothing to bring forward`
      : `${machine.name}: ${CATALOG_CHECKOUT} brought forward on ${branch}, ${from}..${to} — the engine and the programs that judge it stand on one act`,
  );
  return { branch, from, to };
}
