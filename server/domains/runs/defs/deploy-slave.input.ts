import type { Step, StepCtx } from "../../../executor/types.ts";
import { errValidation, errNotConfigured } from "../../../kernel/errors.ts";
import { registerSecret } from "../../../security/redact.ts";
import { resolveClusterMarking } from "../../inventory/cluster-marking.ts";
import type { AnsiwisePorts } from "./ansiwise-run.kit.ts";
import { requirePlatformRepo, type SlaveTarget, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { inputFile } from "./machine-state.ts";

// THE VALUE A CLUSTER THAT KEEPS NO BOOKS STILL READS, put there for the length of the run.
//
// secrets/secrets.<stage> is the one hand-filled input of an installation. It is gitignored, so it
// cannot travel on a branch, and it is written by deploy-branch — the branch program of the
// cluster that keeps the books — and by nothing else. Everything seeded out of it
// into the secret store belongs to that cluster and now says so (books_here_in_answers, in the
// catalogue's deploy-platform-services).
//
// ONE ROW IS THE EXCEPTION, and gating it the same way would be wrong because a cluster keeping no
// books genuinely needs it:
//
//   write_containerd_registry_mirror   REGISTRY_PULL_DOCKERCONFIGJSON   (deploy-cluster)
//       a cluster pulls its images through the installation's own registry. Without the credential
//       that step reports itself SATISFIED and writes no mirror at all, so the machine quietly
//       pulls from docker.io instead — a degradation nothing reports.
//
// THE CATALOGUE ROW BESIDE IT NEEDS NO CREDENTIAL AND SO IS NOT ONE OF THESE.
// deploy-platform-services clones the deployment programs to /srv/ansiwise-catalog, and that
// repository is PUBLIC (kernel/config.ts, DEPLOY_PROGRAMS_REPO): what opens it is nothing, and a key
// written here for it would be a credential demanded of every installation for a repository that
// turns nobody away. A `git_clone` row naming no credential file is an open clone (ansiwise-git),
// which is the shape that row needs. The one catalogue credential this manager holds belongs to the
// TENANT catalogue, which is a different repository and is not what a machine reads its programs out
// of.
//
// THE VALUE IS NOT COPIED OFF ANOTHER MACHINE. It is already this manager's own: the mounted
// manager-registry-pull document its own image is pulled with, templated in the manager chart
// against the installation's registry address. So no session reads another cluster's secrets file,
// and the file written here is composed rather than transported.
//
// AND IT DOES NOT STAY. The machine holds it while the program that reads it runs, and drop-input
// takes it away again; a run that dies in between takes it away through the cleanup this step arms.
// A cluster that keeps no books is not a cluster that carries an installation's input.

/** The keys placed, in the order they are written. */
export const KEYS_A_SLAVE_READS = ["REGISTRY_PULL_DOCKERCONFIGJSON"] as const;

/** The registry a cluster pulls through, off its own map — `zot.<build plane>`, in the one place
 *  this installation writes it down. Read rather than composed here, so the address the mirror is
 *  written for and the address the charts pull from are one statement. */
async function registryHostOf(ports: DeploySlavePorts, domain: string): Promise<string> {
  const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
  const endpoints = marking.globalRest?.["endpoints"];
  const host = typeof endpoints === "object" && endpoints !== null
    ? (endpoints as { registry?: { host?: unknown } }).registry?.host
    : undefined;
  if (typeof host !== "string" || host.length === 0) {
    throw errValidation(
      `${domain}'s cluster map states no global.endpoints.registry.host, and that address is what this machine's ` +
      "container runtime is pointed at — the map is written by mark-slave from the master's, so a master whose own " +
      "map carries no registry endpoint is what to fix",
    );
  }
  return host;
}

/** The file placed on the machine: what it is, where it came from, why it goes away. */
function fileFor(lines: string[]): string {
  const nl = String.fromCharCode(10);
  return [
    "# PLACED BY THE MANAGER FOR THE LENGTH OF ONE RUN, and taken away at the end of it.",
    "#",
    "# The value a cluster that keeps no books still reads: the right to pull this installation's",
    "# images through its own registry. It is the manager's own — nothing here was copied off the",
    "# cluster that keeps the books, and everything else that stands in ITS file stays there.",
    "#",
    "# Do not add a value here. This file is rewritten by every deployment of this cluster and",
    "# removed after it; the file a value belongs in is the one on the books-keeping cluster.",
    ...lines,
    "",
  ].join(nl);
}

/** What the machine already holds, or the empty string. Captured WITHOUT ctx.log and registered
 *  with the redactor: a machine mid-run carries the same value this step is about to write. */
async function whatTheMachineHolds(ctx: StepCtx, path: string): Promise<string> {
  const session = await ctx.ssh();
  const lines: string[] = [];
  const read = await session.exec(`cat ${path} 2>/dev/null || true`, {
    signal: ctx.signal,
    timeoutMs: 30_000,
    onStdout: (l) => lines.push(l), // NEVER ctx.log — these are credentials
  });
  const held = read.code === 0 ? lines.join(String.fromCharCode(10)) : "";
  if (held.length > 0) registerSecret(ctx.runId, Buffer.from(held, "utf8"));
  return held;
}

/** Take the placed file away. Best-effort by design: it is 0600 in a checkout the operator account
 *  owns, the next deployment writes it again, and a run that failed for another reason must report
 *  THAT reason rather than this removal. */
async function removeInput(ctx: StepCtx, path: string): Promise<void> {
  try {
    await (await ctx.ssh()).exec(`rm -f ${path}`, { signal: ctx.signal, timeoutMs: 30_000 });
  } catch {
    // best-effort — see above
  }
}

/** `place-input`: compose the value out of what this manager holds and put it on the machine.
 *
 *  It stands after run-deploy-host and before deploy-cluster, because the row that reads it is that
 *  program's containerd mirror and deploy-host's own git_clone row is what stands the checkout it is
 *  written into on the branch. That row cannot undo it: the file is ignored by the tree
 *  (hostyour-cloud .gitignore excludes everything under secrets/ but the template), so git never
 *  sees it. */
export function placeInputStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-input",
    title: "Put the value this machine reads where its programs read it",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const path = inputFile(stage);
      if (ports.pullConfiguration === undefined) {
        throw errNotConfigured(
          "this manager holds no pull configuration of its own, and a cluster that keeps no books reads one off its " +
          "machine — give the manager the mounted manager-registry-pull dockerconfigjson its own chart already declares",
        );
      }
      const pull = await ports.pullConfiguration(await registryHostOf(ports, domain));
      const lines = [`REGISTRY_PULL_DOCKERCONFIGJSON="${pull}"`];
      for (const line of lines) registerSecret(ctx.runId, Buffer.from(line, "utf8"));
      registerSecret(ctx.runId, Buffer.from(pull, "utf8"));

      const wanted = fileFor(lines);
      if ((await whatTheMachineHolds(ctx, path)) === wanted) {
        ctx.log("meta", `${path} already carries ${KEYS_A_SLAVE_READS.join(" and ")} — nothing to write`);
        ctx.checkpoint({ path, written: false });
        return;
      }
      // 0600, the mode the books-keeper's own input carries. The checkout belongs to the operator
      // account this session connects as, so the write needs nothing raised.
      await (await ctx.ssh()).putFile(path, Buffer.from(wanted, "utf8"), 0o600, { signal: ctx.signal });
      ctx.log("meta", `${path} now carries ${KEYS_A_SLAVE_READS.join(" and ")} — placed by this manager, removed at the end of the run`);
      ctx.checkpoint({ path, written: true });
    },
  };
}

/** `drop-input`: take it away once the last program that reads it has run.
 *
 *  A STEP AND THE ONLY THING THAT REMOVES IT. A run that dies before this step leaves the file
 *  standing, and the next run of the same list overwrites it — `place-input` writes the whole file
 *  and measures what the machine holds first. So the file's whole life stands in the run's own step
 *  list, which is where somebody looks to ask whether it is still there, rather than half in a
 *  compensation an abort has to be asked for. */
export function dropInputStep(target: SlaveTarget): Step {
  return {
    name: "drop-input",
    title: "Take that value off the machine again",
    run: async (ctx) => {
      const { stage } = target.resolve(ctx.db);
      const path = inputFile(stage);
      await removeInput(ctx, path);
      ctx.log("meta", `${path} removed — the program that reads it has run`);
      ctx.checkpoint({ path, removed: true });
    },
  };
}
