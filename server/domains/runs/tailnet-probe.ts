// Reading a host's tailnet membership off its own client, and recording it on the server row.
//
// THREE kinds of run take a reading, because one is not enough to describe a host's whole life:
//   adopt          the first reading, of a machine the platform has never touched. On a fresh box
//                  there is no client yet — install_cli_tools puts it there during the base install
//                  — so this reading is normally "no-client", and that is the truth at that moment.
//   deploy-slave   right after the host joins. This is the reading that describes a MANAGED slave,
//                  and without it every deployed slave would keep adopt's pre-install reading
//                  forever: a warn chip saying "no client" about the machine the master's ArgoCD
//                  and Vault are talking to. redeploy re-runs the same step list, so it re-reads.
//   the tailnet    their last step, so a disconnect, a reconnect or a rejoin is visible on the card
//   repair run kinds   that offered it instead of leaving the reading from before the repair standing.
// All of them go through recordTailnetReading, so there is one probe, one fold and one write.
//
// WHY THE CLIENT'S OWN STATE AND NOT THE ADDRESS. `tailscale ip -4` prints nothing and exits
// non-zero for a node that is not logged in AND for a client that cannot be reached at all, and a
// command substitution keeps neither the exit code nor stderr — so an empty address cannot tell
// "this host is on no network" from "this run could not ask". The client's own `.BackendState` can,
// and it is what the installer's own reader uses (hostyour-cloud base/lib/tailnet.sh).
import { eq } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import { servers } from "../../db/schema/inventory.ts";
import { remoteScriptCapture, localTx } from "../../executor/stepkit.ts";
import { tailnetReading, type TailnetProbe } from "../../../shared/tailnet.ts";
import type { ServerTailnetState } from "../../../shared/enums.ts";

/**
 * The probe. Emits `TAILNET <key> <value>` lines; an ABSENT line is the absence of the fact, so
 * every branch that cannot produce a value simply prints none.
 *
 * `ts()` retries under sudo because the client talks to tailscaled over a root-owned local socket,
 * while this script runs as the login user like every other captured script — without the retry a
 * joined host whose socket the user cannot read would be recorded as a client that says nothing.
 *
 * jq is not a new dependency: install_cli_tools installs jq BEFORE tailscale
 * (hostyour-cloud base/common-kubernetes.sh CLI_TOOLS), so a host that has the client has jq. A host
 * that has neither emits only the absent-client line and never reaches the jq guard; the guard is
 * there so a hand-built host reports "the client would not answer" instead of the parse of an
 * empty string.
 */
export const TAILNET_PROBE_SCRIPT = `#!/usr/bin/env bash
if ! command -v tailscale >/dev/null 2>&1; then
  echo "TAILNET client absent"
  exit 0
fi
echo "TAILNET client present"
ts() { tailscale "$@" 2>/dev/null || sudo -n tailscale "$@" 2>/dev/null; }
echo "TAILNET version $(ts version | head -1)"
command -v jq >/dev/null 2>&1 || exit 0
status="$(ts status --json)"
echo "TAILNET backend $(printf '%s' "$status" | jq -r '.BackendState // empty')"
echo "TAILNET address $(printf '%s' "$status" | jq -r '((.Self.TailscaleIPs // .TailscaleIPs) // []) | map(select(contains(":") | not)) | .[0] // empty')"
echo "TAILNET coordinator $(ts debug prefs | jq -r '.ControlURL // empty')"
`;
// WHY THE COORDINATOR COMES OFF `debug prefs` AND NOT OFF THE STATUS ABOVE IT. `status --json` at
// the client version an installation ends up with (1.98.10, measured against the vendor's own
// release build) prints 13 fields — Version, TUN, BackendState, AuthURL, TailscaleIPs, Self,
// Health, MagicDNSSuffix, CurrentTailnet, CertDomains, Peer, User, ClientVersion — and none of them
// is the control URL. AuthURL is the interactive login URL, which is a different thing and is empty
// on a joined node. ipn/ipnstate.go's Status struct carries no control URL field at that tag either,
// so this is not a reading that a newer parse of the same output could recover.
// The reading costs one more sudo rule than the status does, and what that rule hands over was
// measured rather than assumed: at 1.98.10 the daemon strips PrivateNodeKey, OldPrivateNodeKey and
// NetworkLockKey out of the preferences before the local API answers, so this prints settings and
// no key material. The grant's own table states the same measurement beside the rule it justifies.

/** Turn the probe's stdout into the facts. A key whose value came out empty produces a line with
 *  nothing after the key, which matches no `TAILNET <key> <value>` pair and therefore lands here as
 *  an absent key — the same as a branch that never ran. */
export function parseTailnetProbe(stdout: string): TailnetProbe {
  const seen: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^TAILNET (\S+) (.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) seen[m[1]] = m[2].trim();
  }
  const installed = seen["client"] === "present";
  return {
    installed,
    clientVersion: seen["version"] ?? null,
    backendState: seen["backend"] ?? null,
    address: seen["address"] ?? null,
    coordinator: seen["coordinator"] ?? null,
  };
}

/**
 * Read the host and write the pair. State and document go down in ONE statement, so a membership
 * can never be stored without the moment and the run that produced it — and so the two halves
 * cannot disagree, which is what lets the card trust either one.
 *
 * Returns the state it wrote, or null when the probe itself did not run — in which case NOTHING is
 * written and the row keeps what it had. Every branch of the script exits 0 and prints what it
 * found, so a non-zero exit means the reading never happened, and overwriting a real reading (or
 * the never-measured default) with a made-up one would be the one thing this surface must not do.
 * The reading is a soft fact and never fails its step: a host that will not describe its client is
 * still a host the rest of the run has business with.
 */
export async function recordTailnetReading(
  ctx: StepCtx,
  session: SshSession,
  serverId: string,
): Promise<ServerTailnetState | null> {
  const cap = await remoteScriptCapture(ctx, session, "tailnet-probe", TAILNET_PROBE_SCRIPT, { timeoutMs: 60_000 });
  if (cap.result.code !== 0) {
    ctx.log("meta", `Tailnet: the membership probe did not run (exit ${cap.result.code}) — this server's stored reading is unchanged.`);
    return null;
  }
  const reading = tailnetReading(parseTailnetProbe(cap.stdout), { runId: ctx.runId, observedAt: Date.now() });
  localTx(ctx, (tx) =>
    tx.update(servers).set({ tailnetState: reading.state, tailnetJson: reading.doc }).where(eq(servers.id, serverId)).run(),
  );
  ctx.log(
    "meta",
    `Tailnet: ${reading.state}${reading.doc.address ? ` at ${reading.doc.address}` : ""}` +
    `${reading.doc.coordinator ? ` (coordinator ${reading.doc.coordinator})` : ""} — read now; ` +
    `only a run takes a new reading, never the page that shows it.`,
  );
  return reading.state;
}
