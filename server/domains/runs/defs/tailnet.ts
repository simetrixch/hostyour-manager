import { z } from "zod";
import type { RunDefinition } from "../../../executor/types.ts";
import { tailnetPlan, tailnetSteps, type TailnetPorts } from "./tailnet.kit.ts";

// The three tailnet repair run kinds and the reading beside them. Each is a run like every other: a
// plan, an approval, steps and a log — and each reaches its host on the PUBLIC address, because an
// act that takes a host off the private network, or puts it back, cannot travel over that network.
// Each act is a PROGRAM of the machine's own catalogue (hostyour-deploy ansiwise/programs/), driven
// over the machine's `ansiwise-rest serve` surface; the shared steps and the plan live in
// tailnet.kit.ts, and what stands here is the one thing that must be written out per run kind, its
// own `kind` literal (the source census in run-definitions-census.test.ts reads exactly that field).
//
// THREE ACTS, and the line between the last two is the whole reason there are three:
//
//   tailnet-disconnect  The host leaves the network and stays there. Its client keeps its node key
//                       and its coordinator, and the coordinator keeps its node — nothing is
//                       revoked anywhere. The host goes on answering on its public address, which
//                       is how the other two run kinds reach it afterwards.
//   tailnet-reconnect   Re-establish FROM THE HOST SIDE, with the credential the host already
//                       holds, against the coordinator its own prefs name. Nothing is minted, no
//                       Vault slot is written and the coordinator is asked for nothing. This is
//                       the run kind for a host that was disconnected, or whose daemon stopped.
//   tailnet-rejoin      For the case reconnect cannot answer: the credential is GONE, or the node
//                       was deleted at the coordinator. A fresh pre-auth key can only come from
//                       the coordinator, which only the master can reach, so this run kind runs on two
//                       hosts — the tailnet-mint-join-key program mints on the master (create-only,
//                       so a key that is still redeemable is handed back rather than replaced), the
//                       manager carries the credential across, and the tailnet-rejoin program does
//                       the logout, the join and the certificate work in one machine run. A MASTER
//                       target is one host doing both halves: the mint runs on it, and its join is
//                       the tailnet-rejoin program — logout, join and the certificate work
//                       work, because nothing dials a master's kube-apiserver at a tailnet address.
//
// AND THE READING, which is none of them:
//
//   tailnet-read        Asks the host's own client what it is doing and writes the answer on the
//                       server's row. It runs no program, mints nothing, touches no certificate and
//                       leaves the host exactly as it found it. Without it the only way to refresh a
//                       reading was to perform a repair — and the cheapest of the three still
//                       re-dials the client — so a master's tailnet line went stale and stayed
//                       stale, since the repairs are also the only refresh a master has. It is the
//                       tailnet family's `cluster-authorized-keys-read`.
//
// All four are `mutating`, so the executor pins attest-target as step 0 and makes it
// unskippable: the public address is the one most likely to have been handed to a different
// machine, so every one of them proves the box answering it is the box whose identity this manager
// recorded before it changes anything on it. For the read the reason is the narrower one the
// authorized-keys read states: the run writes a reading onto a server row, and a row may only be
// told about the machine it names.

export const TailnetParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type TailnetParams = z.infer<typeof TailnetParams>;

export function makeTailnetDisconnectDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "cluster-tailnet-disconnect",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("cluster-tailnet-disconnect", params.serverId, db, ports),
    steps: (params) => tailnetSteps("cluster-tailnet-disconnect", params.serverId, ports),
  };
}

export function makeTailnetReconnectDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "cluster-tailnet-reconnect",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("cluster-tailnet-reconnect", params.serverId, db, ports),
    steps: (params) => tailnetSteps("cluster-tailnet-reconnect", params.serverId, ports),
  };
}

/** The reading on its own. It takes the same ports as its siblings although it uses neither: one
 *  builder signature for the family, so registering it cannot become the place somebody decides a
 *  run kind needs less than the family does. */
export function makeTailnetReadDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "cluster-tailnet-read",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("cluster-tailnet-read", params.serverId, db, ports),
    steps: (params) => tailnetSteps("cluster-tailnet-read", params.serverId, ports),
  };
}

export function makeTailnetRejoinDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "cluster-tailnet-rejoin",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("cluster-tailnet-rejoin", params.serverId, db, ports),
    steps: (params) => tailnetSteps("cluster-tailnet-rejoin", params.serverId, ports),
  };
}
