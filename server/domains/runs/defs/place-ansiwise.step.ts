import type { Step, StepCtx } from "../../../executor/types.ts";
import type { servers } from "../../../db/schema/inventory.ts";
import { errNotConfigured, errValidation } from "../../../kernel/errors.ts";
import { readAnsiwisePin } from "../../inventory/ansiwise-pin.ts";
import { loadServer, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { requireElevationPassword, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import {
  placeAnsiwise, installAnsiwiseService, isServiceAddress, assertWord,
  VERSION_PLACEHOLDER, NAME_PLACEHOLDER, ANSIWISE_SERVICE_PORT,
  type PlacementMachine, type BootstrapVerdict,
} from "./place-ansiwise.ts";
import type { ReleaseDownloads } from "../../../adapters/downloads/port.ts";

// The manager's half of the BOOTSTRAP: the two steps deploy-slave and redeploy run, and the
// resolution only a manager can do. The bootstrap itself (place-ansiwise.ts) takes a machine and
// values and holds no run, no database and no session; what stands here is where those values come
// from in THIS manager — the pin off platform/versions.yaml, the release address off the
// installation's settings, the service address off the server row — and how a run's cached SSH
// session satisfies the four things a placement asks of a machine.
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
 *  at the version platform/versions.yaml pins, written over SFTP and nothing else done to the
 *  machine at all. The bootstrap itself (place-ansiwise.ts) takes a machine and values and is the
 *  same act wherever a machine is reached from; what stands here is the half only a manager can do —
 *  resolving a run into those values. The version comes off platform/versions.yaml on the trunk and
 *  the address off the installation's settings, each refused BY NAME while nothing has been asked of
 *  the machine yet.
 *
 *  WHAT THIS STEP NO LONGER PLACES is written out in place-ansiwise.ts, with where each of them went:
 *  the packages are deploy-host's `install_packages` row, the catalogue checkout is deploy-platform-services's
 *  `git_clone` row, and the material checkout at PLATFORM_CHECKOUT is declared by no program yet. A
 *  machine that reaches the first program step without a catalogue is answered by that step, in the
 *  words of a binary that finds no program of that name — which is a better sentence than any this
 *  step could invent about a tree it no longer touches.
 *
 *  A machine at its FIRST installation stands in no server row, so it cannot start THIS step. Keeping
 *  the resolution out here is what makes the bootstrap itself demand nothing such a machine cannot
 *  state — the shape a first-install placement would have to satisfy, not one that runs. */
export function placeAnsiwiseStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-ansiwise",
    title: "Place both ansiwise executables on the machine, at the pinned version",
    run: async (ctx) => {
      const server = loadServer(ctx.db, target.serverId);
      const verdict = await runBootstrap(ctx, ports, server);
      ctx.checkpoint(verdict);
    },
  };
}

/** `enable-ansiwise-service` — the machine's own resident surface, switched on once it has the two
 *  facts a bare one has not got: an address in the tailnet to stand on, and the token file
 *  deploy-platform-services wrote. It composes no unit and no command inside one: `installAnsiwiseService`
 *  invokes `ansiwise-rest install-service`, which is the one thing that knows what a unit has to
 *  carry (place-ansiwise.ts, THE UNIT IS NOT COMPOSED HERE).
 *
 *  THE BOOTSTRAP RUNS AGAIN FIRST, and it is the same call the step above makes. On a machine the
 *  first step already placed it measures both executables, finds the pin, and transfers nothing — so
 *  what this costs is two questions. What it BUYS is the one fact the service placement cannot get
 *  anywhere else: whether the executable under the unit was replaced in this run, which is what
 *  decides the restart. A service keeps the inode it started from, so a machine whose file was just
 *  replaced serves the old code with the new file answering the new version beside it.
 *
 *  WHY IT IS A SECOND STEP AND NOT THE FIRST ONE, and the reason is about the MACHINE and not about
 *  the row. A machine cannot bind an address it does not hold, and it holds no tailnet address until
 *  the rejoin above put it on the network; the binary refuses every other one (`--listen` outside
 *  100.64.0.0/10). Nothing about the ROW changes in between: `tailnetHost` is typed on the inventory
 *  row when the server is created and is never probed (inventory/write.ts, "Stated here, never
 *  probed"), and `read-membership` writes `tailnetState` and `tailnetJson` and nothing else
 *  (runs/tailnet-probe.ts `recordTailnetReading`).
 *
 *  THE ADDRESS IS THE ONE THE MANAGER WILL DIAL, stated here and bound there: the server row's
 *  tailnetHost with ANSIWISE_SERVICE_PORT after it, which is exactly what an `{ kind: "address" }`
 *  wire (adapters/ansiwise/port.ts) is opened on. Reading it off the machine instead would make the
 *  address the service stands on and the address the manager dials two readings of one value. What
 *  the placement DOES read off the machine is the address the standing unit already starts on, and it
 *  reads it to find out whether it has to install again — never to decide where the surface goes. */
export function enableAnsiwiseServiceStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "enable-ansiwise-service",
    title: "Enable the machine's own ansiwise service, so the surface outlives the session",
    run: async (ctx) => {
      const server = loadServer(ctx.db, target.serverId);
      if (!server.tailnetHost) {
        throw errValidation(
          `server ${server.name} carries no tailnet address, and the resident ansiwise service may stand on no other ` +
          "one — the manager presents its token in a plain HTTP header. tailnetHost is TYPED on the inventory row when " +
          "the server is created and no run ever writes it, so re-running the join or the membership reading cannot " +
          `fill it: put ${server.name}'s address in 100.64.0.0/10 on its row, then start this again`,
        );
      }
      // The shape, refused HERE because this is where the field is, and the field carries none of its
      // own: tailnetHost is `z.string().min(1)` (inventory/write.ts) and its other reader takes a
      // name (`mark-slave` below, an apiHost). The binary reads this one as four numbers, so a
      // MagicDNS name is legal on the row and refused on the machine — and the operator is told which
      // of the two he wrote.
      const listen = `${server.tailnetHost}:${ANSIWISE_SERVICE_PORT}`;
      if (!isServiceAddress(listen)) {
        throw errValidation(
          `server ${server.name} carries the tailnet address "${server.tailnetHost}", and the resident ansiwise service ` +
          "stands on four numbers or on nothing: ServiceInstallation reads the host as four numbers and refuses " +
          "everything outside 100.64.0.0/10 (ansiwise-cli lib/service_installation.dart), so a MagicDNS name is refused " +
          `on the machine after this has reached it. Put ${server.name}'s ADDRESS on its row — the cluster map's ` +
          "apiHost, which reads the same column, takes a name and is why one was accepted there",
        );
      }
      const bootstrap = await runBootstrap(ctx, ports, server);
      const placed = await installAnsiwiseService(await placementMachine(ctx, server.name), {
        version: bootstrap.version,
        listen,
        elevationPassword: requireElevationPassword(ctx),
        replaced: bootstrap.placed,
      });
      ctx.checkpoint({ ...bootstrap, service: true, installed: placed });
    },
  };
}

/** The bootstrap's manager half: the pin and the address resolved out of this installation, and the
 *  run's cached session made into the machine it reaches. Both steps call it, which is what makes the
 *  second one measure what the first one left rather than assume it. */
async function runBootstrap(
  ctx: StepCtx,
  ports: DeploySlavePorts & AnsiwisePorts,
  server: typeof servers.$inferSelect,
): Promise<BootstrapVerdict> {
  const downloads = requireDownloads(ports);
  const request = {
    version: await readAnsiwisePin(requirePlatformRepo(ports)),
    downloadUrl: requireDownloadUrl(ports),
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
