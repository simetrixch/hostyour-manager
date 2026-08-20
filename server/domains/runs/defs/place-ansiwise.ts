import { errValidation } from "../../../kernel/errors.ts";
import { PRODUCT_BRANCH } from "../../../../shared/branches.ts";

// `place-ansiwise` — what a machine has to carry before anything else can speak to it at all. Every
// program act goes through `ansiwise serve` over a session (ansiwise-run.kit.ts), and that command
// is a binary reading a catalogue of program files out of a checkout: a machine that carries neither
// answers nothing, and the first program dies with a shell error.
//
// THREE PLACEMENTS, ONE MECHANISM, and they belong together because none of them is worth anything
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
//
// THE CATALOGUE AND THE MATERIAL ARE TWO REPOSITORIES, and the first version of this placement
// asserted they were one. `hostyour-cloud/platform/versions.yaml:22-24` names the two trees:
// `platform` is that repository, `deploy` is "the installation repository carrying the ansiwise
// programs". `ls ansiwise` in a hostyour-cloud checkout answers nothing, so a placement that cloned
// only the platform repo and then looked for programs in it refused on every real machine.
//
// WHERE THE CATALOGUE STANDS is CATALOG_CHECKOUT, and that path is the machine's own, not this
// module's invention: digita-deploy `ansiwise/programs/deploy-gitops.yaml:1258-1268` clones that same
// repository to that same path once the machine has a secret store, and `:1315-1316` states that
// the resident deployment service is given `--programs /srv/ansiwise-catalog/ansiwise/programs` out
// of it. This is the FIRST placement, before any of that exists, and it puts the checkout where
// those rows will find it.
//
// PROBE, PLACE, PROBE AGAIN. The mechanism measures the machine first and places only what is
// missing — which is what makes a second run a no-op rather than a re-installation — and then
// measures again and reads its verdict off THAT, never off the placing script's own claim. A
// placement that reported success without looking would report it just as happily when curl wrote an
// error page into the file it installed.
//
// IT TAKES A MACHINE AND VALUES, AND NOTHING ONLY A MANAGER HAS. `placeAnsiwise` takes a
// PlacementMachine — a name, a way to run a script on it, somewhere to write a line an operator
// reads — and a PlacementRequest of plain values: the pinned version, the three addresses, the
// install branch, the account and the elevation password. It opens no session, reads no database and
// carries no run context.
//
// ONE CALLER CALLS IT, and it is this manager's `placeAnsiwiseStep` (deploy-slave.ts:189), which
// resolves those values out of the cluster row, the server row, platform/versions.yaml and the
// installation's settings. A machine at its FIRST installation stands in no such row, so it cannot
// start that step, and no other FIRST placement exists for it: the machine's own clone of the
// catalogue (deploy-gitops.yaml:1258-1268, above) runs long afterwards, on a machine that already
// carries all three. What the two interfaces below are for is the SHAPE such a placement has to
// satisfy, written down where it can be read: a machine that runs a script and takes a line, and
// values a caller states without a table to read them out of. It is a demand on whatever places
// next, not a second caller that is there.

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
  return {
    binary: binary === undefined || binary === "absent" ? undefined : binary,
    platform: lines.includes("PLATFORM present"),
    catalog: lines.includes("CATALOG present"),
    programs: lines.includes("PROGRAMS present"),
    missingCommands: lines.filter((l) => l.startsWith("MISSING ")).map((l) => l.slice("MISSING ".length)),
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
  /** What the probe found missing. Nothing that stands is touched. */
  place: { commands: boolean; binary: boolean; platform: boolean; catalog: boolean };
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
  const withToken = carriesCatalogToken(o);
  if (withToken) assertSecretLine(o.catalogToken ?? "", "catalogue credential");
  const parts = [`#!/usr/bin/env bash
set -euo pipefail`];
  if (withToken) {
    parts.push(`IFS= read -r ANSIWISE_CATALOG_TOKEN
export ANSIWISE_CATALOG_TOKEN`);
  }
  parts.push("sudo -S -p '' -v");
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

/** The same guard for a value that may not be shown: a credential rides ONE line of the placement's
 *  standard input, and a refusal that quoted it would put it in the run log. */
function assertSecretLine(value: string, what: string): void {
  if (!SECRET_LINE_RE.test(value)) {
    throw errValidation(`the ${what} carries a line break or is empty — it rides one line of the placement's standard input`);
  }
}

/** THE MACHINE, as the placement sees it: a name to call it by in what an operator reads, a way to
 *  run a script on it and read back everything it wrote, and somewhere to put a line. Nothing else —
 *  the one caller there is (deploy-slave.ts:207) satisfies these three out of a run's cached session and a server row
 *  (deploy-slave.ts:207), and these three are the whole of what placing from anywhere else would
 *  have to supply. */
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
}

/** What the placement answers: the version the machine now carries, read off the machine, and
 *  whether this run of it had anything to place. */
export interface PlacementVerdict {
  version: string;
  placed: boolean;
}

/** Give the machine the binary, the catalogue and the tree the programs act on, at the version the
 *  request pins, and place nothing that already stands. */
export async function placeAnsiwise(machine: PlacementMachine, req: PlacementRequest): Promise<PlacementVerdict> {
  const { version } = req;
  const downloadUrl = req.downloadUrl.split(VERSION_PLACEHOLDER).join(version);

  const before = await probe(machine, "place-probe");
  const place = {
    commands: before.missingCommands.length > 0,
    binary: before.binary !== version,
    catalog: !before.catalog,
    platform: !before.platform,
  };
  if (!place.commands && !place.binary && !place.catalog && !place.platform) {
    assertPrograms(before, req.catalogUrl);
    machine.log(`${machine.name} already carries ansiwise ${version}, the catalogue at ${CATALOG_CHECKOUT} and the checkout at ${PLATFORM_CHECKOUT} — nothing to place`);
    return { version, placed: false };
  }
  machine.log(
    `placing on ${machine.name}: ${[
      place.commands ? `the commands it is missing (${before.missingCommands.join(", ")})` : undefined,
      place.binary ? `ansiwise ${version} (it carries ${before.binary ?? "none"})` : undefined,
      place.catalog ? `the catalogue at ${CATALOG_CHECKOUT} from ${req.catalogUrl} on ${CATALOG_BRANCH}` : undefined,
      place.platform ? `the checkout at ${PLATFORM_CHECKOUT} from ${req.repoUrl} on ${req.branch}` : undefined,
    ].filter((s) => s !== undefined).join(", ")}`);

  const composed = placement({
    version, downloadUrl, repoUrl: req.repoUrl, branch: req.branch, catalogUrl: req.catalogUrl,
    ...(req.catalogToken !== undefined ? { catalogToken: req.catalogToken } : {}),
    elevationPassword: req.elevationPassword, user: req.user, place,
  });
  const cap = await machine.runScript("place-ansiwise", composed.script, {
    timeoutMs: PLACE_ANSIWISE_TIMEOUT_MS,
    stdin: composed.stdin,
  });
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
  machine.log(`${machine.name} carries ansiwise ${version} (${ANSIWISE_BINARY_LINK}), the catalogue at ${CATALOG_CHECKOUT} on ${CATALOG_BRANCH} and the checkout at ${PLATFORM_CHECKOUT} on ${req.branch} — ANSIWISE_SERVE_COMMAND has to serve its programs out of ${CATALOG_CHECKOUT}`);
  return { version, placed: true };
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
