import { z } from "zod";
import type { RunDefinition } from "../../../executor/types.ts";
import { tailnetPlan, tailnetSteps, type TailnetPorts } from "./tailnet.kit.ts";

// The three tailnet repair run kinds. Each is a run like every other: a plan, an approval, steps and a
// log — and each reaches its host on the PUBLIC address, because an act that takes a host off the
// private network, or puts it back, cannot travel over that network. Each act is a PROGRAM of the
// machine's own catalogue (digita-deploy ansiwise/programs/), driven over the machine's
// `ansiwise-rest serve` surface; the shared steps and the plan live in tailnet.kit.ts, and what stands
// here is the one thing that must be written out per run kind, its own `kind` literal (the source
// census in registry-census.test.ts reads exactly that field).
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
//                       the logout, the join and the certificate work in one machine run.
//
// All three are `mutating`, so the executor pins attest-target as step 0 and makes it
// unskippable: the public address is the one most likely to have been handed to a different
// machine, so every one of them proves the box answering it is the box that was adopted before it
// changes anything on it.

export const TailnetParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type TailnetParams = z.infer<typeof TailnetParams>;

export function makeTailnetDisconnectDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "tailnet-disconnect",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("tailnet-disconnect", params.serverId, db, ports),
    steps: (params) => tailnetSteps("tailnet-disconnect", params.serverId, ports),
  };
}

export function makeTailnetReconnectDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "tailnet-reconnect",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("tailnet-reconnect", params.serverId, db, ports),
    steps: (params) => tailnetSteps("tailnet-reconnect", params.serverId, ports),
  };
}

export function makeTailnetRejoinDef(ports: TailnetPorts): RunDefinition<TailnetParams> {
  return {
    kind: "tailnet-rejoin",
    paramsSchema: TailnetParams,
    mutating: true,
    plan: async (params, { db }) => tailnetPlan("tailnet-rejoin", params.serverId, db, ports),
    steps: (params) => tailnetSteps("tailnet-rejoin", params.serverId, ports),
  };
}
