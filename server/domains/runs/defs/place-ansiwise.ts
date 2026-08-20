import type { Step, StepCtx } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { remoteScriptCapture } from "../../../executor/stepkit.ts";
import { readAnsiwisePin } from "../../inventory/ansiwise-pin.ts";
import { PRODUCT_BRANCH } from "../../../../shared/branches.ts";
import { requireElevationPassword, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import { loadServer, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { PLATFORM_CHECKOUT } from "./deploy-slave.remote.ts";

// `place-ansiwise` — what a machine has to carry before any other step of this manager can speak to
// it at all. Every program act goes through `ansiwise serve` over the session (ansiwise-run.kit.ts),
// and that command is a binary reading a catalogue of program files out of a checkout: a machine
// that carries neither answers nothing, and the run dies on its first program with a shell error.
//
// THREE PLACEMENTS, ONE STEP, and they belong together because none of them is worth anything alone:
//
//   the BINARY     /usr/local/bin/ansiwise, at the version platform/versions.yaml pins
//                  (inventory/ansiwise-pin.ts) — never at whatever the caller happens to hold. It is
//                  installed under its version (ansiwise-<version>) with the plain name a symlink
//                  onto it, which is what makes the placed version READABLE afterwards: the binary
//                  takes no --version flag, so the name of the file the link points at is the only
//                  statement about which one is there, and it is one this step wrote itself.
//   the CATALOGUE  the checkout at CATALOG_CHECKOUT, cloned from ANSIWISE_CATALOG_URL — the
//                  `ansiwise.yaml` and the `ansiwise/programs/` every later step starts a program
//                  out of by name.
//   the MATERIAL   the platform checkout at PLATFORM_CHECKOUT, cloned on the machine's install
//                  branch. Every deployment program ACTS on that tree — their `repository:` rows
//                  name the path — so a machine without it has nothing for them to work on.
//
// THE CATALOGUE AND THE MATERIAL ARE TWO REPOSITORIES, and the first version of this step asserted
// they were one. `hostyour-cloud/platform/versions.yaml:22-24` names the two trees: `platform` is
// that repository, `deploy` is "the installation repository carrying the ansiwise programs".
// `ls ansiwise` in a hostyour-cloud checkout answers nothing, so a step that cloned only the
// platform repo and then looked for programs in it refused on every real machine.
//
// WHERE THE CATALOGUE STANDS is CATALOG_CHECKOUT, and that path is the machine's own, not this
// step's invention: digita-deploy `ansiwise/programs/deploy-gitops.yaml:1258-1268` clones that same
// repository to that same path once the machine has a secret store, and `:1315-1316` states that
// the resident deployment service is given `--programs /srv/ansiwise-catalog/ansiwise/programs` out
// of it. This step is the FIRST placement,
// before any of that exists, and it puts the checkout where those rows will find it.
//
// PROBE, PLACE, PROBE AGAIN. The step measures the machine first and places only what is missing —
// which is what makes a second run a no-op rather than a re-installation — and then measures again
// and reads its verdict off THAT, never off the placing script's own claim. A step that placed and
// reported success without looking would report it just as happily when curl wrote an error page
// into the file it installed.
//
// IT TAKES A SLAVE TARGET, and the manager's tables with it. `placeAnsiwiseStep(target: SlaveTarget,
// ports)` below resolves the cluster through `target.resolve(ctx.db)` — the install branch the
// platform checkout is stood on — and reads the server row through `loadServer(ctx.db,
// target.serverId)` for the ssh user the placement elevates as; `loadServer` (deploy-slave.kit.ts)
// refuses a server id the manager does not carry. A machine at its FIRST installation stands in no
// such row, so it cannot start this step, and no other placement mechanism exists for it.
//
// WHAT COMPOSES THE PLACEMENT IS FREE OF ALL THAT: `probeScript()`, `parseProbe()` and `placement()`
// take values and return strings, touch no database and no session, so the same three placements can
// be composed wherever such a machine is reached from.

/** The name every caller starts, and the link this step points at the version it placed. */
export const ANSIWISE_BINARY_LINK = "/usr/local/bin/ansiwise";

/** Where the versioned binaries stand. The link above names one of them. */
const ANSIWISE_BINARY_DIR = "/usr/local/bin";

/** WHERE the catalogue stands on the machine: the checkout `ansiwise serve` reads its programs and
 *  its `ansiwise.yaml` from, and the path the machine's own resident service is later written with
 *  (see the header). ANSIWISE_SERVE_COMMAND is the command that starts that surface over the run's
 *  session, so an installation whose command reads a different directory serves different programs
 *  than this step placed — nothing here can check that, and the step's log states the path it wrote
 *  so the two can be compared. */
export const CATALOG_CHECKOUT = "/srv/ansiwise-catalog";

/** The branch the catalogue is taken from: the trunk, for the reason the pin is read off the trunk
 *  (inventory/ansiwise-pin.ts) — the programs are the product, and a machine at its first
 *  installation has no install branch to read them off. The machine's own later clone of the same
 *  repository names the same branch. */
const CATALOG_BRANCH = PRODUCT_BRANCH;

/** What ANSIWISE_DOWNLOAD_URL writes where the pinned version belongs. One placeholder and one
 *  source: the URL says WHERE a version is fetched from, the pin says WHICH — so the two can never
 *  state different versions. */
const VERSION_PLACEHOLDER = "<version>";

/** The commands the placement itself runs on the machine. A machine at its first installation
 *  carries neither by rule — `deploy-host` installs the full set a machine needs, and it cannot run
 *  until this step is done. */
const REQUIRED_COMMANDS = ["curl", "git"] as const;

/** The packages that carry them on the pinned distribution. */
const REQUIRED_PACKAGES = "curl ca-certificates git";

/** The step's wall clock. Two clones and one package install over a cold apt cache are the long acts
 *  in it. */
const PLACE_ANSIWISE_TIMEOUT_MS = 10 * 60_000;

/** What a value put into a remote command may look like. Everything this step composes a command
 *  from arrives from OUTSIDE this process — a version out of a file on the platform repo, two clone
 *  addresses out of the environment, a branch off the cluster row — so each is held against its
 *  shape before it reaches a shell. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
/** The credential rides one LINE of the script's standard input, so anything with a line break in it
 *  would leave the rest of that value standing where the script expects the next credential. */
const SECRET_LINE_RE = /^[^\r\n]+$/;

/** WHERE the machine fetches the pinned binary from, with the version filled in. Which release
 *  surface an installation takes its binary from is the installation's decision, exactly as the
 *  command that serves the programs is; the VERSION is never the caller's. */
function requireDownloadUrl(ports: AnsiwisePorts, version: string): string {
  if (!ports.ansiwiseDownloadUrl) {
    throw errNotConfigured(
      "ANSIWISE_DOWNLOAD_URL is not configured — this step places the ansiwise binary on the machine, and where a " +
      `version of it is fetched from is the installation's decision. Set ANSIWISE_DOWNLOAD_URL to that address with ` +
      `${VERSION_PLACEHOLDER} standing where the version goes, e.g. ` +
      `https://example.invalid/ansiwise/${VERSION_PLACEHOLDER}/ansiwise-linux-amd64`,
    );
  }
  return ports.ansiwiseDownloadUrl.split(VERSION_PLACEHOLDER).join(version);
}

/** WHICH REPOSITORY the programs come from. It is not the platform repository and cannot be derived
 *  from it — the two trees are named apart in the file that pins this platform's versions — so an
 *  installation states it, the way it states where the binary is fetched from. */
function requireCatalogUrl(ports: AnsiwisePorts): string {
  if (!ports.ansiwiseCatalogUrl) {
    throw errNotConfigured(
      "ANSIWISE_CATALOG_URL is not configured — this step places the program catalogue on the machine, and which " +
      "repository carries it is the installation's decision. It is NOT the platform repository: that one is the " +
      "material the programs act on and carries no ansiwise/ tree. Set ANSIWISE_CATALOG_URL to the clone address of " +
      "the installation repository holding ansiwise.yaml and ansiwise/programs/, e.g. " +
      "https://github.com/example/example-deploy.git",
    );
  }
  return ports.ansiwiseCatalogUrl;
}

/** The address the machine clones the platform checkout from. Built where the platform repo port is
 *  built, from the same two settings, so the tree the manager writes and the tree the machine reads
 *  are one repository stated once. */
function requirePlatformRepoUrl(ports: DeploySlavePorts): string {
  if (!ports.platformRepoUrl) {
    throw errNotConfigured(
      "the platform repo is not configured — this step clones the platform checkout onto the machine, and without it " +
      "the deployment programs have nothing to act on. GITHUB_REPO names that repository",
    );
  }
  return ports.platformRepoUrl;
}

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

/** A binary standing under the plain name that this step did not put there — its version cannot be
 *  read, so it is replaced by the pin rather than trusted. */
export const UNVERSIONED = "unversioned";

/** The read-only measurement. Runs before anything is placed and again after, so the step's verdict
 *  is a reading of the machine and not a repetition of what the placing script said it did. */
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
 *  NO CREDENTIAL STANDS IN THE SCRIPT, which is a file on the machine's disk for as long as the step
 *  runs, and none stands in a command's arguments, which are in the machine's process listing. Both
 *  ride standard input: the script reads the catalogue's credential into a variable of its own and
 *  hands it to git through git's own configuration-by-environment, and `sudo -S` reads the elevation
 *  password off the line after it and everything from there on runs `sudo -n`. */
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
    throw errValidation(`the ${what} "${value}" is not a value this step may put into a command on the machine`);
  }
}

/** The same guard for a value that may not be shown: a credential rides ONE line of the script's
 *  standard input, and a refusal that quoted it would put it in the run log. */
function assertSecretLine(value: string, what: string): void {
  if (!SECRET_LINE_RE.test(value)) {
    throw errValidation(`the ${what} carries a line break or is empty — it rides one line of the placement's standard input`);
  }
}

/** `place-ansiwise`: give the machine the binary, the catalogue and the tree the programs act on, at
 *  the pinned version, and place nothing that already stands. */
export function placeAnsiwiseStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-ansiwise",
    title: "Place the ansiwise binary and the program catalogue on the machine",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const version = await readAnsiwisePin(requirePlatformRepo(ports));
      const downloadUrl = requireDownloadUrl(ports, version);
      const catalogUrl = requireCatalogUrl(ports);
      const repoUrl = requirePlatformRepoUrl(ports);
      const session = await ctx.ssh();

      const before = await probe(ctx, session, "place-probe");
      const place = {
        commands: before.missingCommands.length > 0,
        binary: before.binary !== version,
        catalog: !before.catalog,
        platform: !before.platform,
      };
      if (!place.commands && !place.binary && !place.catalog && !place.platform) {
        assertPrograms(before, catalogUrl);
        ctx.checkpoint({ version, placed: false });
        ctx.log("meta", `${server.name} already carries ansiwise ${version}, the catalogue at ${CATALOG_CHECKOUT} and the checkout at ${PLATFORM_CHECKOUT} — nothing to place`);
        return;
      }
      ctx.log("meta",
        `placing on ${server.name}: ${[
          place.commands ? `the commands it is missing (${before.missingCommands.join(", ")})` : undefined,
          place.binary ? `ansiwise ${version} (it carries ${before.binary ?? "none"})` : undefined,
          place.catalog ? `the catalogue at ${CATALOG_CHECKOUT} from ${catalogUrl} on ${CATALOG_BRANCH}` : undefined,
          place.platform ? `the checkout at ${PLATFORM_CHECKOUT} from ${repoUrl} on ${domain}` : undefined,
        ].filter((s) => s !== undefined).join(", ")}`);

      const composed = placement({
        version, downloadUrl, repoUrl, branch: domain, catalogUrl,
        ...(ports.ansiwiseCatalogToken !== undefined ? { catalogToken: ports.ansiwiseCatalogToken } : {}),
        elevationPassword: requireElevationPassword(ctx), user: server.sshUser, place,
      });
      const cap = await remoteScriptCapture(ctx, session, "place-ansiwise", composed.script, {
        timeoutMs: PLACE_ANSIWISE_TIMEOUT_MS,
        stdin: composed.stdin,
      });
      if (cap.result.code !== 0 || !cap.stdout.includes("PLACED")) {
        throw errValidation(
          `could not place ansiwise ${version}, the catalogue and the checkout on ${server.name} (exit ${cap.result.code}) — ` +
          "read the run log for the command that failed; a clone the machine was not allowed to read is what a private " +
          "catalogue with no ANSIWISE_CATALOG_TOKEN looks like. Fix the machine or the setting, then retry the run",
        );
      }

      // The verdict, read off the machine a second time rather than off the script that just wrote to
      // it: a download that fetched an error page installs and exits zero.
      const after = await probe(ctx, session, "place-verify");
      if (after.binary !== version) {
        throw errValidation(
          `${ANSIWISE_BINARY_LINK} on ${server.name} points at ${after.binary ?? "nothing"} after the placement, not at ` +
          `the pinned ${version} — the fetched file is not what ${downloadUrl} was expected to serve`,
        );
      }
      if (!after.catalog) {
        throw errValidation(`${CATALOG_CHECKOUT} on ${server.name} is still not a checkout after the clone — read the run log`);
      }
      if (!after.platform) {
        throw errValidation(`${PLATFORM_CHECKOUT} on ${server.name} is still not a checkout after the clone — read the run log`);
      }
      assertPrograms(after, catalogUrl);
      ctx.checkpoint({ version, placed: true });
      ctx.log("meta", `${server.name} carries ansiwise ${version} (${ANSIWISE_BINARY_LINK}), the catalogue at ${CATALOG_CHECKOUT} on ${CATALOG_BRANCH} and the checkout at ${PLATFORM_CHECKOUT} on ${domain} — ANSIWISE_SERVE_COMMAND has to serve its programs out of ${CATALOG_CHECKOUT}`);
    },
  };
}

async function probe(ctx: StepCtx, session: SshSession, name: string): Promise<MachinePlacement> {
  const cap = await remoteScriptCapture(ctx, session, name, probeScript(), { timeoutMs: 60_000 });
  return parseProbe(cap.stdout);
}

/** The catalogue is the program FILES, not the checkout that holds them: a machine carrying none of
 *  them leaves every later step starting a program by a name nothing declares. A checkout that
 *  stands there and carries no `ansiwise/programs` is a checkout of the wrong repository, and it is
 *  refused rather than cloned over — replacing a tree somebody put there is not this step's to do. */
function assertPrograms(state: MachinePlacement, catalogUrl: string): void {
  if (state.programs) return;
  throw errValidation(
    `${CATALOG_CHECKOUT} on the machine carries no ansiwise/programs — ANSIWISE_CATALOG_URL names ${catalogUrl}, and ` +
    "the catalogue is the repository holding ansiwise.yaml and ansiwise/programs/. Point the setting at that " +
    `repository, or take ${CATALOG_CHECKOUT} off the machine so this step clones it again`,
  );
}
