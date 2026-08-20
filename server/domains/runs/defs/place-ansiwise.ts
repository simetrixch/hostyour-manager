import type { Step, StepCtx } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { remoteScriptCapture } from "../../../executor/stepkit.ts";
import { readAnsiwisePin } from "../../inventory/ansiwise-pin.ts";
import { requireElevationPassword, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import { loadServer, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { PLATFORM_CHECKOUT } from "./deploy-slave.remote.ts";

// `place-ansiwise` — what a machine has to carry before any other step of this manager can speak to
// it at all. Every program act goes through `ansiwise serve` over the session (ansiwise-run.kit.ts),
// and that command is a binary reading a catalogue of program files out of a checkout: a machine
// that carries neither answers nothing, and the run dies on its first program with a shell error.
//
// TWO PLACEMENTS, ONE STEP, and they belong together because neither is worth anything alone:
//
//   the BINARY     /usr/local/bin/ansiwise, at the version platform/versions.yaml pins
//                  (inventory/ansiwise-pin.ts) — never at whatever the caller happens to hold. It is
//                  installed under its version (ansiwise-<version>) with the plain name a symlink
//                  onto it, which is what makes the placed version READABLE afterwards: the binary
//                  takes no --version flag, so the name of the file the link points at is the only
//                  statement about which one is there, and it is one this step wrote itself.
//   the MATERIAL   the platform checkout at PLATFORM_CHECKOUT, cloned on the machine's install
//                  branch. Every deployment program ACTS on that tree — their `repository:` rows
//                  name the path — so a machine without it has nothing for them to work on.
//
// WHAT THIS STEP DOES NOT YET PLACE IS THE CATALOGUE ITSELF. The program files are not in the
// platform repository: hostyour-cloud/platform/versions.yaml:22-24 names `platform` as that
// repository and `deploy` as "the installation repository carrying the ansiwise programs", and
// `ls ansiwise` in a hostyour-cloud checkout answers nothing. So this step refuses a machine that
// has no catalogue rather than reporting a success whose first program would die with a shell
// error. Placing it is the open half of hostyour-manager#14.
//
// PROBE, PLACE, PROBE AGAIN. The step measures the machine first and places only what is missing —
// which is what makes a second run a no-op rather than a re-installation — and then measures again
// and reads its verdict off THAT, never off the placing script's own claim. A step that placed and
// reported success without looking would report it just as happily when curl wrote an error page
// into the file it installed.
//
// IT KNOWS NOTHING ABOUT A SLAVE. What it takes is a session, a branch and the pin, so the same step
// serves a master at its first installation — the case that has no install branch, no checkout and
// no binary either.

/** The name every caller starts, and the link this step points at the version it placed. */
export const ANSIWISE_BINARY_LINK = "/usr/local/bin/ansiwise";

/** Where the versioned binaries stand. The link above names one of them. */
const ANSIWISE_BINARY_DIR = "/usr/local/bin";

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

/** The step's wall clock. A clone of the platform repo and one package install over a cold apt
 *  cache are the two long acts in it. */
const PLACE_ANSIWISE_TIMEOUT_MS = 10 * 60_000;

/** What a value put into a remote command may look like. Everything this step composes a command
 *  from arrives from OUTSIDE this process — a version out of a file on the platform repo, a URL and
 *  a clone address out of the environment, a branch off the cluster row — so each is held against
 *  its shape before it reaches a shell. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;

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

/** The address the machine clones the platform checkout from. Built where the platform repo port is
 *  built, from the same two settings, so the tree the manager writes and the tree the machine reads
 *  are one repository stated once. */
function requirePlatformRepoUrl(ports: DeploySlavePorts): string {
  if (!ports.platformRepoUrl) {
    throw errNotConfigured(
      "the platform repo is not configured — this step clones the platform checkout onto the machine, and without it " +
      "the deployment programs have neither their catalogue nor the tree they act on. GITHUB_REPO names that repository",
    );
  }
  return ports.platformRepoUrl;
}

/** What the machine answers about itself. Three separate facts, because each is placed separately
 *  and a run that finds two of them standing must not redo the third. */
export interface MachinePlacement {
  /** The version the link points at, `unversioned` when something else stands under that name, or
   *  undefined when nothing does. */
  binary?: string | undefined;
  /** Whether PLATFORM_CHECKOUT is a git checkout. */
  catalog: boolean;
  /** Whether that checkout carries the program files. */
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
[ -d "${PLATFORM_CHECKOUT}/.git" ] && echo "CATALOG present" || echo "CATALOG absent"
[ -d "${PLATFORM_CHECKOUT}/ansiwise/programs" ] && echo "PROGRAMS present" || echo "PROGRAMS absent"
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
  /** The account the checkout is handed to — the one every later step reaches the machine as, and
   *  the one refresh-checkout fetches into it with, which it cannot do on a root-owned tree. */
  user: string;
  /** What the probe found missing. Nothing that stands is touched. */
  place: { commands: boolean; binary: boolean; catalog: boolean };
}

/** The placing script, composed of only the parts the probe asked for.
 *
 *  Root is reached by validating the elevation credential ONCE with the password on standard input
 *  and running everything after it with `sudo -n`: the password never stands in the script, which is
 *  a file on the machine's disk for as long as the step runs. */
export function placeScript(o: PlaceInput): string {
  assertShape(o.version, VERSION_RE, "version");
  assertShape(o.branch, BRANCH_RE, "branch");
  assertShape(o.user, USER_RE, "operator account");
  assertShape(o.downloadUrl, URL_RE, "download address");
  assertShape(o.repoUrl, URL_RE, "clone address");
  const parts = [`#!/usr/bin/env bash
set -euo pipefail
sudo -S -p '' -v`];
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
    parts.push(`sudo -n install -d -o "${o.user}" -g "${o.user}" "${PLATFORM_CHECKOUT}"
git clone --branch "${o.branch}" "${o.repoUrl}" "${PLATFORM_CHECKOUT}"
echo "PLACED_CATALOG $(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)"`);
  }
  parts.push('echo "PLACED"');
  return parts.join("\n") + "\n";
}

function assertShape(value: string, shape: RegExp, what: string): void {
  if (!shape.test(value)) {
    throw errValidation(`the ${what} "${value}" is not a value this step may put into a command on the machine`);
  }
}

/** `place-ansiwise`: give the machine the binary and the catalogue every later step needs, at the
 *  pinned version, and place nothing that already stands. */
export function placeAnsiwiseStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-ansiwise",
    title: "Place the ansiwise binary and the program catalogue on the machine",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const version = await readAnsiwisePin(requirePlatformRepo(ports));
      const downloadUrl = requireDownloadUrl(ports, version);
      const repoUrl = requirePlatformRepoUrl(ports);
      const session = await ctx.ssh();

      const before = await probe(ctx, session, "place-probe");
      const place = {
        commands: before.missingCommands.length > 0,
        binary: before.binary !== version,
        catalog: !before.catalog,
      };
      if (!place.commands && !place.binary && !place.catalog) {
        assertPrograms(before, domain);
        ctx.checkpoint({ version, placed: false });
        ctx.log("meta", `${server.name} already carries ansiwise ${version} and the checkout at ${PLATFORM_CHECKOUT} — nothing to place`);
        return;
      }
      ctx.log("meta",
        `placing on ${server.name}: ${[
          place.commands ? `the commands it is missing (${before.missingCommands.join(", ")})` : undefined,
          place.binary ? `ansiwise ${version} (it carries ${before.binary ?? "none"})` : undefined,
          place.catalog ? `the checkout at ${PLATFORM_CHECKOUT} from ${repoUrl} on ${domain}` : undefined,
        ].filter((s) => s !== undefined).join(", ")}`);

      const script = placeScript({ version, downloadUrl, repoUrl, branch: domain, user: server.sshUser, place });
      const cap = await remoteScriptCapture(ctx, session, "place-ansiwise", script, {
        timeoutMs: PLACE_ANSIWISE_TIMEOUT_MS,
        stdin: Buffer.from(`${requireElevationPassword(ctx)}\n`, "utf8"),
      });
      if (cap.result.code !== 0 || !cap.stdout.includes("PLACED")) {
        throw errValidation(
          `could not place ansiwise ${version} and the checkout on ${server.name} (exit ${cap.result.code}) — ` +
          "read the run log for the command that failed, fix the machine, then retry the run",
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
        throw errValidation(`${PLATFORM_CHECKOUT} on ${server.name} is still not a checkout after the clone — read the run log`);
      }
      assertPrograms(after, domain);
      ctx.checkpoint({ version, placed: true });
      ctx.log("meta", `${server.name} carries ansiwise ${version} (${ANSIWISE_BINARY_LINK}) and the checkout at ${PLATFORM_CHECKOUT} on ${domain}`);
    },
  };
}

async function probe(ctx: StepCtx, session: SshSession, name: string): Promise<MachinePlacement> {
  const cap = await remoteScriptCapture(ctx, session, name, probeScript(), { timeoutMs: 60_000 });
  return parseProbe(cap.stdout);
}

/** The catalogue is the program FILES, not the checkout that holds them: a machine carrying none of
 *  them leaves every later step starting a program by a name nothing declares.
 *
 *  THE CATALOGUE IS NOT IN THE PLATFORM REPOSITORY, and this refusal used to say it was.
 *  `hostyour-cloud/platform/versions.yaml:22-24` names the two trees: `platform` is that repository,
 *  `deploy` is "the installation repository carrying the ansiwise programs". `ls ansiwise` in a
 *  hostyour-cloud checkout answers nothing — so the clone this step makes is the MATERIAL every
 *  program acts on (their `repository:` rows name that path) and never the catalogue they are read
 *  from.
 *
 *  Placing the catalogue is the open half of hostyour-manager#14. This refuses rather than passes,
 *  because a step that placed the binary, cloned the material and reported success would hand back a
 *  machine whose first program dies with a shell error. */
function assertPrograms(state: MachinePlacement, branch: string): void {
  if (state.programs) return;
  throw errValidation(
    "the machine carries no ansiwise/programs — " +
    `${PLATFORM_CHECKOUT} on ${branch} is the platform checkout, which is the material the programs ` +
    "act on, and the programs themselves live in the installation repository. Placing that checkout " +
    "is the open half of hostyour-manager#14: which repository it is is the installation's decision " +
    "and needs a setting of its own, the way ANSIWISE_DOWNLOAD_URL names where the binary comes from",
  );
}
