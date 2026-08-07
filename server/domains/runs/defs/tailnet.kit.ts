import type { Db } from "../../../db/client.ts";
import type { Plan, Step } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { remoteExec, remoteScript } from "../../../executor/stepkit.ts";
import { resolveTransport, VIA_LABEL } from "../../../executor/transport.ts";
import { isMasterRole, type RunKind } from "../../../../shared/enums.ts";
import { recordTailnetReading } from "../tailnet-probe.ts";
import { activeClusterTarget, loadMaster, loadServer, mintTailnetJoinKey, type SlaveTarget } from "./deploy-slave.kit.ts";
import { RESOLVE_REPO_DIR, tailnetKeyPath } from "./deploy-slave.remote.ts";

// The shared half of the three tailnet repair verbs (defs/tailnet.ts): the scripts they ship to a
// host, the steps they are composed of, and the one plan builder they all state their targets in.
// One builder parameterised by a mode, the way deploySlaveSteps is, rather than three step lists
// that would drift apart.
//
// WHAT MAKES THESE VERBS DIFFERENT FROM EVERY OTHER RUN. Each one reaches its host on the PUBLIC
// address — servers.host, stated on the plan's own target (RunTargetRef.transport) and resolved by
// executor/transport.ts — because an act that takes a host off the private network, or puts it
// back, cannot travel over that network. Nothing else about them is special: a plan, an approval,
// steps and a log, like every verb.
//
// A run in flight is not cut by a disconnect. Nothing in this controller dials a tailnet address:
// every SSH session goes to servers.lan_host or servers.host, so what a disconnect takes away is
// the host's membership of the private network, not this controller's way to it.

/** How every script below reaches the client. `tailscale` talks to tailscaled over a root-owned
 *  local socket while these scripts run as the login user, like every other remote script here, so
 *  the plain call is tried first and sudo is the fallback. The SECOND attempt keeps its stderr, so
 *  a refusal lands in the run log — unlike the read-only probe, which swallows both. */
const TS_HELPER = `ts() { tailscale "$@" 2>/dev/null || sudo -n tailscale "$@"; }`;

/** What a host must carry before any of these scripts may act, and why each absence is a failure
 *  rather than a state to report: an act performed on a client that is not there, or whose state
 *  cannot be read, is an act nobody can describe afterwards. jq is not a new dependency —
 *  install_cli_tools installs it BEFORE the tailnet client (hostyour-cloud
 *  base/common-kubernetes.sh CLI_TOOLS), so a host that has the client has jq. */
const REQUIRE_CLIENT = `command -v tailscale >/dev/null 2>&1 || { echo "no tailnet client on this host — a host gets one during its base install" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is not on this host, so the client's own state cannot be read" >&2; exit 1; }`;

/** Read the client's own backend state into $state. The BACKEND STATE is what decides membership
 *  here for the same reason it does in the probe and in the installer's own reader (hostyour-cloud
 *  base/lib/tailnet.sh): the daemon runs from the moment the client is installed, and an empty
 *  address cannot tell "on no network" from "could not ask". */
const READ_STATE = `state="$(ts status --json | jq -r '.BackendState // empty')"`;

const DISCONNECT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_CLIENT}
${TS_HELPER}
${READ_STATE}
if [ "$state" != "Running" ]; then
  echo "already off the tailnet (client state: \${state:-none}) — nothing to leave"
  exit 0
fi
ts down
${READ_STATE}
[ "$state" != "Running" ] || { echo "the client still reports Running after 'tailscale down'" >&2; exit 1; }
echo "off the tailnet (client state: \${state:-none})"
`;

const RECONNECT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_CLIENT}
${TS_HELPER}
${READ_STATE}
if [ "$state" = "Running" ]; then
  echo "already on the tailnet — nothing to re-establish"
  exit 0
fi
# BARE 'up', with not one flag on it. That is the client's own special case for "bring the network
# up and change nothing"; the moment ANY flag is present it re-derives the whole pref set from the
# command line and refuses with "changing settings via 'tailscale up' requires mentioning all
# non-default flags" — and every host here was put on the network with --login-server and
# --accept-dns=false (hostyour-cloud base/lib/tailnet.sh), neither of which is a client default. So a
# flag as innocent as a timeout would make this verb fail on every host the platform ever joined.
# The wait is bounded from OUTSIDE instead, because it has to be: a client whose node key is gone
# prints a login URL and waits for a human this run does not have. Both attempts have to fit inside
# the step's own 3-minute budget, so 60s each — an up that reaches its coordinator settles in
# seconds, and the only thing this bound is here to cut short is the wait for that human. The exit
# code is tolerated and the EFFECT asserted below, the same way the logout does it.
timeout 60 tailscale up 2>/dev/null || timeout 60 sudo -n tailscale up || true
${READ_STATE}
[ "$state" = "Running" ] || { echo "the client came back as '\${state:-none}', not Running — it holds no usable credential" >&2; exit 1; }
echo "back on the tailnet"
`;

const LOGOUT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_CLIENT}
${TS_HELPER}
# The exit code is tolerated and the EFFECT asserted instead: a host that was already logged out
# answers either way, while a host still Running afterwards would be skipped by the installer's
# join ("already on the tailnet" — hostyour-cloud base/lib/tailnet.sh) and the rejoin would silently
# do nothing.
ts logout || true
${READ_STATE}
[ "$state" != "Running" ] || { echo "the client still reports Running after 'tailscale logout' — it kept its node key, and the join would be skipped" >&2; exit 1; }
echo "logged out (client state: \${state:-none})"
`;

/** The verbs this kit builds — every RUN_KIND literal in the tailnet family, named by the family
 *  rather than listed, so a fourth one cannot be added to the enum without the map below refusing
 *  to compile. */
export type TailnetKind = Extract<RunKind, `tailnet-${string}`>;

/** WHICH repair a run is. Three acts, not one with a switch — see the def file for what each one
 *  honestly means and where the line between reconnect and rejoin runs. Derived from the kind and
 *  never passed beside it: a plan built for one kind in the shape of another would be a run that
 *  says one thing and does the other. */
type TailnetMode = "disconnect" | "reconnect" | "rejoin";

const MODE: Record<TailnetKind, TailnetMode> = {
  "tailnet-disconnect": "disconnect",
  "tailnet-reconnect": "reconnect",
  "tailnet-rejoin": "rejoin",
};

interface ClientAct {
  name: string;
  title: string;
  script: string;
  failure: string;
}

const CLIENT_ACT: Record<"disconnect" | "reconnect", ClientAct> = {
  disconnect: {
    name: "disconnect",
    title: "Take the host off the tailnet",
    script: DISCONNECT_SCRIPT,
    failure: "the host could not be taken off the tailnet",
  },
  reconnect: {
    name: "reconnect",
    title: "Put the host back on the tailnet",
    script: RECONNECT_SCRIPT,
    failure:
      "the host could not re-establish its membership with the credential it holds — when it holds none, tailnet-rejoin is the verb that mints a fresh one on the master",
  },
};

/** Step 0 of all three, and the reason they are declared mutating: the public address is the one
 *  most exposed to being handed to a different machine, so the run proves the box answering it is
 *  the box that was adopted before it changes anything on it. attestMachineId records the id on a
 *  row that carries none and hard-fails on a mismatch, and the executor then makes this step unskippable. */
function attestTargetStep(serverId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the machine answering the public address",
    run: async (ctx) => {
      const session = await ctx.ssh();
      const outcome = await attestMachineId({ db: ctx.db, session, serverId, signal: ctx.signal, log: (l) => ctx.log("meta", l) });
      ctx.checkpoint({ machineId: outcome.machineId, machineIdAction: outcome.action });
    },
  };
}

/** The whole act of a disconnect or a reconnect: one script on the host. Both are idempotent by
 *  their own precondition — each reads the client's state first and returns saying so. */
function clientActStep(mode: "disconnect" | "reconnect"): Step {
  const act = CLIENT_ACT[mode];
  return {
    name: act.name,
    title: act.title,
    run: async (ctx) => {
      const session = await ctx.ssh();
      const r = await remoteScript(ctx, session, act.name, act.script, { timeoutMs: 3 * 60_000 });
      if (r.code !== 0) throw errValidation(`${act.failure} (exit ${r.code}) — see the run log`);
    },
  };
}

/** Ask the master whether it can produce a join credential at all, and drop the answer.
 *
 *  The value is dropped on purpose: the installer's mint is create-only (hostyour-cloud
 *  base/lib/tailnet.sh), so the step that needs it asks again and gets the same key back rather
 *  than a second live one — and a credential like this may never become a checkpoint, which is the
 *  only other channel between two steps. What this step buys is the MOMENT of failure: a
 *  coordinator or a Vault that cannot produce a credential fails here, before the next step logs
 *  the host out and leaves it on no network with nothing to rejoin with.
 *
 *  That guarantee rests on the mint reaching the coordinator on EVERY call, including the one that
 *  hands back a key it already holds — which is the only case a deployed slave is ever in. The
 *  installer's action asks the coordinator before it looks at the stored slot for exactly this
 *  reason; a mint that skipped the question on a full slot would succeed here and strand the host
 *  one step later. */
function mintJoinKeyStep(target: SlaveTarget): Step {
  return {
    name: "mint-join-key",
    title: "Check the master can mint a join credential",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const master = loadMaster(ctx.db);
      const mSession = await ctx.ssh(master.id);
      await mintTailnetJoinKey(ctx, mSession, { stage, domain });
      ctx.log("meta", `the master can mint ${domain}'s join credential — the next step asks again at the moment it joins`);
    },
  };
}

/** Log the host out, then join it again through the same installer action that put it on the
 *  network in the first place (`--tailnet-join`). The logout is what makes the join real: the
 *  client keeps serving a cached netmap for a while after its node is deleted at the coordinator,
 *  so a host that still reports Running would be skipped by the join instead of re-registered.
 *
 *  This is the ONE step that can leave a host somewhere its stored reading does not describe — the
 *  logout lands, the join does not, and read-membership never runs because a failed step ends the
 *  run. So the reading is taken HERE before the failure propagates: the card would otherwise go on
 *  showing the membership this very step took away, on the one surface built to make it visible. */
function rejoinStep(target: SlaveTarget, serverId: string): Step {
  return {
    name: "rejoin",
    title: "Log the host out and join it again with a fresh credential",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const master = loadMaster(ctx.db);
      const mSession = await ctx.ssh(master.id);
      const session = await ctx.ssh();
      const keyPath = tailnetKeyPath(ctx.runId);
      try {
        // Mint FIRST, log out SECOND. A mint that fails after the logout would leave the host on
        // no network at all, which is worse than the state this verb was called about.
        const authkey = await mintTailnetJoinKey(ctx, mSession, { stage, domain });
        // The key rides ONLY inside a 0600 file delivered over putFile (a non-logging path; never
        // argv, which is ps-visible on the host), and its whole life is this try/finally.
        await session.putFile(keyPath, Buffer.from(`${authkey}\n`, "utf8"), 0o600, { signal: ctx.signal });
        const out = await remoteScript(ctx, session, "tailnet-logout", LOGOUT_SCRIPT, { timeoutMs: 2 * 60_000 });
        if (out.code !== 0) throw errValidation(`the host could not be logged out of the tailnet (exit ${out.code}) — see the run log`);
        const joined = await remoteExec(
          ctx, session,
          `${RESOLVE_REPO_DIR}\ncd "$GITOPS_DIR" && sudo -n ./setup.sh --${stage} --tailnet-join --tailnet-join-key-file ${keyPath}`,
          { timeoutMs: 5 * 60_000 },
        );
        if (joined.code !== 0) {
          try {
            await recordTailnetReading(ctx, session, serverId);
          } catch {
            // A probe that cannot run must not replace the join's own failure with its own.
          }
          throw errValidation(
            `the host could not join the tailnet (exit ${joined.code}) — see the run log; it was logged out first, so it is on NO network until this step is retried`,
          );
        }
      } finally {
        try {
          await session.exec(`rm -f ${keyPath}`, { signal: ctx.signal });
        } catch {
          // best-effort — the file is 0600 and the key is single-use and time-boxed
        }
      }
    },
  };
}

/** The last step of all three: read the host and write the pair on its server row, through the one
 *  writer every other reading goes through (domains/runs/tailnet-probe.ts). Without it a card would
 *  go on showing the reading from before the repair — the state the operator asked the verb to
 *  change. A probe that cannot run leaves the stored reading alone and says so in the log; it does
 *  not fail the step, because the act above already happened and calling the run failed would say
 *  the opposite. */
function readMembershipStep(serverId: string): Step {
  return {
    name: "read-membership",
    title: "Read the host's tailnet membership",
    run: async (ctx) => {
      const session = await ctx.ssh();
      ctx.checkpoint({ tailnetState: await recordTailnetReading(ctx, session, serverId) });
    },
  };
}

export function tailnetSteps(kind: TailnetKind, serverId: string): Step[] {
  const mode = MODE[kind];
  if (mode === "rejoin") {
    const target = activeClusterTarget(serverId);
    return [attestTargetStep(serverId), mintJoinKeyStep(target), rejoinStep(target, serverId), readMembershipStep(serverId)];
  }
  return [attestTargetStep(serverId), clientActStep(mode), readMembershipStep(serverId)];
}

const SUMMARY: Record<TailnetMode, (o: { name: string; steps: number; host: string; master: string }) => string> = {
  disconnect: (o) =>
    `Take "${o.name}" off the tailnet: ${o.steps} steps, reaching it on its public address ${o.host}. ` +
    `It keeps answering there afterwards, which is how the two verbs that put it back reach it.`,
  reconnect: (o) =>
    `Put "${o.name}" back on the tailnet with the credential it already holds: ${o.steps} steps, reaching it on its ` +
    `public address ${o.host}. Nothing is minted and the master is not touched.`,
  rejoin: (o) =>
    `Log "${o.name}" out of the tailnet and join it again with a credential minted on the master "${o.master}": ` +
    `${o.steps} steps — the host on its public address ${o.host}, the master on its usual one.`,
};

const WARNINGS: Record<TailnetMode, string[]> = {
  disconnect: ["The host belongs to no private network afterwards, until a reconnect or a rejoin puts it back."],
  reconnect: ["A host whose credential is gone cannot re-establish this way — the run fails, and tailnet-rejoin is the verb that mints a fresh one."],
  rejoin: [
    "The host is logged out before it joins again, so it is on no network for the length of this run.",
    "The mint is create-only: a stored credential the coordinator still accepts is handed back rather than replaced.",
  ],
};

/**
 * The plan all three verbs are approved on. What it states beyond the usual:
 *
 *  - the HOST target names `transport: "public"`, so the frozen plan_json records which of the
 *    server's two addresses this run was approved to use, and the executor opens the session on it
 *    (server/executor/transport.ts). The master, when a rejoin needs one, keeps the usual address:
 *    it is not the host whose network is being repaired.
 *  - the HOST target OWNS its host, which derives the `server:<id>` lock every host-mutating run
 *    takes. Without it a rejoin could run `tailscale logout` on a slave while a deploy-slave in
 *    flight was joining it, both runs would report success, and the host would end up off the
 *    network with its single-use join credential already redeemed. A run that has SETTLED — the
 *    failed deploy-slave these verbs exist for — holds no lock to be blocked by: every terminal
 *    path in the executor releases them (finishRun / failRun), whatever the outcome. The master,
 *    when a rejoin needs one, is not owned: the run drives its installer, it does not own the box.
 */
export function tailnetPlan(kind: TailnetKind, serverId: string, db: Db): Plan {
  const mode = MODE[kind];
  const server = loadServer(db, serverId);
  if (isMasterRole(server.role)) {
    throw errValidation(
      `refusing: "${server.name}" carries the master part, and the master runs the tailnet coordinator — taking it off its own network is not a repair`,
    );
  }
  const resolved = resolveTransport(server, "public");
  const steps = tailnetSteps(kind, serverId);
  const master = mode === "rejoin" ? loadMaster(db) : undefined;
  // A rejoin needs the FQDN and the stage of a cluster that is LIVE, because the credential is
  // minted per slave under that name. Resolved here and not only inside the steps: being refused at
  // plan time beats being refused after the host has been logged out.
  if (mode === "rejoin") activeClusterTarget(serverId).resolve(db);
  return {
    kind,
    targetKind: "server",
    targetId: serverId,
    summary: SUMMARY[mode]({ name: server.name, steps: steps.length, host: `${resolved.host}:${server.sshPort}`, master: master?.name ?? "" }),
    steps: steps.map((s) => ({ name: s.name, title: s.title })),
    targets: [
      { serverId, ownsHost: true, label: `${server.name} (over its ${VIA_LABEL[resolved.via]})`, transport: "public" },
      ...(master ? [{ serverId: master.id, ownsHost: false, label: `${master.name} (master)` }] : []),
    ],
    warnings: WARNINGS[mode],
    requiredSecrets: [],
  };
}
