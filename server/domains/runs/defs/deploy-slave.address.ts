import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Step } from "../../../executor/types.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx } from "../../../executor/stepkit.ts";
import { clusterShortName } from "../../inventory/cluster-marking.ts";
import { loadMaster, loadServer, type SlaveTarget } from "./deploy-slave.kit.ts";
import type { Stage } from "../../../../shared/enums.ts";

// THE ADDRESS THE MANAGER WILL DIAL, taken from the one that handed it out.
//
// `servers.tailnetHost` is where this manager opens a wire and presents its token in a plain HTTP
// header (place-ansiwise.step.ts, enableAnsiwiseServiceStep). Two things have to be true of it at
// once, and they pull in opposite directions:
//
//   it must be the address the machine ACTUALLY holds — the resident service binds it, and a
//       machine cannot bind an address it was not given;
//   it must NOT be the machine's own account of itself — the host this manager is about to trust
//       may not be the host that names where the trust goes.
//
// The coordinator satisfies both. It is a workload of the master's own cluster, it ASSIGNED the
// address, and it is not the machine being deployed. So the platform still states one value; it
// just stops asking a person for a number that does not exist yet when the person is asked.
//
// WHY NOBODY CAN TYPE IT AT SERVER-CREATION TIME. headscale 0.29.2 has no way to be told an address
// in advance — neither `preauthkeys create` (--ephemeral, --expiration, --reusable, --tags, --user)
// nor any `nodes` subcommand (approve-routes, backfillips, delete, expire, list, list-routes,
// rename, tag) takes one. The value first exists when the node registers, which happens in the
// rejoin step of the very run that then needs it.
//
// IT READS ON EVERY DEPLOYMENT, not only after a first join: a rejoin hands the machine a FRESH
// address (digita-deploy ansiwise/programs/tailnet-rejoin.yaml says so in its own head), and a row
// still carrying the previous one points everything the master does at a machine that stopped
// answering there.

/** The coordinator, addressed exactly as the catalogue addresses it — the invocation is a copy of
 *  the `headscale:` argv in digita-deploy ansiwise/programs/tailnet-mint-join-key.yaml, and the two
 *  are one spelling on purpose: a manager that reached the coordinator its own way would keep
 *  working while the program that mints against it had already broken.
 *
 *  THE STAGE IS THE TARGET'S, which is the same one the mint is answered with: the program declares
 *  a `stage` answer and composeAnswers (ansiwise-run.kit.ts) fills it from `target.resolve`. It reads
 *  as the master's stage — the coordinator is a workload of the master's cluster — and it is not,
 *  because an installation runs ONE stage and a slave is part of the installation; the mint program's
 *  own answer says so ("Which of the product's three stages this installation runs"). Taking it from
 *  anywhere else would be a second spelling that agrees until it does not. */
function coordinatorCommand(stage: Stage): string {
  return `microk8s kubectl exec -n headscale deploy/headscale-${stage}-app -- headscale`;
}

/** One node as the coordinator lists it. Only the fields this reading needs are named, and every
 *  one of them is optional: `nodes list -o json` is the coordinator's own shape and not ours, so a
 *  field that moves must surface as "the coordinator lists no address for X" and never as a crash. */
const CoordinatorNode = z.object({
  name: z.string().optional(),
  given_name: z.string().optional(),
  user: z.object({ name: z.string().optional() }).optional(),
  ip_addresses: z.array(z.string()).optional(),
});

/** The listing. NULLABLE because that is what the tool answers for an empty one — the same `null`
 *  its `users list` gives, which is an answer and not a failure. */
const CoordinatorNodes = z.array(CoordinatorNode).nullable();

type Node = z.infer<typeof CoordinatorNode>;

/** How a node is named in a refusal: the name a person sees at the coordinator, with its addresses
 *  after it, so a listing of two says which two. */
function describe(node: Node): string {
  const name = node.given_name ?? node.name ?? "(unnamed)";
  return `${name} [${(node.ip_addresses ?? []).join(", ") || "no addresses"}]`;
}

/** This machine's IPv4 among the addresses the coordinator gave it. Chosen by SHAPE and not by
 *  position: the listing happens to put IPv4 first today, and the service binds four numbers. */
function ipv4Of(node: Node): string | undefined {
  return (node.ip_addresses ?? []).find((address) => !address.includes(":"));
}

/** `declare-tailnet-address`: ask the coordinator which address it gave this slave, and put that on
 *  the slave's row.
 *
 *  It stands between the join and `enable-ansiwise-service`, and OUTSIDE the redeploy guard the
 *  rejoin sits in: a redeploy does not join again, but it is the run that has to notice a row whose
 *  address went stale — and on a machine deployed before this step existed it is the run that fills
 *  the column for the first time. */
export function declareTailnetAddressStep(target: SlaveTarget, serverId: string): Step {
  return {
    name: "declare-tailnet-address",
    title: "Declare the address the coordinator gave this machine",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, serverId);
      // The slave's name AT THE COORDINATOR — the first label of its domain, which is what the mint
      // program files its user under (`user_answer: slave_cluster_name`, derived
      // `first_dns_label_of`). Filing and reading are one name or neither works.
      const owner = clusterShortName(domain);
      const master = loadMaster(ctx.db);
      const command = `${coordinatorCommand(stage)} nodes list -o json`;

      // ON THE MASTER, because that is where the coordinator runs — this is the one reading of the
      // step, and it deliberately never touches the machine being deployed.
      const session = await ctx.ssh(master.id);
      const out: string[] = [];
      const read = await session.exec(command, {
        signal: ctx.signal,
        timeoutMs: 60_000,
        onStdout: (line) => out.push(line),
        onStderr: (line) => ctx.log("stderr", line),
      });
      if (read.code !== 0) {
        throw errValidation(
          `the coordinator's node list could not be read on the master ${master.name} (exit ${read.code}) — the ` +
          `reading runs \`${command}\`, the same invocation the catalogue's tailnet-mint-join-key uses, so a master ` +
          "whose coordinator cannot be addressed that way is what to fix",
        );
      }

      let listed: unknown;
      try {
        listed = JSON.parse(out.join("\n"));
      } catch {
        throw errValidation(
          `the coordinator answered the node list with something that is not JSON — the reading asks for \`-o json\`, ` +
          "so output that is not its own document means the invocation reached something else",
        );
      }
      const parsed = CoordinatorNodes.safeParse(listed);
      if (!parsed.success) {
        throw errValidation(
          "the coordinator's node list is not in the shape this reading knows — it is the tool's own document and " +
          "not this platform's, so a version that lists nodes differently has to be read differently",
        );
      }
      const mine = (parsed.data ?? []).filter((node) => node.user?.name === owner);

      // NO NODE. The join is what creates it, and it stands earlier in this same run — so this is a
      // machine whose registration did not land, not a row waiting to be filled in.
      if (mine.length === 0) {
        throw errValidation(
          `the coordinator lists no node owned by "${owner}", and that is the name this platform files ${server.name} ` +
          "under — the join earlier in this run is what registers it, so read that step's record rather than this one",
        );
      }
      // TWO NODES, and the manager may not pick. Its token would go to whichever it guessed, and one
      // of the two is a machine nobody meant — a registration from an earlier life of this slave, or
      // something else that joined under the same name.
      if (mine.length > 1) {
        throw errValidation(
          `the coordinator lists ${mine.length} nodes owned by "${owner}": ${mine.map(describe).join(" and ")}. This ` +
          "manager presents its token at the address on the row, so it may not choose between them — delete the node " +
          "that is not this machine at the coordinator, then run this step again",
        );
      }
      const address = ipv4Of(mine[0]!);
      if (address === undefined) {
        throw errValidation(
          `the coordinator lists ${describe(mine[0]!)} for "${owner}" but no IPv4 among its addresses — the resident ` +
          "ansiwise service binds four numbers and nothing else, so there is no address here to declare",
        );
      }

      if (server.tailnetHost === address) {
        ctx.log("meta", `${server.name} already declares ${address}, which is what the coordinator gave it — nothing to write`);
        ctx.checkpoint({ address, written: false });
        return;
      }
      // The previous value is SAID and not silently replaced: on a rejoin this is the moment the old
      // address stops being the one anything should dial, and that is worth reading in the log of
      // the run that changed it.
      const before = server.tailnetHost;
      localTx(ctx, (tx) => tx.update(servers).set({ tailnetHost: address }).where(eq(servers.id, serverId)).run());
      ctx.log(
        "meta",
        before === null
          ? `${server.name} now declares ${address} — the address the coordinator gave it at the join above`
          : `${server.name} now declares ${address}, replacing ${before} — the coordinator hands a fresh address at every join`,
      );
      ctx.checkpoint({ address, written: true, replaced: before });
    },
  };
}
