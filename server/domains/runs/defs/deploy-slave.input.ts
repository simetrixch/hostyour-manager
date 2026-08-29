import type { Step, StepCtx, Cleanup } from "../../../executor/types.ts";
import { errValidation, errNotConfigured } from "../../../kernel/errors.ts";
import { registerSecret } from "../../../security/redact.ts";
import { resolveClusterMarking } from "../../inventory/cluster-marking.ts";
import type { AnsiwisePorts } from "./ansiwise-run.kit.ts";
import { requirePlatformRepo, type SlaveTarget, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { inputFile } from "./machine-state.ts";

// THE TWO VALUES A CLUSTER THAT KEEPS NO BOOKS STILL READS, put there for the length of the run.
//
// secrets/secrets.<stage> is the one hand-filled input of an installation. It is gitignored, so it
// cannot travel on a branch, and it is written by deploy-branch and regenerate-branch — the branch
// programs of the cluster that keeps the books — and by nothing else. Everything seeded out of it
// into the secret store belongs to that cluster and now says so (books_here_in_config, in the
// catalogue's deploy-platform-services).
//
// TWO ROWS ARE THE EXCEPTION, and gating them the same way would be wrong because a cluster keeping
// no books genuinely needs both:
//
//   write_containerd_registry_mirror   REGISTRY_PULL_DOCKERCONFIGJSON   (deploy-cluster)
//       a cluster pulls its images through the installation's own registry. Without the credential
//       that step reports itself SATISFIED and writes no mirror at all, so the machine quietly
//       pulls from docker.io instead — a degradation nothing reports.
//   git_clone /srv/ansiwise-catalog    CATALOG_REPO_READ_PAT            (deploy-platform-services)
//       every machine runs its programs out of the catalogue, so every machine has to be able to
//       clone it. That step refuses by file and key rather than cloning nothing.
//
// NEITHER VALUE IS COPIED OFF ANOTHER MACHINE. Both are already this manager's own: the catalogue
// credential is what it clones a catalogue with when a machine carries none (catalogueOrigin), and
// the pull document is the mounted manager-registry-pull its own image is pulled with, templated in
// the manager chart against the installation's registry address. So no session reads another
// cluster's secrets file, and the file written here is composed rather than transported.
//
// AND IT DOES NOT STAY. The machine holds it while the two programs that read it run, and drop-input
// takes it away again; a run that dies in between takes it away through the cleanup this step arms.
// A cluster that keeps no books is not a cluster that carries an installation's input.

/** The keys placed, in the order they are written. */
export const KEYS_A_SLAVE_READS = ["REGISTRY_PULL_DOCKERCONFIGJSON", "CATALOG_REPO_READ_PAT"] as const;

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
    "# The two values a cluster that keeps no books still reads: the right to pull this",
    "# installation's images through its own registry, and the right to clone the catalogue this",
    "# machine runs its programs out of. Both are the manager's own — nothing here was copied off",
    "# the cluster that keeps the books, and everything else that stands in ITS file stays there.",
    "#",
    "# Do not add a value here. This file is rewritten by every deployment of this cluster and",
    "# removed after it; the file a value belongs in is the one on the books-keeping cluster.",
    ...lines,
    "",
  ].join(nl);
}

/** What the machine already holds, or the empty string. Captured WITHOUT ctx.log and registered
 *  with the redactor: a machine mid-run carries the same two values this step is about to write. */
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

/** The compensating action of the placement, resolved by NAME on an abort — so it derives the path
 *  from the run's own answers rather than closing over one: the executor rebuilds a cleanup out of
 *  the persisted name, and a closure would not survive that. */
export const dropInputCleanup: Cleanup = {
  name: "drop-input",
  title: "Take the placed values off the machine",
  run: async (ctx: StepCtx) => {
    await removeInput(ctx, inputFile(String(ctx.params.stage)));
  },
};

/** `place-input`: compose the two values out of what this manager holds and put them on the machine.
 *
 *  It stands after the checkout refresh and before deploy-cluster, because the first row that reads
 *  one of them is that program's containerd mirror. The refresh cannot undo it — that script
 *  fetches, resets and checks out, and none of those touches an ignored file. */
export function placeInputStep(target: SlaveTarget, ports: DeploySlavePorts & AnsiwisePorts): Step {
  return {
    name: "place-input",
    title: "Put the two values this machine reads where its programs read them",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const path = inputFile(stage);
      if (ports.catalogueOrigin === undefined || ports.pullConfiguration === undefined) {
        throw errNotConfigured(
          "this manager holds neither a catalogue credential nor its own pull configuration, and a cluster that keeps " +
          "no books reads both off its machine — set CATALOG_REPO/CATALOG_TOKEN, and give the manager the mounted " +
          "manager-registry-pull dockerconfigjson its own chart already declares",
        );
      }
      const pull = await ports.pullConfiguration(await registryHostOf(ports, domain));
      const lines = [
        `REGISTRY_PULL_DOCKERCONFIGJSON="${pull}"`,
        `CATALOG_REPO_READ_PAT="${ports.catalogueOrigin.token}"`,
      ];
      for (const line of lines) registerSecret(ctx.runId, Buffer.from(line, "utf8"));
      registerSecret(ctx.runId, Buffer.from(pull, "utf8"));
      registerSecret(ctx.runId, Buffer.from(ports.catalogueOrigin.token, "utf8"));

      // ARMED BEFORE THE WRITE, so a run that dies at the next step does not leave it standing.
      ctx.registerCleanup(dropInputCleanup);
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
 *  A STEP AND NOT ONLY THE CLEANUP ABOVE, because the cleanup runs when a run FAILS and this is the
 *  ordinary end: the file's whole life is then visible in the run's own step list, which is where
 *  somebody looks to ask whether it is still there. */
export function dropInputStep(target: SlaveTarget): Step {
  return {
    name: "drop-input",
    title: "Take those two values off the machine again",
    run: async (ctx) => {
      const { stage } = target.resolve(ctx.db);
      const path = inputFile(stage);
      await removeInput(ctx, path);
      ctx.log("meta", `${path} removed — the programs that read it have run`);
      ctx.checkpoint({ path, removed: true });
    },
  };
}
