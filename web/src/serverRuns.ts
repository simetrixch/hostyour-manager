import type { RunKind } from "../../shared/enums.ts";
import type { RunView } from "../../shared/api-types.ts";

// What a server's card says about the ONE run that concerns it. Kept out of the page for the same
// reason runScreen.ts and tailnetState.ts are: vitest runs with environment "node" and includes no
// .tsx, so wording and selection left inside pages/Servers.tsx cannot be tested — and both are the
// whole substance here.

/** Non-terminal run statuses: such a run OWNS the server's next step (approve or watch it). */
export const OPEN_RUN: ReadonlyArray<RunView["status"]> = ["planning", "planned", "approved", "running"];

/** The run this server's card must surface (listRuns is newest-first): an OPEN run — a planned run
 *  waiting for approval must never be invisible — or, failing that, the most recent FAILED one
 *  (retry/skip/abort live on the run screen). */
export function relevantRun(serverId: string, runs: RunView[]): RunView | undefined {
  const own = runs.filter((r) => r.targetKind === "server" && r.targetId === serverId);
  return own.find((r) => OPEN_RUN.includes(r.status)) ?? (own[0]?.status === "failed" ? own[0] : undefined);
}

/** What a run of this kind is CALLED in the one line the card gives it. Partial on purpose: a kind
 *  with no entry reads as "<kind> run", which is right for every run kind whose own name already is a
 *  noun phrase. */
const RUN_NOUN: Partial<Record<RunKind, string>> = {
  "cluster-deploy-slave": "deployment",
  "cluster-tailnet-disconnect": "tailnet disconnect",
  "cluster-tailnet-reconnect": "tailnet reconnect",
  "cluster-tailnet-rejoin": "tailnet rejoin",
  "cluster-tailnet-read": "tailnet reading",
  "cluster-password-login-disable": "password login disable",
  "cluster-password-login-enable": "password login enable",
  "cluster-operator-key-place": "operator key placement",
  "cluster-operator-key-remove": "operator key removal",
  "cluster-authorized-keys-read": "authorized-keys reading",
};

export function runLine(run: RunView): string {
  const noun = RUN_NOUN[run.kind] ?? `${run.kind} run`;
  // "A operator key placement" is what a fixed article produces the moment a noun starts with a
  // vowel, and the noun list is open — every run kind added to RUN_NOUN chooses its own first letter.
  const a = /^[aeiou]/i.test(noun) ? "An" : "A";
  if (run.status === "planned") return `${a} ${noun} is planned — approve it`;
  if (run.status === "running") return `${a} ${noun} is running — watch it`;
  if (run.status === "failed") return `The last ${noun} failed — open it to retry`;
  return `${a} ${noun} is ${run.status}`; // planning | approved — moments from running
}
