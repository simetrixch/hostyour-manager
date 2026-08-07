// The TWO address questions a server card has to answer, in words: where does THIS controller open
// its SSH session, and where do the master's in-cluster components dial that machine's
// kube-apiserver. A pure module beside tailnetState.ts / runScreen.ts / relocationBand.ts, for the
// same reason those are: vitest runs with environment "node" and includes no .tsx, so wording left
// inside the page cannot be tested — and wording is the whole substance here.
//
// A server row carries three addresses and they answer those two questions. `host` and `lanHost`
// are SSH transports and nothing else. `tailnetHost` is not an SSH transport at all: it is what
// deploy-slave writes into the cluster map's apiHost field and states to the slave's own bring-up,
// so the master's per-slave ArgoCD, Vault, the shared dashboard and the Controller's per-slave kube
// client all reach the same machine at the same place.
//
// The card printed one line, built from `host`, and called it the target. That is what let a wrong
// address read as a network fault: the line named an address no session ever went to, and the one
// that was wrong was never on the screen.
import { isMasterRole } from "../../shared/enums.ts";
import type { ServerView } from "../../shared/api-types.ts";

/** Where this controller's SSH session goes, said the way the executor resolves it.
 *
 *  MIRRORS the default arm of server/executor/transport.ts, which is the authority: `lanHost` when
 *  the row carries one, `host` otherwise. The browser cannot import that module — it is server code
 *  and would drag the executor into the bundle — so the rule is restated here and pinned by this
 *  module's test. A run that asks for the public transport goes to `host` whatever the row holds;
 *  the card describes the ordinary session, and the run log is where a per-run transport is named. */
export function sshAddressLine(server: ServerView): string {
  const host = server.lanHost ?? server.host;
  return `ssh ${server.sshUser}@${host}:${server.sshPort}`;
}

/** Which address the master's in-cluster components will dial this machine's kube-apiserver on, or
 *  `null` for a machine that is never dialled.
 *
 *  A role carrying the master part has no such address and cannot be given one: install.sh refuses
 *  --api-host for `master` (the master is the one dialling) and for `master+slave` (its own root
 *  ArgoCD is its instance, so nothing dials it from outside), and no cluster map ever carries an
 *  apiHost for either. Printing a dial address there would invent a fact — on the one row every
 *  installation always has.
 *
 *  For a slave the line always names WHICH of the three addresses was taken — the fallback chain is
 *  tailnetHost -> lanHost -> host — because an operator who cannot see which arm won cannot tell a
 *  deliberate LAN slave from one whose tailnet address was never recorded. */
export function dialAddressLine(server: ServerView): string | null {
  if (isMasterRole(server.role)) return null;
  if (server.tailnetHost) return `kube-apiserver dialled on ${server.tailnetHost} (tailnet)`;
  if (server.lanHost) return `kube-apiserver dialled on ${server.lanHost} (cluster network)`;
  return `kube-apiserver dialled on ${server.host} (no internal address on file)`;
}

/** What the card prints, in order: the SSH session first, then the dial address where there is one.
 *  Composed here rather than in the page so the whole of the card's address wording — which lines
 *  appear, in which order, for which role — is provable by this module's test. */
export function addressLines(server: ServerView): string[] {
  const dial = dialAddressLine(server);
  return dial === null ? [sshAddressLine(server)] : [sshAddressLine(server), dial];
}
