import { z } from "zod";
import type { StepCtx } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { errValidation } from "../../../kernel/errors.ts";
import type { Stage } from "../../../../shared/enums.ts";

// TALKING TO THE PRIVATE NETWORK'S COORDINATOR, in one place.
//
// The coordinator is a workload of the cluster holding the master part, so every reading and every
// act here runs on THAT machine and never on the one being deployed. Two steps need it: the one that
// declares the address a machine was given, and the join, which has to clear what an earlier life of
// the same machine left behind.

/** The coordinator, addressed exactly as the catalogue addresses it — a copy of the `headscale:`
 *  argv in the catalogue's tailnet-mint-join-key program. The two are one spelling on purpose: a
 *  manager that reached the coordinator its own way would keep working while the program that mints
 *  against it had already broken.
 *
 *  THE STAGE IS THE TARGET'S, which is the same one the mint is answered with — the program declares
 *  a `stage` answer and composeAnswers fills it from the run's target. It reads as the master's stage
 *  and is not, because an installation runs ONE stage and a slave is part of the installation. */
export function coordinatorCommand(stage: Stage): string {
  return `microk8s kubectl exec -n headscale deploy/headscale-${stage}-app -- headscale`;
}

/** One node as the coordinator lists it. Only the fields these readings need are named, and every
 *  one is optional: the listing is the tool's own shape and not ours, so a field that moves has to
 *  surface as "the coordinator lists no address for X" and never as a crash. */
const CoordinatorNode = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().optional(),
  given_name: z.string().optional(),
  user: z.object({ name: z.string().optional() }).optional(),
  ip_addresses: z.array(z.string()).optional(),
});

/** The listing. NULLABLE because that is what the tool answers for an empty one — an answer, not a
 *  failure, and the same `null` its user listing gives. */
const CoordinatorNodes = z.array(CoordinatorNode).nullable();

export type CoordinatorNodeFacts = z.infer<typeof CoordinatorNode>;

/** How a node is named in a refusal or a log line: the name a person sees at the coordinator, with
 *  its addresses after it, so a listing of two says which two. */
export function describeNode(node: CoordinatorNodeFacts): string {
  const name = node.given_name ?? node.name ?? "(unnamed)";
  return `${name} [${(node.ip_addresses ?? []).join(", ") || "no addresses"}]`;
}

/** A machine's IPv4 among the addresses the coordinator gave it. Chosen by SHAPE and not by
 *  position: the listing happens to put IPv4 first today, and what binds the address is four
 *  numbers. */
export function ipv4Of(node: CoordinatorNodeFacts): string | undefined {
  return (node.ip_addresses ?? []).find((address) => !address.includes(":"));
}

/** Every node the coordinator lists for [owner] — the machine's name there, which is the first label
 *  of its domain and what the mint files its user under.
 *
 *  RUN ON THE MASTER, by a session the caller opened to it. */
export async function coordinatorNodesOf(
  ctx: StepCtx,
  session: SshSession,
  stage: Stage,
  owner: string,
): Promise<CoordinatorNodeFacts[]> {
  const command = `${coordinatorCommand(stage)} nodes list -o json`;
  const out: string[] = [];
  const read = await session.exec(command, {
    signal: ctx.signal,
    timeoutMs: 60_000,
    onStdout: (line) => out.push(line),
    onStderr: (line) => ctx.log("stderr", line),
  });
  if (read.code !== 0) {
    throw errValidation(
      `the coordinator's node list could not be read on the master (exit ${read.code}) — the reading runs ` +
      `\`${command}\`, the same invocation the catalogue's mint program uses, so a master whose coordinator cannot ` +
      "be addressed that way is what to fix",
    );
  }
  let listed: unknown;
  try {
    listed = JSON.parse(out.join("\n"));
  } catch {
    throw errValidation(
      "the coordinator answered the node list with something that is not JSON — the reading asks for `-o json`, so " +
      "output that is not its own document means the invocation reached something else",
    );
  }
  const parsed = CoordinatorNodes.safeParse(listed);
  if (!parsed.success) {
    throw errValidation(
      "the coordinator's node list is not in the shape this reading knows — it is the tool's own document and not " +
      "this platform's, so a version that lists nodes differently has to be read differently",
    );
  }
  return (parsed.data ?? []).filter((node) => node.user?.name === owner);
}

/** Take away every node the coordinator still lists for [owner], and say which.
 *
 *  WHY A JOIN CLEARS THEM FIRST. A machine's registration lives in the coordinator's own database on
 *  the master, so it survives anything done to the machine — a restore puts back a disk that has
 *  forgotten its node key while the coordinator still lists the node it belonged to. The join this
 *  runs before begins by DISCARDING that key (the catalogue's join programs log out first), so the
 *  node standing for the machine is about to be dead either way; what is left of it is a second node
 *  under one name, and nothing downstream may choose between two.
 *
 *  IT IS NOT A TEARDOWN. The coordinator's USER for this machine stays, with its pre-auth keys: the
 *  mint is idempotent against a standing credential, and destroying the user would mint a fresh one
 *  on every run. Only the registration goes. */
export async function dropCoordinatorNodes(
  ctx: StepCtx,
  session: SshSession,
  stage: Stage,
  owner: string,
): Promise<number> {
  const standing = await coordinatorNodesOf(ctx, session, stage, owner);
  if (standing.length === 0) {
    ctx.log("meta", `the coordinator lists no node for "${owner}" — nothing of an earlier life to clear`);
    return 0;
  }
  for (const node of standing) {
    const id = node.id;
    if (id === undefined) {
      throw errValidation(
        `the coordinator lists ${describeNode(node)} for "${owner}" without an id, and a node is taken away by id — ` +
        "so this one cannot be cleared and the join would leave two nodes under one name",
      );
    }
    const command = `${coordinatorCommand(stage)} nodes delete -i ${String(id)} --force`;
    const drop = await session.exec(command, { signal: ctx.signal, timeoutMs: 60_000, onStderr: (l) => ctx.log("stderr", l) });
    if (drop.code !== 0) {
      throw errValidation(
        `the coordinator would not take away ${describeNode(node)} for "${owner}" (exit ${drop.code}) — the join after ` +
        "this would register a second node under one name, which nothing downstream may choose between",
      );
    }
    ctx.log("meta", `took ${describeNode(node)} off the coordinator — the registration of an earlier life of ${owner}`);
  }
  return standing.length;
}
