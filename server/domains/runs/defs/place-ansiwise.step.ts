import type { Step, StepCtx } from "../../../executor/types.ts";
import type { servers } from "../../../db/schema/inventory.ts";
import { errNotConfigured } from "../../../kernel/errors.ts";
import { readAnsiwisePin } from "../../inventory/ansiwise-pin.ts";
import { loadServer, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { requireElevationPassword, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import {
  placeAnsiwise, assertWord, handRunRoot, VERSION_PLACEHOLDER, NAME_PLACEHOLDER,
  type PlacementMachine, type BootstrapVerdict,
} from "./place-ansiwise.ts";
import type { ReleaseDownloads } from "../../../adapters/downloads/port.ts";
import { refreshCatalogue } from "./machine-catalogue.ts";

// The manager's half of the BOOTSTRAP: the step deploy-slave, redeploy and cluster-deploy-master
// each run, and the resolution only a manager can do. The bootstrap itself (place-ansiwise.ts) takes
// a machine and values and holds no run, no database and no session; what stands here is where those
// values come from in THIS manager — the pin off clusters/platform/versions.yaml and the release
// address off the installation's settings — and how a run's cached SSH session satisfies the four
// things a placement asks of a machine.
//
// Split out of deploy-slave.ts under the file-size doctrine (files ≤400 lines), beside
// deploy-slave.mgmt.ts, deploy-slave.verify.ts and deploy-slave.attest.ts.

/** WHERE the machine's two executables are fetched from. Which release surface an installation takes
 *  them from is the installation's decision, exactly as the command that serves the programs is; the
 *  VERSION never is, and neither is WHICH of the release's two assets — the bootstrap fills both
 *  slots itself, out of the pin and out of the name it is placing. */
function requireDownloadUrl(ports: AnsiwisePorts): string {
  if (!ports.ansiwiseDownloadUrl) {
    throw errNotConfigured(
      "ANSIWISE_DOWNLOAD_URL is not configured — this step places both ansiwise executables on the machine, and where a " +
      "release of them is fetched from is the installation's decision. Set ANSIWISE_DOWNLOAD_URL to that address with " +
      `${NAME_PLACEHOLDER} standing where the executable's name goes and ${VERSION_PLACEHOLDER} where the version does, ` +
      `e.g. https://github.com/example/ansiwise-cli/releases/download/${VERSION_PLACEHOLDER}/` +
      `${NAME_PLACEHOLDER}-${VERSION_PLACEHOLDER}-linux-x64`,
    );
  }
  return ports.ansiwiseDownloadUrl;
}

/** Where the release assets are READ from, refused while nothing has been asked of the machine yet.
 *  A port and not a `fetch` in this file, for the reason every other piece of IO here is one; what
 *  makes it required rather than optional is that a bootstrap with nowhere to read from places
 *  nothing at all. Absent is a manager that was BUILT without one (boot/wire.ts), never a setting an
 *  operator left blank, and the refusal says so rather than sending somebody to look for a variable. */
function requireDownloads(ports: AnsiwisePorts): ReleaseDownloads {
  if (!ports.releaseDownloads) {
    throw errNotConfigured(
      "no release reader is wired into this manager — the bootstrap reads both ansiwise executables over the manager's " +
      "own network and hands them to the machine as a file transfer, so a manager built without one can place nothing " +
      "at all. That is a wiring fault in boot/wire.ts and not a setting to fill in",
    );
  }
  return ports.releaseDownloads;
}

/** `place-ansiwise` — the BOOTSTRAP on a machine reached by THIS MANAGER: both ansiwise executables,
 *  at the version clusters/platform/versions.yaml pins, written over SFTP and nothing else done to the
 *  machine at all. The bootstrap itself (place-ansiwise.ts) takes a machine and values and is the
 *  same act wherever a machine is reached from; what stands here is the half only a manager can do —
 *  resolving a run into those values. The version comes off clusters/platform/versions.yaml on the trunk and
 *  the address off the installation's settings, each refused BY NAME while nothing has been asked of
 *  the machine yet.
 *
 *  WHAT THIS STEP DOES NOT PLACE is written out in place-ansiwise.ts, with what does place each of
 *  them: the packages are deploy-host's `install_packages` row, and the platform tree is that same
 *  program's `git_clone` row, whose credential — where a repository ever needs one — is a value only
 *  such a row may hold. The CATALOGUE is this step's, both to make and to bring forward
 *  (machine-catalogue.ts): the deployment programs are a public repository, so making one asks
 *  nothing of this step that bringing one forward does not.
 *
 *  A machine at its FIRST installation stands in no server row, so it cannot start THIS step. Keeping
 *  the resolution out here is what makes the bootstrap itself demand nothing such a machine cannot
 *  state — the shape a first-install placement would have to satisfy, not one that runs. */
export function placeAnsiwiseStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-ansiwise",
    title: "Place the engine at the pinned version, and bring the catalogue it is judged by with it",
    run: async (ctx) => {
      const server = loadServer(ctx.db, target.serverId);
      const verdict = await runBootstrap(ctx, ports, server);
      // The other half of making a machine speakable, and it has to happen HERE: every program this
      // manager drives runs through `ansiwise-rest` as the operator, and the first thing a run does
      // is write its own record. A program's own row keeps these directories right afterwards; it
      // cannot make them right the first time, because it is a program and the programs are what
      // cannot start.
      const handed = await handRunRoot(await placementMachine(ctx, server.name), {
        account: server.sshUser,
        elevationPassword: requireElevationPassword(ctx),
      });
      // AND THE CATALOGUE THE ENGINE IS JUDGED BY, in the same step and before any program. The
      // machine's cluster program asserts the placed engine against the version stamped into the
      // catalogue ON THE MACHINE, and the catalogue is refreshed by a row of a program that is
      // itself read out of the catalogue — so without this a pin move reaches an installed machine
      // one program after the row that asserts it. A machine carrying no catalogue is untouched,
      // which is what keeps the birth of a machine out of this: putting the row into the first
      // program a machine runs was tried and reverted, because it needs an answer the client's
      // first-master flow does not send, and nothing here asks a program for anything.
      const catalogue = await refreshCatalogue(
        await placementMachine(ctx, server.name),
        ports.catalogueOrigin === undefined
          ? undefined
          : {
              ...ports.catalogueOrigin,
              account: server.sshUser,
              elevationPassword: requireElevationPassword(ctx),
            },
      );
      ctx.checkpoint({ ...verdict, ...handed, catalogue });
    },
  };
}

/** The bootstrap's manager half: the pin and the address resolved out of this installation, and the
 *  run's cached session made into the machine it reaches. */
async function runBootstrap(
  ctx: StepCtx,
  ports: DeploySlavePorts & AnsiwisePorts,
  server: typeof servers.$inferSelect,
): Promise<BootstrapVerdict> {
  const downloads = requireDownloads(ports);
  const request = {
    version: await readAnsiwisePin(requirePlatformRepo(ports)),
    downloadUrl: requireDownloadUrl(ports),
    // What raises the copy into /usr/local/bin, where everything that asks about the engine asks.
    // Both steps that call this carry it: the run's approve requires it for the programs anyway.
    elevationPassword: requireElevationPassword(ctx),
  };
  return placeAnsiwise(
    await placementMachine(ctx, server.name),
    { read: (url) => downloads.get(url, { signal: ctx.signal }) },
    request,
  );
}

/** The run's session, as the four things a placement asks of a machine.
 *
 *  THE ARGUMENT LIST IS JOINED HERE AND NOWHERE ELSE, and every word of it has been held against
 *  place-ansiwise.ts's own guard first. That guard refuses whitespace and everything a shell reads as
 *  syntax, so what is handed to `exec` is a line whose words are exactly the words that were composed
 *  — there is no quoting here because there is nothing quotable to quote, and a quoter would be the
 *  shell composer this whole change removed. */
async function placementMachine(ctx: StepCtx, name: string): Promise<PlacementMachine> {
  const session = await ctx.ssh();
  return {
    name,
    putFile: (remotePath, content, mode) => session.putFile(remotePath, content, mode, { signal: ctx.signal }),
    run: async (argv, o) => {
      for (const word of argv) assertWord(word, "word of a command on the machine");
      const out: string[] = [];
      const result = await session.exec(argv.join(" "), {
        signal: ctx.signal,
        timeoutMs: o.timeoutMs,
        onStdout: (line) => {
          out.push(line);
          ctx.log("stdout", line);
        },
        onStderr: (line) => ctx.log("stderr", line),
        ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
      });
      return { code: result.code, stdout: out.join("\n") };
    },
    log: (line) => ctx.log("meta", line),
  };
}
