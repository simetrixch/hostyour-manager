import { errValidation } from "../../../kernel/errors.ts";
import { PRODUCT_BRANCH } from "../../../../shared/branches.ts";

// `place-ansiwise` — what a machine has to carry before anything else can speak to it at all. Every
// program act goes through `ansiwise serve` over a session (ansiwise-run.kit.ts), and that command
// is a binary reading a catalogue of program files out of a checkout: a machine that carries neither
// answers nothing, and the first program dies with a shell error.
//
// FOUR PLACEMENTS, ONE MECHANISM, and they belong together because none of them is worth anything
// alone:
//
//   the BINARY     /usr/local/bin/ansiwise, at the version platform/versions.yaml pins
//                  (inventory/ansiwise-pin.ts) — never at whatever the caller happens to hold. It is
//                  installed under its version (ansiwise-<version>) with the plain name a symlink
//                  onto it, which is what makes the placed version READABLE afterwards: the binary
//                  takes no --version flag, so the name of the file the link points at is the only
//                  statement about which one is there, and it is one this mechanism wrote itself.
//   the CATALOGUE  the checkout at CATALOG_CHECKOUT, cloned from the catalogue repository — the
//                  `ansiwise.yaml` and the `ansiwise/programs/` every later step starts a program
//                  out of by name.
//   the MATERIAL   the platform checkout at PLATFORM_CHECKOUT, cloned on the machine's install
//                  branch. Every deployment program ACTS on that tree — their `repository:` rows
//                  name the path — so a machine without it has nothing for them to work on.
//   the SERVICE    ANSIWISE_SERVICE_UNIT, enabled and running AND starting the version that was just
//                  placed on the address the caller stated, so the surface outlives the session that
//                  installed it and is the surface the caller thinks it is. Placed only where the
//                  caller states the address it is to stand on, because a machine has none until it
//                  is on the tailnet — see THE SERVICE IS PLACED LAST below.
//
// THE CATALOGUE AND THE MATERIAL ARE TWO REPOSITORIES, and the first version of this placement
// asserted they were one. `hostyour-cloud/platform/versions.yaml:22-24` names the two trees:
// `platform` is that repository, `deploy` is "the installation repository carrying the ansiwise
// programs". `ls ansiwise` in a hostyour-cloud checkout answers nothing, so a placement that cloned
// only the platform repo and then looked for programs in it refused on every real machine.
//
// WHERE THE CATALOGUE STANDS is CATALOG_CHECKOUT, and that path is the machine's own, not this
// module's invention: digita-deploy `ansiwise/programs/deploy-gitops.yaml`'s `git_clone` row for
// /srv/ansiwise-catalog clones that same repository to that same path once the machine has a secret
// store, and its `THE UNIT AND THE SWITCH ARE NOT ROWS` block states that the resident deployment
// service is given `--programs /srv/ansiwise-catalog/ansiwise/programs` out of it. This is the FIRST
// placement, before any of that exists, and it puts the checkout where those rows will find it.
//
// PROBE, PLACE, PROBE AGAIN. The mechanism measures the machine first and places only what is
// missing — which is what makes a second run a no-op rather than a re-installation — and then
// measures again and reads its verdict off THAT, never off the placing script's own claim. A
// placement that reported success without looking would report it just as happily when curl wrote an
// error page into the file it installed.
//
// AND WHAT IS MISSING INCLUDES A UNIT THAT IS STANDING ON THE WRONG THING. The service is measured
// by FOUR facts and not by two: enabled, running, and the version and address the unit's own
// `ExecStart` names (`standing`). A unit whose command is right is not a fact that follows from a
// unit that is up, because ExecStart names the VERSIONED file: place a newer binary on a machine
// whose service already stands, leave the unit alone, and it goes on starting ansiwise-<the old
// version> for ever under `Restart=always`, with the old file still on disk and nothing complaining.
// The same holds for the address — a rejoin hands the host a fresh one and the unit keeps binding
// the old. Measuring all four is what makes an UPGRADE a re-installation and what makes the line
// this writes at the end a reading of the machine rather than a repetition of the request.
//
// THE SERVICE COMPOSES NOTHING. What this places is an INVOCATION of `ansiwise install-service`,
// never a unit file and never the command inside one. deploy-gitops.yaml's `THE UNIT AND THE SWITCH
// ARE NOT ROWS` block states the rule and it is right: install-service composes the started command
// out of the option names the binary will itself be started with (ansiwise-cli
// lib/service_installation.dart, `ServiceInstallation.command`),
// so a unit written anywhere else is a copy of that binary's interface kept by somebody who cannot
// see it change. The options below are install-service's OWN — `--listen`, `--service-token-file`,
// `--programs`, `--answers -` — and every path among them is one this module already states for the
// other three placements. What it does NOT name is anything the binary already decides: see THE
// WORKING DIRECTORY IS THE CATALOGUE at the invocation itself.
//
// THE TOKEN NEVER LEAVES THE MACHINE. install-service is told the service token on standard input,
// and the value it is told is read on the machine out of SERVICE_TOKEN_FILE — the file
// deploy-gitops.yaml's `file_from_vault` row writes out of the entry it minted at
// `<stage>/manager-host/ansiwise`. So the one value the manager and the machine have to agree on is
// minted once, in one place, and is never carried through a caller that has no business holding it.
// A machine whose token file is not there is REFUSED by name: it has not been through the run that
// mints it, and a service enabled without it comes up failed at every boot.
//
// THE SERVICE IS PLACED LAST, and by the same mechanism rather than by a person. `--listen` is the
// machine's tailnet address — ServiceInstallation refuses every address outside 100.64.0.0/10,
// because the manager presents that token in a plain HTTP header — and a machine has no such
// address until it has joined the tailnet, which happens long after the binary is placed. So the
// SERVICE half of the request is optional: a caller placing onto a bare machine states none and the
// unit is left alone, and the caller that states one is the one that already knows the address it
// will dial. In this manager those are two steps over one mechanism — `placeAnsiwiseStep` at the
// head of the machine-side acts and `enableAnsiwiseServiceStep` after the join (deploy-slave.ts).
//
// IT TAKES A MACHINE AND VALUES, AND NOTHING ONLY A MANAGER HAS. `placeAnsiwise` takes a
// PlacementMachine — a name, a way to run a script on it, somewhere to write a line an operator
// reads — and a PlacementRequest of plain values: the pinned version, the three addresses, the
// install branch, the account, the elevation password and, where there is one, the address the
// service is to stand on. It opens no session, reads no database and carries no run context.
//
// TWO CALLERS CALL IT, both this manager's and both in deploy-slave.ts, which resolves those values
// out of the cluster row, the server row, platform/versions.yaml and the installation's settings. A
// machine at its FIRST installation stands in no such row, so it cannot start either step, and no
// other FIRST placement exists for it: the machine's own clone of the catalogue (deploy-gitops.yaml,
// above) runs long afterwards, on a machine that already carries all
// three. What the two interfaces below are for is the SHAPE such a placement has to satisfy,
// written down where it can be read: a machine that runs a script and takes a line, and values a
// caller states without a table to read them out of. It is a demand on whatever places next, not a
// third caller that is there.

/** The name every caller starts, and the link this mechanism points at the version it placed. */
export const ANSIWISE_BINARY_LINK = "/usr/local/bin/ansiwise";

/** Where the versioned binaries stand. The link above names one of them. */
const ANSIWISE_BINARY_DIR = "/usr/local/bin";

/** WHERE the catalogue stands on the machine: the checkout `ansiwise serve` reads its programs and
 *  its `ansiwise.yaml` from, and the path the machine's own resident service is later written with
 *  (see the header). The command that starts that surface is the caller's — ANSIWISE_SERVE_COMMAND
 *  in this manager (kernel/config.ts) — and an installation whose command reads a different
 *  directory serves different programs than this placed. Nothing here can check that pairing, which
 *  is why the success line names both the setting and the path it wrote. */
export const CATALOG_CHECKOUT = "/srv/ansiwise-catalog";

/** WHERE the deployment programs read and write the platform tree — the MATERIAL. The programs
 *  (digita-deploy ansiwise/programs/) name this path on every `repository:` row, so the tree this
 *  places and the tree a later refresh feeds them have to be one path stated once. */
export const PLATFORM_CHECKOUT = "/srv/hostyour-cloud";

/** The branch the catalogue is taken from: the trunk, for the reason the pin is read off the trunk
 *  (inventory/ansiwise-pin.ts) — the programs are the product, and a machine at its first
 *  installation has no install branch to read them off. The machine's own later clone of the same
 *  repository names the same branch. */
const CATALOG_BRANCH = PRODUCT_BRANCH;

/** What the download address writes where the pinned version belongs. One placeholder and one
 *  source: the address says WHERE a version is fetched from, the pin says WHICH — so the two can
 *  never state different versions. */
export const VERSION_PLACEHOLDER = "<version>";

/** The name the service manager knows the resident surface by — the base name of the unit the
 *  binary carries and installs itself under (ansiwise-cli `lib/service_unit.dart` serviceUnitName).
 *  Named here only to ASK the machine about it; what stands in the unit is install-service's. */
export const ANSIWISE_SERVICE_UNIT = "ansiwise.service";

/** The file the resident service reads its token out of, and the file install-service writes it to.
 *  The machine's own, not this module's invention: digita-deploy
 *  `ansiwise/programs/deploy-gitops.yaml`'s `file_from_vault` row writes this path out of the entry
 *  it mints at `<stage>/manager-host/ansiwise`, and the placement reads the value back out of it on
 *  the machine rather than carrying it through a caller. */
export const SERVICE_TOKEN_FILE = "/etc/ansiwise/service-token";

/** The port the resident surface stands on, on the machine's tailnet address. An installation-wide
 *  constant and not a per-machine value: the manager dials `<tailnet address>:<this>` and the unit
 *  binds it, so a port decided per machine would be a second thing to look up before every dial.
 *  The binary states no default for `--listen` at all (ansiwise-cli `bin/ansiwise.dart`), which is
 *  why a number stands here rather than being left out. */
export const ANSIWISE_SERVICE_PORT = 9953;

/** The commands the placement itself runs on the machine. A machine at its first installation
 *  carries neither by rule — `deploy-host` installs the full set a machine needs, and it cannot run
 *  until this is done. */
const REQUIRED_COMMANDS = ["curl", "git"] as const;

/** The packages that carry them on the pinned distribution. */
const REQUIRED_PACKAGES = "curl ca-certificates git";

/** The placement's wall clock. Two clones and one package install over a cold apt cache are the long
 *  acts in it. */
export const PLACE_ANSIWISE_TIMEOUT_MS = 10 * 60_000;

/** The probe's own, which reads and writes nothing. */
const PROBE_TIMEOUT_MS = 60_000;

/** What a value put into a remote command may look like. Everything a command is composed from
 *  arrives from OUTSIDE this process — a version out of a file on the platform repo, two clone
 *  addresses out of the caller's settings, a branch off the cluster row — so each is held against
 *  its shape before it reaches a shell. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
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
/** The credential rides one LINE of the script's standard input, so anything with a line break in it
 *  would leave the rest of that value standing where the script expects the next credential. */
const SECRET_LINE_RE = /^[^\r\n]+$/;

/** What the machine answers about itself. Separate facts, because each is placed separately and a
 *  run that finds three of them standing must not redo the fourth. */
export interface MachinePlacement {
  /** The version the link points at, `unversioned` when something else stands under that name, or
   *  undefined when nothing does. */
  binary?: string | undefined;
  /** Whether PLATFORM_CHECKOUT is a git checkout. */
  platform: boolean;
  /** Whether CATALOG_CHECKOUT is a git checkout. */
  catalog: boolean;
  /** Whether that catalogue checkout carries the program files. */
  programs: boolean;
  /** What the service manager says about ANSIWISE_SERVICE_UNIT. Four facts and not one.
   *
   *  ENABLED and ACTIVE are two: a unit that is enabled and dead comes back at the next boot and
   *  answers nothing until then, and a unit that is running and not enabled answers now and is gone
   *  after a restart.
   *
   *  VERSION and LISTEN are the other two, and they are read because the unit's own command is where
   *  they stand. `ExecStart` names the VERSIONED file — ansiwise-cli `ServiceInstallation.command`
   *  puts `executable` first and `bin/ansiwise.dart` hands it `Platform.resolvedExecutable`, which is
   *  ansiwise-<version> and never the link — and it carries the `--listen` the service was installed
   *  with. A machine whose binary moved under a unit nobody re-installed is enabled and active and
   *  starts the OLD file for ever under `Restart=always`, and a machine that rejoined the tailnet at
   *  a fresh address is enabled and active and bound to the address it used to hold. */
  service: {
    enabled: boolean;
    active: boolean;
    /** The version of the file `ExecStart` names, UNVERSIONED where that file carries none in its
     *  name, undefined where the service manager knows no such unit. */
    version?: string | undefined;
    /** The address on that command's `--listen`, undefined where it names none. */
    listen?: string | undefined;
  };
  /** The commands of REQUIRED_COMMANDS the machine is missing. */
  missingCommands: string[];
}

/** A binary standing under the plain name that this mechanism did not put there — its version cannot
 *  be read, so it is replaced by the pin rather than trusted. */
export const UNVERSIONED = "unversioned";

/** The read-only measurement. Runs before anything is placed and again after, so the verdict is a
 *  reading of the machine and not a repetition of what the placing script said it did. */
export function probeScript(): string {
  return `#!/usr/bin/env bash
target=$(readlink -f "${ANSIWISE_BINARY_LINK}" 2>/dev/null || true)
if [ -n "$target" ] && [ -x "$target" ]; then
  case "$target" in
    */ansiwise-*) echo "BINARY \${target##*/ansiwise-}" ;;
    *) echo "BINARY ${UNVERSIONED}" ;;
  esac
else
  echo "BINARY absent"
fi
[ -d "${PLATFORM_CHECKOUT}/.git" ] && echo "PLATFORM present" || echo "PLATFORM absent"
[ -d "${CATALOG_CHECKOUT}/.git" ] && echo "CATALOG present" || echo "CATALOG absent"
[ -d "${CATALOG_CHECKOUT}/ansiwise/programs" ] && echo "PROGRAMS present" || echo "PROGRAMS absent"
systemctl is-enabled --quiet ${ANSIWISE_SERVICE_UNIT} 2>/dev/null && echo "SERVICE enabled" || echo "SERVICE not-enabled"
systemctl is-active --quiet ${ANSIWISE_SERVICE_UNIT} 2>/dev/null && echo "SERVICE active" || echo "SERVICE not-active"
exec_start=$(systemctl show -p ExecStart ${ANSIWISE_SERVICE_UNIT} 2>/dev/null | head -n 1)
echo "SERVICE_EXEC $exec_start"
for c in ${REQUIRED_COMMANDS.join(" ")}; do
  command -v "$c" >/dev/null 2>&1 || echo "MISSING $c"
done
echo "PROBED"
`;
}

/** Read the probe's answer. `PROBED` closes it: a truncated read must never be taken for a machine
 *  that carries nothing, which is the shape that would place over a working installation. */
export function parseProbe(stdout: string): MachinePlacement {
  const lines = stdout.split("\n").map((l) => l.trim());
  if (!lines.includes("PROBED")) {
    throw errValidation("the placement probe did not finish — nothing was read about the machine; see the run log");
  }
  const binary = lines.find((l) => l.startsWith("BINARY "))?.slice("BINARY ".length);
  const shown = lines.find((l) => l.startsWith("SERVICE_EXEC "))?.slice("SERVICE_EXEC ".length) ?? "";
  return {
    binary: binary === undefined || binary === "absent" ? undefined : binary,
    platform: lines.includes("PLATFORM present"),
    catalog: lines.includes("CATALOG present"),
    programs: lines.includes("PROGRAMS present"),
    service: {
      enabled: lines.includes("SERVICE enabled"),
      active: lines.includes("SERVICE active"),
      ...startedCommand(shown),
    },
    missingCommands: lines.filter((l) => l.startsWith("MISSING ")).map((l) => l.slice("MISSING ".length)),
  };
}

/** The file `ExecStart` names and the `--listen` on its argument list, out of what
 *  `systemctl show -p ExecStart` wrote. The service manager writes that value as
 *  `ExecStart={ path=<file> ; argv[]=<file> serve --listen <address> … ; … }` and as `ExecStart=`
 *  alone for a unit it does not know, so an empty reading is a machine with no unit and not a machine
 *  whose unit says nothing. `path=` is read rather than the first word of `argv[]` because it is the
 *  one field that names the file the service manager would execute. */
const EXEC_PATH_RE = /(?:^|\s)path=(\S+)/;
const EXEC_LISTEN_RE = /--listen[ =]([^\s;]+)/;
function startedCommand(shown: string): { version?: string; listen?: string } {
  const path = EXEC_PATH_RE.exec(shown)?.[1];
  if (path === undefined) return {};
  const file = path.slice(path.lastIndexOf("/") + 1);
  const listen = EXEC_LISTEN_RE.exec(shown)?.[1];
  return {
    version: file.startsWith("ansiwise-") ? file.slice("ansiwise-".length) : UNVERSIONED,
    ...(listen !== undefined ? { listen } : {}),
  };
}

export interface PlaceInput {
  version: string;
  downloadUrl: string;
  repoUrl: string;
  branch: string;
  catalogUrl: string;
  /** The credential the catalogue repository is read with, absent for a public one. */
  catalogToken?: string | undefined;
  /** The credential that raises a command to root, validated once at the top of the script. */
  elevationPassword: string;
  /** The account the checkouts are handed to — the one every later step reaches the machine as, and
   *  the one refresh-checkout fetches into it with, which it cannot do on a root-owned tree. */
  user: string;
  /** The address the resident surface is to stand on, `<a.b.c.d>:<port>`. Absent where the caller
   *  placed no service — see THE SERVICE IS PLACED LAST in the header. */
  listen?: string | undefined;
  /** What the probe found missing. Nothing that stands is touched. */
  place: { commands: boolean; binary: boolean; platform: boolean; catalog: boolean; service: boolean };
}

/** The script the machine runs and what its standard input carries, composed together because the
 *  script READS that input line by line: a script whose parts and a buffer whose lines were decided
 *  apart could disagree about how many credentials there are, and the shell would then read the
 *  elevation password into the variable meant for the catalogue's. */
export interface RemotePlacement {
  script: string;
  stdin: Buffer;
}

/** Whether the placement carries the catalogue credential to the machine: only a run that actually
 *  clones the catalogue needs it, and only an installation that stated one has it. */
function carriesCatalogToken(o: PlaceInput): boolean {
  return o.place.catalog && o.catalogToken !== undefined;
}

/** The placing script, composed of only the parts the probe asked for.
 *
 *  NO CREDENTIAL STANDS IN THE SCRIPT, which is a file on the machine's disk for as long as the
 *  placement runs, and none stands in a command's arguments, which are in the machine's process
 *  listing. Both ride standard input: the script reads the catalogue's credential into a variable of
 *  its own and hands it to git through git's own configuration-by-environment, and `sudo -S` reads
 *  the elevation password off the line after it and everything from there on runs `sudo -n`. */
export function placement(o: PlaceInput): RemotePlacement {
  assertShape(o.version, VERSION_RE, "version");
  assertShape(o.branch, BRANCH_RE, "branch");
  assertShape(o.user, USER_RE, "operator account");
  assertShape(o.downloadUrl, URL_RE, "download address");
  assertShape(o.repoUrl, URL_RE, "clone address");
  assertShape(o.catalogUrl, URL_RE, "catalogue address");
  assertSecretLine(o.elevationPassword, "elevation password");
  if (o.place.service) assertListen(o.listen ?? "");
  const withToken = carriesCatalogToken(o);
  if (withToken) assertSecretLine(o.catalogToken ?? "", "catalogue credential");
  const parts = [`#!/usr/bin/env bash
set -euo pipefail`];
  if (withToken) {
    parts.push(`IFS= read -r ANSIWISE_CATALOG_TOKEN
export ANSIWISE_CATALOG_TOKEN`);
  }
  if (o.place.service) {
    // The service part needs the password a SECOND time — install-service takes it in the envelope
    // on its own standard input, because the installation says the caller hands it over
    // (digita-deploy `ansiwise.yaml`: `elevation: {password_from_caller: true}`). So it is read into
    // a variable here instead of being handed straight to `sudo -S`, and `printf` is the shell's own
    // builtin: the value reaches sudo down a pipe and stands in no process listing, exactly as it
    // does when sudo reads it off this script's input.
    parts.push(`IFS= read -r ANSIWISE_ELEVATION
printf '%s\\n' "$ANSIWISE_ELEVATION" | sudo -S -p '' -v`);
  } else {
    parts.push("sudo -S -p '' -v");
  }
  if (o.place.commands) {
    parts.push(`sudo -n apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ${REQUIRED_PACKAGES}`);
  }
  if (o.place.binary) {
    parts.push(`tmp=$(mktemp)
curl -fsSL "${o.downloadUrl}" -o "$tmp"
sudo -n install -m0755 "$tmp" "${ANSIWISE_BINARY_DIR}/ansiwise-${o.version}"
rm -f "$tmp"
sudo -n ln -sfn "${ANSIWISE_BINARY_DIR}/ansiwise-${o.version}" "${ANSIWISE_BINARY_LINK}"
echo "PLACED_BINARY ${o.version}"`);
  }
  if (o.place.catalog) {
    // The credential reaches git as an authorization it composes itself, out of the environment: the
    // helper string is what stands in the argument list and in the checkout's config, the value
    // never does. GIT_TERMINAL_PROMPT=0 turns a repository this credential cannot read into a
    // refusal the run log names, instead of a git that waits for a username nobody can type.
    const credential = withToken
      ? ` -c credential.helper='!f(){ printf "username=x-access-token\\npassword=%s\\n" "$ANSIWISE_CATALOG_TOKEN"; };f'`
      : "";
    parts.push(`export GIT_TERMINAL_PROMPT=0
sudo -n install -d -o "${o.user}" -g "${o.user}" "${CATALOG_CHECKOUT}"
git${credential} clone --branch "${CATALOG_BRANCH}" "${o.catalogUrl}" "${CATALOG_CHECKOUT}"
echo "PLACED_CATALOG $(git -C "${CATALOG_CHECKOUT}" rev-parse --short HEAD)"`);
  }
  if (o.place.platform) {
    parts.push(`export GIT_TERMINAL_PROMPT=0
sudo -n install -d -o "${o.user}" -g "${o.user}" "${PLATFORM_CHECKOUT}"
git clone --branch "${o.branch}" "${o.repoUrl}" "${PLATFORM_CHECKOUT}"
echo "PLACED_PLATFORM $(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)"`);
  }
  if (o.place.service) {
    // THE VERSIONED BINARY AND NOT THE LINK. install-service compares the file this process was
    // STARTED from against the executable it resolved to and refuses when they differ, because a
    // unit rendered from a checkout would name the toolchain (ansiwise-cli
    // `ServiceInstallation.problems`). The link resolves to the versioned file, so starting it
    // through the link is the one way to make those two names differ on a machine this mechanism
    // placed — and the version is exactly what the probe just read off the link.
    //
    // THE WORKING DIRECTORY IS THE CATALOGUE, because install-service takes the service's working
    // directory from the directory it is itself run in — and it is what makes the two options NOT
    // named below land right. `--config` defaults to `Configuration.defaultFileName`
    // ('ansiwise.yaml', ansiwise-core config/configuration.dart) and `--runs` to
    // `RunDirectory.defaultRoot` ('/var/lib/ansiwise/runs', ansiwise-core
    // infrastructure/run_directory.dart), both of which are already the right values here; writing
    // them out would be two more copies of the binary's own decisions kept where nobody sees them
    // change. `--programs` IS named, because its default ('programs', beside the working directory)
    // is not where the catalogue keeps them.
    //
    // THE ESCAPED PASSWORD IS ASSIGNED BEFORE IT IS USED, and not written inline as an argument. A
    // command substitution standing in an argument list does not carry its failure out — `set -e`
    // never sees it — so an escape that failed there would put an EMPTY password into the envelope
    // and leave the refusal to install-service. Assigned, the failure ends the script where it
    // happened.
    //
    // AND THEN THE UNIT IS RESTARTED, because install-service ends at `systemctl enable --now`
    // (ansiwise-cli bin/ansiwise.dart) and `--now` starts a unit that is not running and does nothing
    // to one that is. A machine being placed at a MOVED pin is running: the unit file it just got
    // names ansiwise-<the new version> and the process still serving is the old file, which stays on
    // disk. Without this line the placement would then read a unit that says the new version off a
    // machine serving the old one. It is not a unit composed here — the started command stays
    // install-service's, and this only makes the machine run the one it just wrote. `KillMode=process`
    // in that unit is what makes it safe: every run is started detached and outlives the restart.
    parts.push(`cd "${CATALOG_CHECKOUT}"
if ! sudo -n test -r "${SERVICE_TOKEN_FILE}"; then
  echo "NO_SERVICE_TOKEN"
  exit 1
fi
service_token=$(sudo -n cat "${SERVICE_TOKEN_FILE}")
case "$service_token" in
  '' | *[!0-9A-Za-z._-]*) echo "MALFORMED_SERVICE_TOKEN"; exit 1 ;;
esac
elevation_json=$(printf '%s' "$ANSIWISE_ELEVATION" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
printf '{"answers":{"service_token":"%s"},"elevation_password":"%s"}' "$service_token" "$elevation_json" \\
  | "${ANSIWISE_BINARY_DIR}/ansiwise-${o.version}" install-service \\
      --listen "${o.listen ?? ""}" \\
      --service-token-file "${SERVICE_TOKEN_FILE}" \\
      --programs "${CATALOG_CHECKOUT}/ansiwise/programs" \\
      --answers -
sudo -n systemctl restart ${ANSIWISE_SERVICE_UNIT}
echo "PLACED_SERVICE"`);
  }
  parts.push('echo "PLACED"');
  return {
    script: parts.join("\n") + "\n",
    stdin: Buffer.from(
      (withToken ? `${o.catalogToken ?? ""}\n` : "") + `${o.elevationPassword}\n`,
      "utf8",
    ),
  };
}

function assertShape(value: string, shape: RegExp, what: string): void {
  if (!shape.test(value)) {
    throw errValidation(`the ${what} "${value}" is not a value this placement may put into a command on the machine`);
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

/** The same guard for a value that may not be shown: a credential rides ONE line of the placement's
 *  standard input, and a refusal that quoted it would put it in the run log. */
function assertSecretLine(value: string, what: string): void {
  if (!SECRET_LINE_RE.test(value)) {
    throw errValidation(`the ${what} carries a line break or is empty — it rides one line of the placement's standard input`);
  }
}

/** THE MACHINE, as the placement sees it: a name to call it by in what an operator reads, a way to
 *  run a script on it and read back everything it wrote, and somewhere to put a line. Nothing else —
 *  the two callers there are (deploy-slave.ts `runPlacement`) satisfy these three out of a run's
 *  cached session and a server row, and these three are the whole of what placing from anywhere else
 *  would have to supply. */
export interface PlacementMachine {
  /** What the machine is called in a refusal — the name an operator knows it by. */
  name: string;
  /** Put `script` on the machine under a path derived from `name`, run it, and answer its exit code
   *  and its WHOLE standard output (not a tail: the probe's answer is parsed out of it). `stdin` is
   *  the credentials the script reads line by line — it may reach no file and no argument list. */
  runScript(name: string, script: string, o: { timeoutMs: number; stdin?: Buffer }): Promise<{ code: number; stdout: string }>;
  /** Where a line an operator reads goes. */
  log(line: string): void;
}

/** What the placement needs said, and every one of these is a value: nothing here is a session, a
 *  database row or a run. */
export interface PlacementRequest {
  /** The version to place — platform/versions.yaml's pin (inventory/ansiwise-pin.ts), never what the
   *  caller happens to hold. */
  version: string;
  /** WHERE a version of the binary is fetched from, with VERSION_PLACEHOLDER standing where the
   *  version goes. Filled in here, so the address and the pin can never state two versions. */
  downloadUrl: string;
  /** The clone address of the installation repository carrying `ansiwise.yaml` and
   *  `ansiwise/programs/` — the CATALOGUE, which is not the platform repository. */
  catalogUrl: string;
  /** The credential that repository is read with, absent for a public one. */
  catalogToken?: string | undefined;
  /** The clone address of the platform repository — the MATERIAL the programs act on. */
  repoUrl: string;
  /** The branch the platform checkout is stood on: the machine's install branch. */
  branch: string;
  /** The account the two checkouts are handed to — the one every later act reaches the machine as. */
  user: string;
  /** The credential that raises the placement's commands to root. */
  elevationPassword: string;
  /** The address the resident surface is to stand on, `<a.b.c.d>:<port>` — the machine's tailnet
   *  address and the port the caller will dial it on. Absent says the caller is placing onto a
   *  machine that has no such address yet, and the unit is then neither written nor asked about;
   *  stated says the placement leaves ANSIWISE_SERVICE_UNIT enabled, running and starting THIS
   *  version on THIS address, or refuses. */
  listen?: string | undefined;
}

/** What the placement answers: the version the machine now carries, read off the machine, whether
 *  this run of it had anything to place, and — where the request stated an address — that the
 *  service is enabled, running and starting that version on that address, read off the machine the
 *  same way. */
export interface PlacementVerdict {
  version: string;
  placed: boolean;
  service?: boolean;
}

/** Give the machine the binary, the catalogue, the tree the programs act on and — where the request
 *  states an address for it — the resident service, at the version the request pins, and place
 *  nothing that already stands. */
export async function placeAnsiwise(machine: PlacementMachine, req: PlacementRequest): Promise<PlacementVerdict> {
  const { version } = req;
  const downloadUrl = req.downloadUrl.split(VERSION_PLACEHOLDER).join(version);

  // WHAT A STANDING UNIT WOULD HAVE TO SAY for this run to leave it alone: the version being placed
  // and the address being stated. Undefined is a request that states no service at all.
  const want = req.listen === undefined ? undefined : { version, listen: req.listen };
  const before = await probe(machine, "place-probe");
  const place = {
    commands: before.missingCommands.length > 0,
    binary: before.binary !== version,
    catalog: !before.catalog,
    platform: !before.platform,
    service: want !== undefined && !standing(before, want),
  };
  if (!place.commands && !place.binary && !place.catalog && !place.platform && !place.service) {
    assertPrograms(before, req.catalogUrl);
    machine.log(`${machine.name} already carries ansiwise ${version}, the catalogue at ${CATALOG_CHECKOUT}, the checkout at ${PLATFORM_CHECKOUT}${want !== undefined ? ` and ${ANSIWISE_SERVICE_UNIT} ${describeUnit(before)}` : ""} — nothing to place`);
    return { version, placed: false, ...(want !== undefined ? { service: true } : {}) };
  }
  machine.log(
    `placing on ${machine.name}: ${[
      place.commands ? `the commands it is missing (${before.missingCommands.join(", ")})` : undefined,
      place.binary ? `ansiwise ${version} (it carries ${before.binary ?? "none"})` : undefined,
      place.catalog ? `the catalogue at ${CATALOG_CHECKOUT} from ${req.catalogUrl} on ${CATALOG_BRANCH}` : undefined,
      place.platform ? `the checkout at ${PLATFORM_CHECKOUT} from ${req.repoUrl} on ${req.branch}` : undefined,
      place.service ? `${ANSIWISE_SERVICE_UNIT} starting ansiwise ${version} on ${req.listen ?? ""}, by running install-service out of ${CATALOG_CHECKOUT} (it is ${describeUnit(before)})` : undefined,
    ].filter((s) => s !== undefined).join(", ")}`);

  const composed = placement({
    version, downloadUrl, repoUrl: req.repoUrl, branch: req.branch, catalogUrl: req.catalogUrl,
    ...(req.catalogToken !== undefined ? { catalogToken: req.catalogToken } : {}),
    ...(req.listen !== undefined ? { listen: req.listen } : {}),
    elevationPassword: req.elevationPassword, user: req.user, place,
  });
  const cap = await machine.runScript("place-ansiwise", composed.script, {
    timeoutMs: PLACE_ANSIWISE_TIMEOUT_MS,
    stdin: composed.stdin,
  });
  // The two the service part refuses on its own, each named where the machine is put right rather
  // than left inside "the command that failed". The token file is the one thing install-service
  // cannot invent: a machine that has not been through the run minting it has no surface to install.
  if (cap.stdout.includes("NO_SERVICE_TOKEN")) {
    throw errValidation(
      `${machine.name} carries no ${SERVICE_TOKEN_FILE}, and it is the whole authentication of the resident surface — ` +
      "the deploy-gitops program's file_from_vault row writes it out of the entry it mints at <stage>/manager-host/ansiwise. " +
      `Run deploy-gitops on ${machine.name} first, then enable the service again`,
    );
  }
  if (cap.stdout.includes("MALFORMED_SERVICE_TOKEN")) {
    throw errValidation(
      `${SERVICE_TOKEN_FILE} on ${machine.name} does not hold a token — it is empty, or it carries something that is not ` +
      "one. Delete it together with the <stage>/manager-host/ansiwise entry and run deploy-gitops again, which mints a " +
      "fresh one; a service installed with what stands there now would present it to nobody",
    );
  }
  if (cap.code !== 0 || !cap.stdout.includes("PLACED")) {
    throw errValidation(
      `could not place ansiwise ${version}, the catalogue and the checkout on ${machine.name} (exit ${cap.code}) — ` +
      "read what the machine wrote for the command that failed; a clone it was not allowed to read is what a private " +
      "catalogue with no credential looks like. Fix the machine or the address, then place again",
    );
  }

  // The verdict, read off the machine a second time rather than off the script that just wrote to
  // it: a download that fetched an error page installs and exits zero.
  const after = await probe(machine, "place-verify");
  if (after.binary !== version) {
    throw errValidation(
      `${ANSIWISE_BINARY_LINK} on ${machine.name} points at ${after.binary ?? "nothing"} after the placement, not at ` +
      `the pinned ${version} — the fetched file is not what ${downloadUrl} was expected to serve`,
    );
  }
  if (!after.catalog) {
    throw errValidation(`${CATALOG_CHECKOUT} on ${machine.name} is still not a checkout after the clone — read what the clone wrote`);
  }
  if (!after.platform) {
    throw errValidation(`${PLATFORM_CHECKOUT} on ${machine.name} is still not a checkout after the clone — read what the clone wrote`);
  }
  assertPrograms(after, req.catalogUrl);
  // The service is read off the machine for the same reason the binary is: install-service can write
  // the unit, enable it and exit zero, and the service manager then refuse to start it — a bind to
  // an address the machine does not hold, a token file it cannot read. What a caller is told is what
  // the service manager says, and never what the installer claimed.
  if (want !== undefined && !standing(after, want)) {
    throw errValidation(
      `${ANSIWISE_SERVICE_UNIT} on ${machine.name} is ${describeUnit(after)} after install-service was run — the machine ` +
      `is not serving ansiwise ${want.version} on ${want.listen}. Read \`systemctl status ${ANSIWISE_SERVICE_UNIT}\` ` +
      `and \`journalctl -u ${ANSIWISE_SERVICE_UNIT}\` on ${machine.name}`,
    );
  }
  machine.log(`${machine.name} carries ansiwise ${version} (${ANSIWISE_BINARY_LINK}), the catalogue at ${CATALOG_CHECKOUT} on ${CATALOG_BRANCH} and the checkout at ${PLATFORM_CHECKOUT} on ${req.branch}${want !== undefined ? `, and ${ANSIWISE_SERVICE_UNIT} is ${describeUnit(after)}` : ""} — ANSIWISE_SERVE_COMMAND has to serve its programs out of ${CATALOG_CHECKOUT}`);
  return { version, placed: true, ...(want !== undefined ? { service: true } : {}) };
}

/** Whether the machine is left the way a stated service asks for it, in all four of the facts the
 *  probe reads: ENABLED, so a restart brings it back; RUNNING, so it answers now; and STARTING the
 *  version this is placing at the address this was told to stand on, because those two are what the
 *  unit's own command names and neither of them follows from the other two. A machine whose binary
 *  moved under a unit nobody re-installed is enabled and running and starts the file the previous
 *  placement wrote, and a machine that rejoined the tailnet at a fresh address (digita-deploy
 *  ansiwise/programs/tailnet-rejoin.yaml hands the host a new one) is enabled and running and bound
 *  to the address it used to hold. Any of the four short is a re-installation, not a report. */
function standing(state: MachinePlacement, want: { version: string; listen: string }): boolean {
  return state.service.enabled && state.service.active
    && state.service.version === want.version && state.service.listen === want.listen;
}

/** The unit as the machine just described it, in the words the comparison above is made in — so a
 *  line an operator reads and the decision the placement took are the same four facts. */
function describeUnit(state: MachinePlacement): string {
  const { enabled, active, version, listen } = state.service;
  if (version === undefined) return "a unit the service manager does not know";
  return `${enabled ? "enabled" : "NOT enabled"} and ${active ? "running" : "NOT running"}, ` +
    `starting ansiwise ${version} on ${listen ?? "an address its command does not name"}`;
}

async function probe(machine: PlacementMachine, name: string): Promise<MachinePlacement> {
  const cap = await machine.runScript(name, probeScript(), { timeoutMs: PROBE_TIMEOUT_MS });
  return parseProbe(cap.stdout);
}

/** The catalogue is the program FILES, not the checkout that holds them: a machine carrying none of
 *  them leaves every later step starting a program by a name nothing declares. A checkout that
 *  stands there and carries no `ansiwise/programs` is a checkout of the wrong repository, and it is
 *  refused rather than cloned over — replacing a tree somebody put there is not this act's to do.
 *
 *  THE ADDRESS IN FORCE is what the refusal names, and it names it as the address, not as where the
 *  tree came from: this runs on the no-op path too (the probe found the checkout standing, and this
 *  placement cloned nothing), so a refusal saying the tree WAS CLONED FROM that address would state
 *  a history it cannot know. Which setting carried the address is the caller's own —
 *  ANSIWISE_CATALOG_URL in this manager — and the value is true for every caller. */
function assertPrograms(state: MachinePlacement, catalogUrl: string): void {
  if (state.programs) return;
  throw errValidation(
    `${CATALOG_CHECKOUT} on the machine carries no ansiwise/programs — the catalogue address in force is ${catalogUrl}, and the ` +
    "catalogue is the repository holding ansiwise.yaml and ansiwise/programs/. Point the catalogue address at that " +
    `repository, or take ${CATALOG_CHECKOUT} off the machine so it is cloned again`,
  );
}
