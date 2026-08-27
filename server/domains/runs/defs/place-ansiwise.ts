import { errValidation } from "../../../kernel/errors.ts";

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
// where every other tool of this platform is held (digita-deploy ansiwise/programs/deploy-cluster.yaml).
//
// WHAT THIS MODULE NO LONGER DOES, AND WHERE EACH OF THEM WENT. Read this before adding anything
// back:
//
//   the PACKAGES   `deploy-host`'s `install_packages` row installs git, openssl, curl, jq and
//                  apache2-utils. The bootstrap needs none of them now: the manager fetches the
//                  bytes and SFTP carries them.
//   the CHECKOUTS  `/srv/ansiwise-catalog` is `git_clone`'s (digita-deploy
//                  ansiwise/programs/deploy-platform-services.yaml). `/srv/hostyour-cloud` is declared by no
//                  program at all, and THAT IS A GAP THIS MODULE MAY NOT FILL. Cloning a private
//                  repository needs a credential, and a credential can reach a single command only
//                  through that command's argument list or its environment — the first stands in
//                  the machine's process listing for anyone on it to read, and the second needs a
//                  shell to set. The bash this replaced solved it with a pipeline into a credential
//                  helper, which is exactly the shape that may not come back. `git_clone` has the
//                  answer already: it reads its origin and its credential out of files by NAME,
//                  so neither value passes through a caller. The material belongs on such a row.
//
//                  AND THE ORDER IS THE REVERSE OF THE ONE THE BASH USED, which is why this is a
//                  gap and not an oversight: deploy-platform-services's catalogue row reads its origin from
//                  `/srv/hostyour-cloud/configs/config.<stage>` and its credential from
//                  `secrets.<stage>`, so the MATERIAL has to stand before the CATALOGUE can be
//                  cloned by a step — while a program can only run once the catalogue is there.
//                  Until something breaks that circle, a machine reaching the first program step
//                  with no catalogue is answered by that step, in the words of a binary that finds
//                  no program of that name.
//   the UNIT       `ansiwise-rest install-service` writes it — see the block at
//                  `installAnsiwiseService` for why that invocation is not a mutation site of this
//                  repository's making, and for the one part of it that still is.
//
// WHAT THE MANAGER STILL HAS TO STATE, and it is two values and no shell: WHERE a released
// executable is fetched from (ANSIWISE_DOWNLOAD_URL, carrying both slots below) and WHICH version
// (clusters/platform/versions.yaml's pin, inventory/ansiwise-pin.ts). Never what the caller happens to hold.

/** The deployment tool: the binary that runs a program, and the one every run is a detached child
 *  of. Named as a constant because three places say it — the transfer, the reading, and the
 *  refusal that names what a machine is short of. */
export const ANSIWISE_TOOL = "ansiwise";

/** The serving binary: `serve` over a session's own pipes, `service` on an address, and
 *  `install-service` to place the second one. It is a BINARY OF ITS OWN and not a program of the
 *  tool above: asking THAT one for `serve` answers "no program is called serve", which is the whole reason
 *  both names stand here. */
export const ANSIWISE_REST_TOOL = "ansiwise-rest";

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

/** WHERE the catalogue stands on the machine: the checkout the serving binary reads its programs and
 *  its `ansiwise.yaml` from. The machine's own path and not this module's invention — digita-deploy
 *  `ansiwise/programs/deploy-platform-services.yaml`'s `git_clone` row clones the catalogue repository to
 *  exactly this path, and the resident service is given `--programs` out of it. */
export const CATALOG_CHECKOUT = "/srv/ansiwise-catalog";

/** The program files inside that checkout — what `--programs` has to name, because the option's own
 *  default (`programs`, beside the working directory) is not where a catalogue keeps them. */
export const CATALOG_PROGRAMS = `${CATALOG_CHECKOUT}/ansiwise/programs`;

/** The file naming which plugins the installation turns on, inside the same checkout. It has to be
 *  named because the option's default is `ansiwise.yaml` RELATIVE to the directory the process runs
 *  in, and nothing here runs in the catalogue: see THE WORKING DIRECTORY IS NOT THE CATALOGUE at
 *  `installServiceArgv`. */
export const CATALOG_CONFIG = `${CATALOG_CHECKOUT}/ansiwise.yaml`;

/** WHERE the deployment programs read and write the platform tree — the MATERIAL. The programs
 *  (digita-deploy ansiwise/programs/) name this path on every `repository:` row, so the tree a
 *  refresh feeds them and the tree they act on are one path stated once. */
export const PLATFORM_CHECKOUT = "/srv/hostyour-cloud";

/** Where the engine keeps every run's record on a machine, and the directory above it.
 *
 *  ansiwise-core's `RunDirectory.defaultRoot` names the second, and its recorder creates the run's
 *  own directory RECURSIVELY when a run begins (file_recorder.dart:41) — so both come into being on
 *  a machine's first elevated run, belonging to root, and no program declares them. */
export const ANSIWISE_STATE_ROOT = "/var/lib/ansiwise";

/** See [ANSIWISE_STATE_ROOT]. */
export const ANSIWISE_RUN_ROOT = `${ANSIWISE_STATE_ROOT}/runs`;

/** One line break, named because it is written into a command's standard input and into the split of
 *  what a command answered — two places a literal would be easy to lose. */
const NEWLINE = "\n";

/** Leaves the engine's own state belonging to the account this manager reaches the machine as.
 *
 *  WHY THE MANAGER DOES THIS AND NOT A PROGRAM. deploy-host names a `hand_directory_to_account` row
 *  for exactly these two directories, and that row is what keeps them right afterwards. It cannot be
 *  what makes them right the first time: the manager drives every program through `ansiwise-rest`,
 *  which runs as the operator, and the FIRST thing a run does is write its own record — so a machine
 *  whose run root belongs to root accepts the run, forks it, and the child dies before its first
 *  step. The program that would repair it is the program that cannot start. Measured on apps4:
 *  "machine run … was accepted but never wrote its record — it started and died before its first
 *  step".
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
  const paths = [ANSIWISE_STATE_ROOT, ANSIWISE_RUN_ROOT];
  const owners = await machine.run(["stat", "-c", "%U", ...paths], { timeoutMs: COMMAND_TIMEOUT_MS });
  const read = owners.stdout.split(NEWLINE).map((l) => l.trim()).filter((l) => l.length > 0);
  if (read.length === paths.length && read.every((owner) => owner === req.account)) {
    machine.log(`${machine.name}: ${ANSIWISE_STATE_ROOT} and ${ANSIWISE_RUN_ROOT} already belong to ${req.account} — nothing to hand over`);
    return { handed: false };
  }
  const stdin = Buffer.from(req.elevationPassword + NEWLINE, "utf8");
  // THREE COMMANDS AND NOT ONE, because each `sudo -S` reads the password itself and a value that
  // would have to be quoted is refused by this module rather than escaped — so there is no one shell
  // to put them in. `install -d` makes what is missing; the two `chown`s correct what was already
  // standing, which on every machine this platform has installed is both of them.
  for (const argv of [
    ["sudo", "-S", "install", "-d", "-m", "755", "-o", req.account, "-g", req.account, ANSIWISE_RUN_ROOT],
    ["sudo", "-S", "chown", `${req.account}:${req.account}`, ANSIWISE_STATE_ROOT],
    ["sudo", "-S", "chown", `${req.account}:${req.account}`, ANSIWISE_RUN_ROOT],
  ]) {
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
  machine.log(`${machine.name}: ${ANSIWISE_STATE_ROOT} and ${ANSIWISE_RUN_ROOT} now belong to ${req.account}`);
  return { handed: true };
}

/** The name the service manager knows the resident surface by — the base name of the unit the
 *  serving binary carries and installs itself under (ansiwise-cli `lib/service_unit.dart`
 *  serviceUnitName). Named here only to ASK the machine about it and to restart it; what stands
 *  INSIDE the unit is install-service's alone. */
export const ANSIWISE_SERVICE_UNIT = "ansiwise.service";

/** The file the resident service reads its token out of, and the file install-service writes it to.
 *  The machine's own: digita-deploy `ansiwise/programs/deploy-platform-services.yaml`'s `file_from_vault` row
 *  writes this path out of the entry it mints at `<stage>/manager-host/ansiwise`. */
export const SERVICE_TOKEN_FILE = "/etc/ansiwise/service-token";

/** The port the resident surface stands on, on the machine's tailnet address. An installation-wide
 *  constant and not a per-machine value: the manager dials `<tailnet address>:<this>` and the unit
 *  binds it, so a port decided per machine would be a second thing to look up before every dial. */
export const ANSIWISE_SERVICE_PORT = 9953;

/** The word that places the resident service, as the serving binary spells it (ansiwise-cli
 *  `lib/service_installation.dart` installServiceProgram). */
export const INSTALL_SERVICE_PROGRAM = "install-service";

/** How install-service is told the envelope: on standard input and no other way. It refuses every
 *  other value of the option by name, because a file of raw answers would outlive the call and a
 *  value on the command line stands in every process listing (ansiwise-cli bin/ansiwise_rest.dart). */
export const ANSWERS_ON_STDIN = "-";

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

/** `<a.b.c.d>:<port>`, the shape `--listen` takes — and it is the BINARY's shape, not a shell's:
 *  ServiceInstallation reads the host as four numbers and answers false for everything else
 *  (ansiwise-cli lib/service_installation.dart `_isInTailnet`), so a MagicDNS name is a value the
 *  machine refuses after this placement has already reached it. WHICH of the addresses in that shape
 *  may carry the surface stays the binary's own rule — everything outside 100.64.0.0/10 is refused
 *  there, with the reason — so a refusal about the RANGE comes from the one place that owns it. */
const LISTEN_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/;

/** The same shape, for the caller that reads the address off a row and wants to name that row in its
 *  own refusal rather than let this one speak about a field it cannot see (deploy-slave.ts
 *  `enableAnsiwiseServiceStep`). One shape stated once, so the two refusals cannot drift apart. */
export function isServiceAddress(listen: string): boolean {
  return LISTEN_RE.test(listen);
}

/** A slot nothing filled, in the shape a program file writes one — the same grammar
 *  `install_pinned_tool` reads its own url with (ansiwise-host lib/src/steps/host/install_pinned_tool.dart). */
const LEFTOVER_SLOT_RE = /<[a-z][a-z-]*>/;

/** The credential rides one LINE of a command's standard input, so anything with a line break in it
 *  would leave the rest of that value standing where the command expects the next line. */
const SECRET_LINE_RE = /^[^\r\n]+$/;

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

/** The command line that places the resident service, as an argument list and never as a string.
 *
 *  THE COMMAND IS THE BINARY'S OWN INTERFACE and every option below is one it declares:
 *  install-service composes the unit's `ExecStart` out of the very options it was itself invoked
 *  with (ansiwise-cli `lib/service_installation.dart`), so a unit written anywhere else is a copy of
 *  that binary's interface kept by somebody who cannot see it change.
 *
 *  THE WORKING DIRECTORY IS NOT THE CATALOGUE, and that is what makes two of these options
 *  compulsory. install-service takes the service's `WorkingDirectory` from the directory the
 *  installer itself runs in, and resolves every relative option from there. The previous version of
 *  this module got the catalogue into that slot with `cd <path> && …`, which is a shell composing
 *  two commands out of one line. Here the installer runs wherever the session put it — the operating
 *  account's home — so `--programs` and `--config` are stated ABSOLUTELY instead. `--runs` is left
 *  out because its own default (`/var/lib/ansiwise/runs`, ansiwise-core
 *  infrastructure/run_directory.dart) is already absolute and already right. */
export function installServiceArgv(o: { executable: string; listen: string }): string[] {
  return [
    o.executable,
    INSTALL_SERVICE_PROGRAM,
    "--listen",
    o.listen,
    "--service-token-file",
    SERVICE_TOKEN_FILE,
    "--programs",
    CATALOG_PROGRAMS,
    "--config",
    CATALOG_CONFIG,
    "--answers",
    ANSWERS_ON_STDIN,
  ];
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
   *  command reads — it may reach no file and no argument list. */
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
  const standing = await readVersions(machine);
  const missing = ANSIWISE_EXECUTABLES.filter((name) => standing[name] !== version);
  if (missing.length === 0) {
    machine.log(`${machine.name} already carries ${describeExecutables(version)} — nothing to place`);
    return { version, placed: false };
  }
  machine.log(
    `placing on ${machine.name}: ${missing.map((name) => `${name} ${version} (it carries ${standing[name] ?? "none"})`).join(", ")}`,
  );

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
  const after = await readVersions(machine);
  for (const name of ANSIWISE_EXECUTABLES) {
    if (after[name] === version) continue;
    throw errValidation(
      `${BOOTSTRAP_HOME}${name} on ${machine.name} answers ${after[name] ?? "nothing"} after the transfer, not the pinned ` +
      `${version} — ${downloadAddress(req.downloadUrl, name, version)} did not serve the executable it was expected to. ` +
      "Check that the release carries an asset under that name and that it is built for this machine's architecture",
    );
  }
  machine.log(`${machine.name} carries ${describeExecutables(version)}`);
  return { version, placed: true };
}

/** The two executables and where they stand, in the words both the log line and the refusal use. */
function describeExecutables(version: string): string {
  return `${ANSIWISE_EXECUTABLES.map((name) => `${BOOTSTRAP_HOME}${name}`).join(" and ")} at ${version}`;
}

/** What each executable answers when it is asked which release it is.
 *
 *  ASKED, NEVER DERIVED FROM A FILE NAME. The version used to be read out of the name a symlink
 *  pointed at, which was a statement this module wrote and this module read back — so it said what
 *  the placement had INTENDED and never what the file is. Both binaries answer their release tag on
 *  one line and nothing else on it (ansiwise-cli lib/installation.dart `answeredVersion`), and it is
 *  answered before a program is looked for, so it works on a machine carrying no catalogue at all. */
async function readVersions(machine: PlacementMachine): Promise<Record<string, string | undefined>> {
  const answers: Record<string, string | undefined> = {};
  for (const name of ANSIWISE_EXECUTABLES) {
    answers[name] = await readVersion(machine, `${BOOTSTRAP_HOME}${name}`);
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

/** What the service manager says about ANSIWISE_SERVICE_UNIT — four facts, and not one.
 *
 *  ENABLED and ACTIVE are two: a unit that is enabled and dead comes back at the next boot and
 *  answers nothing until then, and a unit that is running and not enabled answers now and is gone
 *  after a restart. EXECUTABLE and LISTEN are the other two, and they are read because the unit's
 *  own `ExecStart` is where they stand — a unit whose command names another file, or the address the
 *  machine held before it rejoined the tailnet, is enabled and running and wrong. */
export interface ServiceState {
  enabled: boolean;
  active: boolean;
  /** The file `ExecStart` would run, undefined where the service manager knows no such unit. */
  executable?: string | undefined;
  /** The address on that command's `--listen`, undefined where it names none. */
  listen?: string | undefined;
}

/** The file `ExecStart` names and the `--listen` on its argument list, out of what
 *  `systemctl show -p ExecStart` wrote. The service manager writes that value as
 *  `ExecStart={ path=<file> ; argv[]=<file> service --listen <address> … ; … }` and as `ExecStart=`
 *  alone for a unit it does not know, so an empty reading is a machine with no unit and not a machine
 *  whose unit says nothing. `path=` is read rather than the first word of `argv[]` because it is the
 *  one field that names the file the service manager would execute. */
const EXEC_PATH_RE = /(?:^|\s)path=(\S+)/;
const EXEC_LISTEN_RE = /--listen[ =]([^\s;]+)/;

/** Read the unit off the machine, in three questions that change nothing. */
export async function readServiceState(machine: PlacementMachine): Promise<ServiceState> {
  const enabled = await machine.run(["systemctl", "is-enabled", ANSIWISE_SERVICE_UNIT], { timeoutMs: COMMAND_TIMEOUT_MS });
  const active = await machine.run(["systemctl", "is-active", ANSIWISE_SERVICE_UNIT], { timeoutMs: COMMAND_TIMEOUT_MS });
  const shown = await machine.run(["systemctl", "show", "-p", "ExecStart", ANSIWISE_SERVICE_UNIT], { timeoutMs: COMMAND_TIMEOUT_MS });
  const path = EXEC_PATH_RE.exec(shown.stdout)?.[1];
  const listen = EXEC_LISTEN_RE.exec(shown.stdout)?.[1];
  return {
    enabled: enabled.stdout.trim() === "enabled",
    active: active.stdout.trim() === "active",
    ...(path !== undefined ? { executable: path } : {}),
    ...(listen !== undefined ? { listen } : {}),
  };
}

/** The unit as the machine just described it, in the words the decision is made in — so a line an
 *  operator reads and the decision this took are the same four facts. */
export function describeUnit(state: ServiceState): string {
  if (state.executable === undefined) return "a unit the service manager does not know";
  return `${state.enabled ? "enabled" : "NOT enabled"} and ${state.active ? "running" : "NOT running"}, ` +
    `starting ${state.executable} on ${state.listen ?? "an address its command does not name"}`;
}

/** What the service placement needs said. */
export interface ServiceRequest {
  /** The version the two executables answer with — what this asserts before it writes a unit that
   *  will start one of them for ever. */
  version: string;
  /** The address the resident surface is to stand on, `<a.b.c.d>:<port>`. */
  listen: string;
  /** The credential that raises install-service's own writes to root. */
  elevationPassword: string;
  /** Whether THIS run of the bootstrap replaced the executables. A unit that already names the right
   *  file and the right address is left alone — unless the file under it changed, in which case the
   *  running process is still the old inode. See AND THEN THE UNIT IS RESTARTED. */
  replaced: boolean;
}

/** Leave the machine SERVING: the unit written, enabled, running, and starting the executable this
 *  bootstrap placed on the address the caller stated.
 *
 *  THE UNIT IS NOT COMPOSED HERE AND MAY NEVER BE. What is invoked is `ansiwise-rest install-service`,
 *  which is the one thing that knows the command a unit has to carry — it renders `ExecStart` out of
 *  the options it was itself given, checks the three lines the unit cannot work without, writes the
 *  token file and the unit, reloads the service manager and enables the unit (ansiwise-cli
 *  bin/ansiwise_rest.dart `_installService`). digita-deploy's deploy-platform-services states the same rule from
 *  the other side: "The unit that starts the service and the switch that turns it on are the
 *  binary's own act."
 *
 *  IT IS `ansiwise-rest` AND NOT `ansiwise`, and the previous version of this module had it wrong.
 *  install-service is a program of the SERVING binary; the deployment tool answers `no program is
 *  called install-service` and exits 64.
 *
 *  THE TOKEN CROSSES THIS PROCESS, AND THAT IS A COST OF NOT HAVING A SHELL. install-service takes
 *  the value in the envelope on its standard input and nowhere else — it refuses `--answers <path>`
 *  by name — while the value itself lives at SERVICE_TOKEN_FILE, which only root may read. The bash
 *  this replaced kept the value on the machine by piping `sudo cat` into the installer; a pipeline is
 *  a shell. So the manager reads it over the session it already holds, puts it straight into the
 *  envelope, and never writes it anywhere: it is in this process's memory for the length of one
 *  command. Nothing here can prove that is safe — it is a judgement, and it is written down so it can
 *  be argued with.
 *
 *  AND THEN THE UNIT IS RESTARTED, when this run replaced the executables. install-service ends at
 *  `systemctl enable --now`, and `--now` starts a unit that is not running and does nothing to one
 *  that is — while a service keeps the inode it started from, so a machine whose executable was just
 *  replaced goes on serving the old code with the new file on disk answering the new version. No step
 *  of the framework restarts a unit (simetrixch/ansiwise-plugins#141), which is why this one line is
 *  still the manager's and why the row for `ansiwise-rest` is deliberately absent from
 *  deploy-cluster's tool phase. It is not a unit composed here: the started command stays
 *  install-service's, and this only makes the machine run the one it just wrote. `KillMode=process`
 *  in that unit is what makes it safe — every run is started detached and outlives the restart. */
export async function installAnsiwiseService(
  machine: PlacementMachine,
  req: ServiceRequest,
): Promise<boolean> {
  assertListen(req.listen);
  assertSecretLine(req.elevationPassword, "elevation password");
  const executable = `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`;

  // WHAT A STANDING UNIT WOULD HAVE TO SAY for this to leave it alone, and the version is ASKED OF
  // THE FILE THE UNIT NAMES rather than compared against a path. `ExecStart` carries the absolute
  // file the installer resolved to, which is not the word a command is written with, and it is the
  // FILE's answer that decides anyway: a unit naming the right path whose file was replaced under it
  // is exactly the machine this has to notice.
  const before = await readServiceState(machine);
  const startsPinned = before.executable !== undefined
    && (await readVersion(machine, before.executable)) === req.version;
  if (!req.replaced && before.enabled && before.active && startsPinned && before.listen === req.listen) {
    machine.log(`${machine.name}: ${ANSIWISE_SERVICE_UNIT} is ${describeUnit(before)} — nothing to place`);
    return false;
  }
  machine.log(
    `placing on ${machine.name}: ${ANSIWISE_SERVICE_UNIT} starting ${ANSIWISE_REST_TOOL} ${req.version} on ${req.listen}, ` +
    `by running ${INSTALL_SERVICE_PROGRAM} (it is ${describeUnit(before)})`,
  );

  const token = await readServiceToken(machine, req.elevationPassword);
  const installed = await machine.run(installServiceArgv({ executable, listen: req.listen }), {
    timeoutMs: COMMAND_TIMEOUT_MS,
    stdin: Buffer.from(
      JSON.stringify({ answers: { service_token: token }, elevation_password: req.elevationPassword }),
      "utf8",
    ),
  });
  if (installed.code !== 0) {
    throw errValidation(
      `install-service refused to place ${ANSIWISE_SERVICE_UNIT} on ${machine.name} (exit ${installed.code}) — read what ` +
      "it wrote in the run log; it names everything that stands in the way at once, and every one of them is either the " +
      "address, the token file, or the elevation password the run carries",
    );
  }
  if (req.replaced) {
    const restarted = await machine.run(["sudo", "-S", "systemctl", "restart", ANSIWISE_SERVICE_UNIT], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      stdin: Buffer.from(`${req.elevationPassword}\n`, "utf8"),
    });
    if (restarted.code !== 0) {
      throw errValidation(
        `${ANSIWISE_SERVICE_UNIT} on ${machine.name} was rewritten to start ${ANSIWISE_REST_TOOL} ${req.version} and would ` +
        `not restart onto it (exit ${restarted.code}) — the process still serving is the one it started before. Read ` +
        `\`systemctl status ${ANSIWISE_SERVICE_UNIT}\` and \`journalctl -u ${ANSIWISE_SERVICE_UNIT}\` on ${machine.name}`,
      );
    }
  }

  // READ OFF THE MACHINE, never off the installer's own claim: install-service can write the unit,
  // enable it and exit zero, and the service manager then refuse to start it — a bind to an address
  // the machine does not hold at this second, a token file it cannot read.
  const active = await machine.run(["systemctl", "is-active", ANSIWISE_SERVICE_UNIT], { timeoutMs: COMMAND_TIMEOUT_MS });
  const said = active.stdout.trim();
  if (said !== "active") {
    throw errValidation(
      `${ANSIWISE_SERVICE_UNIT} on ${machine.name} is ${said === "" ? "not known to the service manager" : said} after ` +
      `install-service was run — the machine is not serving ${ANSIWISE_REST_TOOL} ${req.version} on ${req.listen}. Read ` +
      `\`systemctl status ${ANSIWISE_SERVICE_UNIT}\` and \`journalctl -u ${ANSIWISE_SERVICE_UNIT}\` on ${machine.name}`,
    );
  }
  machine.log(
    `${machine.name} serves ${ANSIWISE_REST_TOOL} ${req.version} on ${req.listen}, out of ${CATALOG_PROGRAMS} — ` +
    `${ANSIWISE_SERVICE_UNIT} is enabled and running`,
  );
  return true;
}

/** The value install-service has to be told, read off the machine with the run's own elevation.
 *
 *  REFUSED BY NAME rather than left inside "the command failed": a machine that has not been through
 *  the run that mints the token has no surface to install, and that is a different thing to go and
 *  fix than a wrong password. */
async function readServiceToken(machine: PlacementMachine, elevationPassword: string): Promise<string> {
  const read = await machine.run(["sudo", "-S", "cat", SERVICE_TOKEN_FILE], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    stdin: Buffer.from(`${elevationPassword}\n`, "utf8"),
  });
  const token = read.stdout.trim();
  if (read.code !== 0 || token.length === 0) {
    throw errValidation(
      `${machine.name} answers nothing readable at ${SERVICE_TOKEN_FILE}, and that value is the whole authentication of ` +
      "the resident surface — the deploy-platform-services program's file_from_vault row writes it out of the entry it mints at " +
      `<stage>/manager-host/ansiwise. Run deploy-platform-services on ${machine.name} first, then enable the service again`,
    );
  }
  if (!WORD_RE.test(token)) {
    throw errValidation(
      `${SERVICE_TOKEN_FILE} on ${machine.name} does not hold a token — it carries something that is not one. Delete it ` +
      "together with the <stage>/manager-host/ansiwise entry and run deploy-platform-services again, which mints a fresh one; a " +
      "service installed with what stands there now would present it to nobody",
    );
  }
  return token;
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

/** The service address, refused by NAMING THE SHAPE rather than only the value. The caller's own
 *  field carries no shape — `servers.tailnetHost` is `z.string().min(1)` (inventory/write.ts) and its
 *  other reader takes a name (deploy-slave.ts `mark-slave`) — so a value that is legal there and
 *  illegal here has to be told what it is short of, and where the rule is. */
function assertListen(listen: string): void {
  if (isServiceAddress(listen)) return;
  throw errValidation(
    `the service address "${listen}" is not a shape install-service's --listen takes: it takes <a.b.c.d>:<port>, ` +
    "four numbers and a port, because ServiceInstallation reads the host as four numbers and serves on nothing " +
    "outside 100.64.0.0/10 (ansiwise-cli lib/service_installation.dart). A name, an IPv6 address or an empty " +
    "value is refused ON THE MACHINE, after the placement has reached it",
  );
}

/** The guard for a value that may not be shown: a credential rides ONE line of a command's standard
 *  input, and a refusal that quoted it would put it in the run log. */
function assertSecretLine(value: string, what: string): void {
  if (!SECRET_LINE_RE.test(value)) {
    throw errValidation(`the ${what} carries a line break or is empty — it rides one line of a command's standard input`);
  }
}
