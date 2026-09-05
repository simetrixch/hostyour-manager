import { errValidation } from "../../../kernel/errors.ts";
import { ANSIWISE_RUN_ROOT, MANAGER_HANDS_OVER } from "./machine-state.ts";

// `place-ansiwise` — the BOOTSTRAP, and the whole of what this repository does to a machine with its
// own hands. Everything a machine is afterwards given is given by a PROGRAM: a named row in the
// installation's catalogue, resolved against the registry the binary was compiled with, measured in
// `test`, shown in `dry` and only then run. This module exists because that apparatus needs an
// executable to exist before it can measure anything at all, and a machine at its first installation
// carries none.
//
// WHY THERE IS NO SCRIPT HERE AND WHY THERE MAY NEVER BE ONE AGAIN. The rebuild that produced
// ansiwise exists because 580 raw mutation sites in bash could never be proven inert in a dry run —
// a check written in bash is the same defect in the tool meant to catch defects
// (simetrix-docs/ansiwise-plugins/CLAUDE.md). The first version of this module composed a bash
// script and shipped it to a machine: it installed packages, downloaded and installed a binary,
// cloned two repositories and wrote a systemd unit, and not one of those mutations could be proven
// inert. What replaced it is two protocol operations and two invocations of a binary that judges
// itself:
//
//   THE TRANSFER   `putFile` writes each executable's bytes and sets its mode — SFTP, a file
//                  transfer and a mode change, with no shell on the machine involved at any point
//                  (adapters/ssh/port.ts `putFile`). The bytes come from the release address the
//                  installation states; the manager fetches them and hands them over, so the machine
//                  needs no `curl`, no `ca-certificates` and no network of its own to be bootstrapped.
//   THE READING    `<executable> --version` — one word, no arguments of ours in it, and it mutates
//                  nothing. Both binaries answer their release tag on one line
//                  (ansiwise-cli lib/installation.dart `answeredVersion`, simetrixch/ansiwise-cli#7),
//                  which is what makes the placed version READABLE without a naming convention this
//                  module would have to invent and then be the only reader of.
//
// BOTH EXECUTABLES, AND THEY ARE PLACED TOGETHER OR NOT AT ALL. `ansiwise-rest` refuses to start
// when `ansiwise` is not standing beside it and exits 78 saying so (ansiwise-cli bin/ansiwise_rest.dart
// `deploymentToolBesideThis`): the serving binary starts every run as a DETACHED CHILD of the
// deployment tool, so a machine given one of the two answers for programs and runs none of them.
// The previous version of this module placed one, which is why they are one list here and one loop.
//
// WHERE THEY GO, AND WHY IT IS THE OPERATING ACCOUNT'S OWN HOME. `/usr/local/bin` belongs to root,
// the operating account cannot write it, and `sudo` on these machines wants a password — so a
// transfer into it would need elevation, and SFTP has none to offer. Raising the transfer to root
// would mean a command, and a command that moves a file into place is the mutation site this module
// exists to remove. The home directory is the one place the account the session authenticated as can
// write by itself, so the bytes land there under their own two names, beside each other, which is
// exactly what `deploymentToolBesideThis` looks for. What stands in `/usr/local/bin` afterwards is
// `install_pinned_tool`'s to place and to keep at the pin — one row per binary, in the tool phase
// where every other tool of this platform is held (hostyour-deploy ansiwise/programs/deploy-cluster.yaml).
//
// WHAT THIS MODULE NO LONGER DOES, AND WHERE EACH OF THEM WENT. Read this before adding anything
// back:
//
//   the PACKAGES   `deploy-host`'s `install_packages` row installs git, openssl, curl, jq and
//                  apache2-utils. The bootstrap needs none of them now: the manager fetches the
//                  bytes and SFTP carries them.
//   the CHECKOUTS  `/srv/ansiwise-catalog` is `git_clone`'s (hostyour-deploy
//                  ansiwise/programs/), and where a machine carries none the placement step makes
//                  it itself (machine-catalogue.ts) — a clone with nothing standing in front of it,
//                  because the deployment programs are a public repository.
//
//                  `/srv/hostyour-cloud` is `deploy-host`'s own `git_clone` row. That row takes the
//                  repository from an ANSWER this manager states (deploy-slave.kit.ts
//                  `platformOrigin`), because the tree is made before any settings file it could be
//                  read out of exists, and it takes no credential either — the platform repository
//                  is served to anybody as well.
//
//                  WHAT THIS MODULE MAY NOT DO IS CARRY A CREDENTIAL TO A CLONE. A credential can
//                  reach a single command only through that command's argument list or its
//                  environment — the first stands in the machine's process listing for anyone on it
//                  to read, and the second needs a shell to set. `git_clone` reads its origin and
//                  its credential out of files by NAME, so neither value passes through a caller: a
//                  checkout that needs one belongs on such a row and never on a step here.
//
// WHAT THE MANAGER STILL HAS TO STATE, and it is two values and no shell: WHERE a released
// executable is fetched from (ANSIWISE_DOWNLOAD_URL, carrying both slots below) and WHICH version
// (clusters/platform/versions.yaml's pin, inventory/ansiwise-pin.ts). Never what the caller happens to hold.

/** The deployment tool: the binary that runs a program, and the one every run is a detached child
 *  of. Named as a constant because three places say it — the transfer, the reading, and the
 *  refusal that names what a machine is short of. */
export const ANSIWISE_TOOL = "ansiwise";

/** The serving binary: the surface over a session's own pipes. It is a BINARY OF ITS OWN and not a
 *  program of the tool above: asking THAT one for `serve` answers "no program is called serve", which
 *  is the whole reason both names stand here. */
export const ANSIWISE_REST_TOOL = "ansiwise-rest";

/** THE ONE PROGRAM THE SERVING BINARY HAS, and this manager composes no invocation of any other.
 *
 *  It speaks over the pipes of a session sshd has already authenticated, which is the one way this
 *  manager reaches a machine (ansiwise-cli `bin/ansiwise_rest.dart` `sessionProgram`). The binary
 *  answers every other word with `ansiwise-rest has no program called "<word>"` and exits 64, so a
 *  manager that invokes one is a run that fails on the machine, three systems away from the change
 *  that caused it. simetrixch/ansiwise-cli#14 deleted the second and third programs; the scripted
 *  machine (deploy-slave.placement.fixture.ts) refuses every word but this one, so a manager that
 *  grows a second invocation is caught here instead of there. */
export const ANSIWISE_SESSION_PROGRAM = "serve";

/** The two, in the order a refusal names them. A machine carries both or it carries nothing worth
 *  having: see BOTH EXECUTABLES in the header. */
export const ANSIWISE_EXECUTABLES = [ANSIWISE_TOOL, ANSIWISE_REST_TOOL] as const;

/** What the download address writes where the pinned version belongs. One placeholder and one
 *  source: the address says WHERE a release is fetched from, the pin says WHICH — so the two can
 *  never state different versions. */
export const VERSION_PLACEHOLDER = "<version>";

/** What the download address writes where the executable's own name belongs. A release carries TWO
 *  assets and they are told apart by nothing but this: an address that named one of them could
 *  fetch `ansiwise-rest` only by being configured twice, and an installation with two addresses has
 *  a way to point them at two different releases. */
export const NAME_PLACEHOLDER = "<name>";

/** The mode a transferred executable is given: `0755`, a file every account on the machine may run
 *  and only its owner may write. SFTP sets it in the same call that writes the bytes, so there is no
 *  window in which the file stands there unrunnable. */
export const EXECUTABLE_MODE = 0o755;

/** What stands in front of an executable's name when it is NAMED IN A COMMAND rather than written.
 *  The transfer states a RELATIVE path, which SFTP resolves from the account's own home directory —
 *  so nothing here has to know where that home is. A command is read by the machine's shell, which
 *  resolves this the same way for the same account. */
export const BOOTSTRAP_HOME = "~/";

/** WHERE THE MACHINE FINDS THEM, which is not where the transfer can land them.
 *
 *  SFTP authenticates as the operating account and has no elevation to offer, so the bytes can only
 *  arrive under [BOOTSTRAP_HOME]. But everything that later ASKS about the engine asks the one on the
 *  path: `deploy-cluster`'s `require_cli_tool_versions` row reads it there, and so does every command
 *  a person types on the machine. Until this module put them here as well, nothing wrote this
 *  directory at all — deploy-cluster states in its own tool phase that the engine is asserted there
 *  and fetched nowhere, on the belief that some other mechanism placed it — and what stood on a
 *  machine was whatever its first installation had left, at whatever version that was. Measured on
 *  apps4: the path carried 0.5.4 while the pin said 0.5.7, and the assertion failed the run.
 *
 *  The home copies stay, and they are not a second writer of this path: they are where the transfer
 *  lands and what `deploymentToolBesideThis` looks beside. Both pairs are written from the same bytes
 *  in the same act and are read back separately, so a machine can never be reported at a version only
 *  one of them answers. */
export const PATH_HOME = "/usr/local/bin/";

/** One line break, named because it is written into a command's standard input and into the split of
 *  what a command answered — two places a literal would be easy to lose. */
const NEWLINE = "\n";

/** Leaves the machine state this manager's own bootstrap is answerable for belonging to the account
 *  this manager reaches the machine as.
 *
 *  THE RULE IS NOT HERE, and that is the point: defs/machine-state.ts states in one sentence which
 *  account owns what this platform leaves on a machine, and [MANAGER_HANDS_OVER] is the slice of it
 *  this step has to make right. A place added there is handed over by this loop without this
 *  function being touched, which is what keeps the rule from becoming a list somebody has to copy.
 *
 *  WHY THE MANAGER DOES THIS AND NOT A PROGRAM. A program's `hand_directory_to_account` row names
 *  exactly these directories and is what keeps them right afterwards. It cannot be what makes them
 *  right the first time: the manager drives every program through `ansiwise-rest`, which runs as the
 *  operator, and the FIRST thing a run does is write its own record — so a machine whose run root
 *  belongs to root accepts the run, forks it, and the child dies before its first step. The program
 *  that would repair it is the program that cannot start. Measured on apps4: "machine run … was
 *  accepted but never wrote its record — it started and died before its first step".
 *
 *  So this is the bootstrap half, and it belongs beside the placement for the same reason the
 *  placement does: both are what make a machine able to be SPOKEN to at all, and neither is
 *  something the machine can do for itself.
 *
 *  THE MODE IS UNTOUCHED. Only the owner moves. Root goes on writing whatever it likes — a machine's
 *  own `sudo ansiwise` runs keep recording into the same root, and their records stay theirs.
 *
 *  IT READS FIRST, so a machine already right is reported as such rather than acted on again. */
export async function handRunRoot(
  machine: PlacementMachine,
  req: { account: string; elevationPassword: string },
): Promise<{ handed: boolean }> {
  assertWord(req.account, "account a machine's engine state is handed to");
  const paths = MANAGER_HANDS_OVER.map((e) => e.path);
  const named = paths.join(" and ");
  const owners = await machine.run(["stat", "-c", "%U", ...paths], { timeoutMs: COMMAND_TIMEOUT_MS });
  const read = owners.stdout.split(NEWLINE).map((l) => l.trim()).filter((l) => l.length > 0);
  if (read.length === paths.length && read.every((owner) => owner === req.account)) {
    machine.log(`${machine.name}: ${named} already belong to ${req.account} — nothing to hand over`);
    return { handed: false };
  }
  const stdin = Buffer.from(req.elevationPassword + NEWLINE, "utf8");
  // TWO COMMANDS PER PLACE AND NOT ONE COMPOSED LINE, because each `sudo -S` reads the password
  // itself and a value that would have to be quoted is refused by this module rather than escaped —
  // so there is no one shell to put them in. `install -d` makes what is missing; the `chown` corrects
  // what was already standing, which on every machine this platform has installed is all of them.
  // The registry's order is what makes this safe to run straight through: a parent stands before the
  // directory inside it, so nothing is created under a parent that has not been corrected yet.
  const argvs = MANAGER_HANDS_OVER.flatMap((e) => [
    ["sudo", "-S", "install", "-d", "-m", "755", "-o", req.account, "-g", req.account, e.path],
    ["sudo", "-S", "chown", `${req.account}:${req.account}`, e.path],
  ]);
  for (const argv of argvs) {
    const done = await machine.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS, stdin });
    if (done.code !== 0) {
      throw errValidation(
        `${machine.name} would not hand ${argv.at(-1)} to ${req.account} (exit ${done.code}) — every run this manager ` +
        `drives writes its record under ${ANSIWISE_RUN_ROOT}, and an account that cannot write there accepts a run and ` +
        "dies before its first step. Read what the command wrote in the run log; the elevation password this run " +
        "carries is what raises it",
      );
    }
  }
  machine.log(`${machine.name}: ${named} now belong to ${req.account}`);
  return { handed: true };
}

/** One command's wall clock. Every command this module runs is either a question or one act of the
 *  binary's own — none of them is a package install or a clone any more, which is why the ten
 *  minutes the composed script used to need are gone with it. The long act of a bootstrap is now the
 *  TRANSFER, and its clock is the session's (adapters/ssh/port.ts). */
const COMMAND_TIMEOUT_MS = 2 * 60_000;

/** WHAT MAY STAND IN A COMMAND'S ARGUMENT LIST, and the guard is the reason this module can say it
 *  composes no shell. Every word reaching the machine is held against this before it is sent: no
 *  whitespace, and none of the characters a shell reads as syntax — `; & | $ \` ( ) < > * ? [ ] { }
 *  ' " \ # ! ~` except a leading `~`, which is what BOOTSTRAP_HOME is. A value that cannot be
 *  written as one plain word is REFUSED rather than quoted, because a quoter is a shell composer
 *  with a nicer name. */
const WORD_RE = /^~?[A-Za-z0-9@%_+=:,./-]+$/;

/** A slot nothing filled, in the shape a program file writes one — the same grammar
 *  `install_pinned_tool` reads its own url with (ansiwise-host lib/src/steps/host/install_pinned_tool.dart). */
const LEFTOVER_SLOT_RE = /<[a-z][a-z-]*>/;

/** WHERE one released executable is fetched from: the installation's address with both slots filled.
 *
 *  BOTH SLOTS, AND NEITHER IS OPTIONAL. `<version>` is the pin, so the address and the placed binary
 *  can never state two versions; `<name>` is which of the release's two assets, so one address
 *  reaches both and an installation cannot point the two halves of one engine at two releases. An
 *  address that carries neither is refused where it is configured (kernel/config.ts), and what is
 *  left over after both are filled is refused here — a slot nothing fills would be sent as it
 *  stands. */
export function downloadAddress(url: string, name: string, version: string): string {
  return url.split(NAME_PLACEHOLDER).join(name).split(VERSION_PLACEHOLDER).join(version);
}

/** WHERE the release assets are read from, as the bootstrap sees it: one address in, its bytes out.
 *
 *  A seam of its own and not the adapter port itself (adapters/downloads/port.ts), for the reason
 *  PlacementMachine is one: the placement takes a machine and values and holds no run, no signal and
 *  no session. The caller adapts its own port to this in one line, and what that costs is what keeps
 *  this module drivable by a suite that opens no socket. */
export interface ReleaseAssets {
  /** The bytes served at `url`, or a thrown error naming what answered instead. */
  read(url: string): Promise<Buffer>;
}

/** THE MACHINE, as the bootstrap sees it: a name to call it by in what an operator reads, a way to
 *  WRITE a file, a way to run ONE command, and somewhere to put a line. Nothing else — the callers
 *  there are (deploy-slave.ts `runPlacement`) satisfy these four out of a run's cached session, and
 *  these four are the whole of what placing from anywhere else would have to supply.
 *
 *  `run` TAKES AN ARGUMENT LIST AND NOT A LINE, and that is the type doing the work this module's
 *  header claims: a list of words cannot carry a pipeline, a redirection, a `&&` or a here-document,
 *  and every word in it is held against WORD_RE before it is sent. Whoever implements this joins
 *  those words and hands them to the machine; what they may not do is take a string from here,
 *  because there is none to take. */
export interface PlacementMachine {
  /** What the machine is called in a refusal — the name an operator knows it by. */
  name: string;
  /** Write `content` at `remotePath` with `mode`. A RELATIVE path is the account's own home. */
  putFile(remotePath: string, content: Buffer, mode: number): Promise<void>;
  /** Run one command and answer its status and its WHOLE standard output. `stdin` is what the
   *  command reads — it may reach no file and no argument list.
   *
   *  NOTHING THIS RUNS ANSWERS WITH A CREDENTIAL, so every line a machine writes goes into the run's
   *  record. The one command that read one — `sudo cat` of the resident service's token file — went
   *  with the door it authenticated (simetrixch/ansiwise-cli#14), and the option that kept its answer
   *  out of the log went with it: an option nothing sets is a guard nobody is holding. */
  run(argv: readonly string[], o: { timeoutMs: number; stdin?: Buffer }): Promise<CommandOutcome>;
  /** Where a line an operator reads goes. */
  log(line: string): void;
}

/** What one command left behind. */
export interface CommandOutcome {
  code: number;
  stdout: string;
}

/** What the bootstrap needs said, and every one of these is a value: nothing here is a session, a
 *  database row or a run. */
export interface BootstrapRequest {
  /** The version to place — clusters/platform/versions.yaml's pin (inventory/ansiwise-pin.ts), never what the
   *  caller happens to hold. */
  version: string;
  /** WHERE a released executable is fetched from, carrying NAME_PLACEHOLDER and VERSION_PLACEHOLDER.
   *  Filled in here, so the address, the pin and the placed file can never state three things. */
  downloadUrl: string;
  /** What raises the copy into [PATH_HOME] to root. That directory belongs to root and the account
   *  this run authenticated as cannot write it, so without a password the machine keeps whatever
   *  version stood there — which is the state this placement exists to end. */
  elevationPassword: string;
}

/** What the bootstrap answers: the version both executables now answer with, read off the machine,
 *  and whether this run of it had anything to transfer. */
export interface BootstrapVerdict {
  version: string;
  placed: boolean;
}

/** Give the machine both executables at the version the request pins, and transfer neither of them
 *  where the file already standing there answers that version.
 *
 *  MEASURED, PLACED, MEASURED AGAIN, and the verdict is the second reading. A transfer that wrote an
 *  error page would set the mode on it and resolve happily; what says the machine carries the pin is
 *  the machine answering the pin. */
export async function placeAnsiwise(
  machine: PlacementMachine,
  assets: ReleaseAssets,
  req: BootstrapRequest,
): Promise<BootstrapVerdict> {
  const { version } = req;
  assertWord(version, "version");
  // BOTH PLACES ARE READ, and a machine is only left alone when both answer the pin. Reading only
  // the home is what let apps4 be reported as carrying 0.5.7 while every program on it ran 0.5.4:
  // the transfer had nothing to do and the copy onto the path had never been made at all.
  const standing = await readVersions(machine, BOOTSTRAP_HOME);
  const onPath = await readVersions(machine, PATH_HOME);
  const missing = ANSIWISE_EXECUTABLES.filter((name) => standing[name] !== version);
  const stale = ANSIWISE_EXECUTABLES.filter((name) => onPath[name] !== version);
  if (missing.length === 0 && stale.length === 0) {
    machine.log(`${machine.name} already carries ${describeExecutables(version)} — nothing to place`);
    return { version, placed: false };
  }
  if (missing.length > 0) {
    machine.log(
      `placing on ${machine.name}: ${missing.map((name) => `${name} ${version} (it carries ${standing[name] ?? "none"})`).join(", ")}`,
    );
  }

  for (const name of missing) {
    const from = downloadAddress(req.downloadUrl, name, version);
    // ANY slot and not only the two this fills. Nothing else fills one, so an address still carrying
    // `<arch>` or `<os>` would be sent to the release host with the angle brackets in it and whatever
    // came back placed as an executable — which is the reading-off-the-machine case one step later,
    // and a worse sentence than this one.
    const left = LEFTOVER_SLOT_RE.exec(from)?.[0];
    if (left !== undefined) {
      throw errValidation(
        `the download address ${req.downloadUrl} still carries ${left} once ${NAME_PLACEHOLDER} and ` +
        `${VERSION_PLACEHOLDER} were filled in — nothing else fills a slot here, and the address would be fetched as ` +
        "it stands",
      );
    }
    const bytes = await assets.read(from);
    if (bytes.length === 0) {
      throw errValidation(
        `${from} served nothing — an empty file placed as ${name} on ${machine.name} would be a machine that answers ` +
        "every command with a shell error. Check the release carries an asset under that name",
      );
    }
    await machine.putFile(name, bytes, EXECUTABLE_MODE);
    machine.log(`${machine.name}: ${bytes.length} bytes of ${name} ${version} written from ${from}`);
  }

  // The second reading, and the only thing this reports off. `--version` runs the file that was just
  // written, so a truncated transfer, a release asset that is an error page and an architecture the
  // machine cannot execute are all one answer here: not the pin.
  const after = await readVersions(machine, BOOTSTRAP_HOME);
  for (const name of ANSIWISE_EXECUTABLES) {
    if (after[name] === version) continue;
    throw errValidation(
      `${BOOTSTRAP_HOME}${name} on ${machine.name} answers ${after[name] ?? "nothing"} after the transfer, not the pinned ` +
      `${version} — ${downloadAddress(req.downloadUrl, name, version)} did not serve the executable it was expected to. ` +
      "Check that the release carries an asset under that name and that it is built for this machine's architecture",
    );
  }

  // ONTO THE PATH, from the copy just proven rather than from the network a second time: the bytes
  // that answered the pin are the bytes that go where everything else looks for them. `install`
  // replaces a standing file by writing a new one and renaming it over, so a machine is never left
  // with a half-written executable on its path.
  const stdin = Buffer.from(req.elevationPassword + NEWLINE, "utf8");
  for (const name of ANSIWISE_EXECUTABLES) {
    const done = await machine.run(
      ["sudo", "-S", "install", "-m", EXECUTABLE_MODE.toString(8), `${BOOTSTRAP_HOME}${name}`, `${PATH_HOME}${name}`],
      { timeoutMs: COMMAND_TIMEOUT_MS, stdin },
    );
    if (done.code !== 0) {
      throw errValidation(
        `${machine.name} would not place ${name} ${version} in ${PATH_HOME} (exit ${done.code}) — that directory ` +
        "belongs to root, and the elevation password this run carries is what raises the copy. Everything on this " +
        "machine that asks about the engine asks the one standing there, so a machine that keeps an older copy runs " +
        "programs written for a version it is not",
      );
    }
  }

  // READ BACK OFF THE PATH, for the reason the home copies are read back: an `install` that reported
  // success and a directory that answers with something else are two different facts.
  const onPathAfter = await readVersions(machine, PATH_HOME);
  for (const name of ANSIWISE_EXECUTABLES) {
    if (onPathAfter[name] === version) continue;
    throw errValidation(
      `${PATH_HOME}${name} on ${machine.name} answers ${onPathAfter[name] ?? "nothing"} after being placed, not the ` +
      `pinned ${version} — something else on this machine writes that path`,
    );
  }
  machine.log(`${machine.name} carries ${describeExecutables(version)}`);
  return { version, placed: true };
}

/** The two executables and where they stand, in the words both the log line and the refusal use. */
function describeExecutables(version: string): string {
  return `${ANSIWISE_EXECUTABLES.map((name) => `${PATH_HOME}${name}`).join(" and ")} at ${version}`;
}

/** What each executable answers when it is asked which release it is.
 *
 *  ASKED, NEVER DERIVED FROM A FILE NAME. The version used to be read out of the name a symlink
 *  pointed at, which was a statement this module wrote and this module read back — so it said what
 *  the placement had INTENDED and never what the file is. Both binaries answer their release tag on
 *  one line and nothing else on it (ansiwise-cli lib/installation.dart `answeredVersion`), and it is
 *  answered before a program is looked for, so it works on a machine carrying no catalogue at all. */
async function readVersions(
  machine: PlacementMachine,
  where: string,
): Promise<Record<string, string | undefined>> {
  const answers: Record<string, string | undefined> = {};
  for (const name of ANSIWISE_EXECUTABLES) {
    answers[name] = await readVersion(machine, `${where}${name}`);
  }
  return answers;
}

/** The release the executable at `path` answers with, or undefined where nothing answered — which is
 *  what a machine carrying no such file, a file that is not executable and a build too old to know
 *  the flag all look like from here. Every one of those is placed over. */
async function readVersion(machine: PlacementMachine, path: string): Promise<string | undefined> {
  const asked = await machine.run([path, "--version"], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (asked.code !== 0) return undefined;
  const line = asked.stdout.split("\n")[0]?.trim() ?? "";
  return WORD_RE.test(line) ? line : undefined;
}

/** One word of a command, refused rather than quoted. See WHAT MAY STAND IN A COMMAND'S ARGUMENT
 *  LIST — the guard is what lets this module say it composes no shell, so it is applied to every
 *  value that arrives from outside this process. */
export function assertWord(value: string, what: string): void {
  if (!WORD_RE.test(value)) {
    throw errValidation(
      `the ${what} "${value}" is not one plain word, and this places nothing it would have to quote — a value carrying ` +
      "whitespace or anything a shell reads as syntax is refused here rather than escaped, because an escaper is a shell " +
      "composer under another name",
    );
  }
}
