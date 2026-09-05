// WHO OWNS WHAT THIS PLATFORM LEAVES ON A MACHINE. One sentence, decided by the product owner on
// 2026-08-27, and every writer in this repository follows it:
//
//   Everything this platform puts on a machine belongs to the account the manager reaches it as —
//   the checkouts under /srv, the catalogue, /var/lib/ansiwise, and anything added later. Root may
//   still write everything and loses nothing.
//
// WHY IT IS A SENTENCE AND NOT FOUR FIXES. The installation programs run raised, so everything they
// create belongs to root, while the manager reaches a machine over SSH as the operating account.
// Nothing ever decided that those two should be the same, and every place they met was a refusal:
// git refused a checkout it does not own, a clone could not be made in a directory it may not write,
// and a machine run died before its first step because it could not create its own record directory.
// Four of them were repaired one at a time and each repair only uncovered the next, which is what a
// missing rule looks like from underneath. What closes the class is not a fifth repair but a stated
// owner, so a place nobody has looked at yet is right before anybody looks at it.
//
// WHAT THE RULE COSTS, and it was stated and accepted when the rule was: every place that creates
// something as root needs a handover. The one thing it does NOT cost is a capability — root goes on
// writing all of it, and a machine's own raised runs keep recording where they always did.
//
// WHAT STANDS IN [MACHINE_STATE] is what this platform CREATES on a machine and LEAVES there. Three
// kinds of path are deliberately outside it, named one by one rather than counted, because an
// omission nobody can see reads as a rule that covers everything:
//
//   A FILE IN A DIRECTORY THE MACHINE ALREADY HAS, whose owner the program that READS it decides and
//   not we: the sudoers drop-in a machine may carry (defs/manager-key.kit.ts SUDOERS_DROP_IN, which
//   `remove-sudoers` deletes) and the sshd drop-in the password-login run kinds write
//   (defs/password-login.kit.ts DROP_IN). sudo and sshd
//   each refuse a file they do not own, so those two belong to root by the rule of the daemon that
//   reads them, and handing either to the operating account would take the file out of service.
//
//   THE TWO EXECUTABLES ON THE MACHINE'S PATH (defs/place-ansiwise.ts PATH_HOME). They are placed
//   with elevation into a directory the machine already has, and they are what a raised run EXECUTES
//   — an executable writable by the account the manager reaches the machine as would make the
//   elevation password decide nothing. Whether the stated sentence is meant to reach them is a
//   question for the product owner and not one this file may answer by acting.
//
//   A FILE CREATED AND REMOVED INSIDE ONE RUN: the uploaded script (executor/stepkit.ts), the emitted
//   cluster credentials and the minted tailnet key. Each is written over SFTP or by a program as the
//   operating account and taken away again in the same run, so it belongs to that account by
//   construction and it is not state.
//
// EVERY PATH BELOW IS THE MACHINE'S OWN and none of it is this repository's to choose: each one is
// named on a row of a program in the installation's catalogue, or is where a binary's own default
// puts it. What this module does is state them ONCE, so the manager, the scripts it uploads and the
// check that holds the rule read one list instead of four.

/** The directories of a machine's own filesystem under which this platform makes its state. Named as
 *  a NEIGHBOURHOOD and not as a list of the paths in it: the check that holds this rule
 *  (machine-state.test.ts) refuses a literal anywhere under one of these that did not come from this
 *  module, so a place nobody has made yet is caught by the same rule as the ones that exist. */
export const PLATFORM_STATE_ROOTS = ["/srv/", "/var/lib/"] as const;

/** WHERE the deployment programs read and write the platform tree — the MATERIAL. The programs
 *  (hostyour-deploy ansiwise/programs/) name this path on every `repository:` row, so the tree
 *  deploy-host's `git_clone` row stands on a branch and the tree they act on are one path stated
 *  once. */
export const PLATFORM_CHECKOUT = "/srv/hostyour-cloud";


/** WHERE the catalogue stands on the machine: the checkout the serving binary reads its programs and
 *  its `ansiwise.yaml` from. The machine's own path and not this module's invention — the
 *  `git_clone` row of `deploy-platform-services`, the LAST deployment program, brings the catalogue
 *  forward at exactly this path, and the resident service is given `--programs` out of it. A machine
 *  that carries none is given one before any program runs at all, by `refreshCatalogue`
 *  (defs/machine-catalogue.ts) or, on a first master, by hostyour-cloud's own installer. */
export const CATALOG_CHECKOUT = "/srv/ansiwise-catalog";

/** The program files inside that checkout — what `--programs` has to name, because the option's own
 *  default (`programs`, beside the working directory) is not where a catalogue keeps them. */
export const CATALOG_PROGRAMS = `${CATALOG_CHECKOUT}/ansiwise/programs`;

/** The file naming which plugins the installation turns on, inside the same checkout. It has to be
 *  named because the option's default is `ansiwise.yaml` RELATIVE to the directory the process runs
 *  in, and nothing here runs in the catalogue: see THE WORKING DIRECTORY IS NOT THE CATALOGUE at
 *  defs/place-ansiwise.ts `installServiceArgv`. */
export const CATALOG_CONFIG = `${CATALOG_CHECKOUT}/ansiwise.yaml`;

/** Where the engine keeps every run's record on a machine, and the directory above it.
 *
 *  ansiwise-core's `RunDirectory.defaultRoot` names the second, and its recorder creates the run's
 *  own directory RECURSIVELY when a run begins (file_recorder.dart:41) — so both come into being on
 *  a machine's first elevated run, belonging to root, and no program declares them. */
export const ANSIWISE_STATE_ROOT = "/var/lib/ansiwise";

/** See [ANSIWISE_STATE_ROOT]. */
export const ANSIWISE_RUN_ROOT = `${ANSIWISE_STATE_ROOT}/runs`;

/** The file the resident service reads its token out of, and the file install-service writes it to.
 *  The machine's own: the `file_from_vault` row of the program that mints it writes this path out of
 *  the entry at `<stage>/manager-host/ansiwise`. */
export const SERVICE_TOKEN_FILE = "/etc/ansiwise/service-token";

/** WHERE AN INSTALLATION'S HAND-FILLED INPUT STANDS ON A MACHINE, per stage.
 *
 *  On the cluster that keeps the books it is written by that cluster's own branch program and stays
 *  — this manager never writes it there. On a cluster that keeps none it is PLACED for the length of
 *  one deployment and taken away again (deploy-slave.input.ts), because two rows of the machine's
 *  own programs read a value out of it and the file cannot reach such a machine any other way: it is
 *  gitignored, so no branch carries it.
 *
 *  Inside the platform checkout, so it belongs to the account that owns the checkout and the write
 *  needs nothing raised. It is deliberately absent from MACHINE_STATE below: that list is what this
 *  platform leaves on a machine, and this is the one thing it takes back. */
export function inputFile(stage: string): string {
  return `${PLATFORM_CHECKOUT}/secrets/secrets.${stage}`;
}

/** Which account a path belongs to. `operator` is the account the manager reaches the machine as —
 *  the rule's answer, and the answer for everything this platform creates a place for. `root` is
 *  written out only where a program that READS the path refuses any other owner, and the row says
 *  which program that is. */
export type MachineStateOwner = "operator" | "root";

/** Who makes a path's owner right. `bootstrap` is this manager's own placement step, and it is used
 *  only where the program that would do it cannot run until the path is already right; `elsewhere`
 *  is a row of a program in the installation's catalogue, named in the entry's own sentence. */
export type MachineStateHandover = "bootstrap" | "elsewhere";

export interface MachineStateEntry {
  /** The absolute path on the machine. */
  path: string;
  /** Which account it belongs to. */
  owner: MachineStateOwner;
  /** Who makes that true. */
  handover: MachineStateHandover;
  /** What the path is, and — where the owner is not the rule's answer — why. */
  what: string;
}

/** EVERYTHING THIS PLATFORM CREATES ON A MACHINE AND LEAVES THERE, with the account it belongs to.
 *
 *  The order is the order a machine acquires them, and it is load-bearing for the one caller that
 *  walks it: a parent stands before the directory inside it, so a handover made in this order never
 *  creates a child under a parent it has not corrected yet. */
export const MACHINE_STATE: readonly MachineStateEntry[] = [
  {
    path: ANSIWISE_STATE_ROOT,
    owner: "operator",
    handover: "bootstrap",
    what:
      "the engine's own state root. The first raised run on a machine creates it as root, and every " +
      "run this manager drives is started by the resident service as the operating account",
  },
  {
    path: ANSIWISE_RUN_ROOT,
    owner: "operator",
    handover: "bootstrap",
    what:
      "where every run on the machine writes its record. The first thing a run does is create its " +
      "own directory here, so a machine whose run root belongs to root accepts a run, forks it, and " +
      "the child dies before its first step — which is why the handover cannot wait for a program",
  },
  {
    path: CATALOG_CHECKOUT,
    owner: "operator",
    handover: "elsewhere",
    what:
      "the catalogue the resident service reads its programs and its plugin list out of, brought " +
      "forward by the `git_clone` row of deploy-platform-services and put there in the first place " +
      "by this manager's own refreshCatalogue",
  },
  {
    path: PLATFORM_CHECKOUT,
    owner: "operator",
    handover: "elsewhere",
    what:
      "the platform tree every deployment program acts on, cloned by a `git_clone` row that hands it " +
      "over after the clone rather than before — git recreates as root everything it is made to " +
      "write into a directory handed over first",
  },
  {
    path: SERVICE_TOKEN_FILE,
    owner: "root",
    handover: "elsewhere",
    what:
      "the token the resident service authenticates callers with, written by a program's " +
      "`file_from_vault` row. ROOT, because the service reads it as root and the value is a " +
      "standing credential for the machine's whole program surface — an account that could read it " +
      "could drive every program on the machine without the elevation password",
  },
];

/** The entries this manager's own bootstrap has to make right, in the order above.
 *
 *  DERIVED AND NOT WRITTEN OUT, so the handover and the rule cannot disagree: a place added to the
 *  list above with `handover: "bootstrap"` is handed over by the same loop that hands over the two
 *  standing there today, and nobody has to remember a second list. */
export const MANAGER_HANDS_OVER: readonly MachineStateEntry[] =
  MACHINE_STATE.filter((e) => e.handover === "bootstrap");
