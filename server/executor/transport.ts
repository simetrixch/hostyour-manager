// WHICH ADDRESS a run's SSH session opens on.
//
// A server row carries two: `host`, the address the machine answers on from outside, and
// `lan_host`, the address it answers on inside the cluster network. Until this module existed the
// choice was not a choice — both SshTarget builders in context.ts computed `lanHost ?? host` once —
// so no run, param or step could ask for the other one, and the run log never said which address a
// session had actually gone out on.
//
// A verb that repairs the private network is what forced the change: it cannot travel over the
// network it is repairing, so it names the public address, and the run has to say so afterwards.
// The REQUEST lives on the plan's target (RunTargetRef.transport, executor/types.ts), which is
// frozen into plan_json at approval; the ANSWER is logged the moment a session is opened.

/** What a run ASKS for.
 *  - "default" — what every run has always used: the LAN address when the row carries one, the
 *    public address otherwise.
 *  - "public"  — servers.host, whatever else the row carries. */
export type SshTransport = "default" | "public";

/** WHICH address was taken. Reported, never asked for: "default" resolves to either one, so a log
 *  line that repeated the request would say nothing about where the session went. */
export type SshVia = "lan" | "public";

export interface ResolvedTransport {
  host: string;
  via: SshVia;
}

/** The words for a via, written once, so the run log and a plan summary cannot name the same
 *  address two different ways. */
export const VIA_LABEL: Record<SshVia, string> = {
  lan: "LAN address",
  public: "public address",
};

/** The one place an SSH host is picked. The "default" arm is `lanHost ?? host` exactly as it was,
 *  so every run that states no transport behaves as before, down to the byte. */
export function resolveTransport(server: { host: string; lanHost: string | null }, transport: SshTransport): ResolvedTransport {
  if (transport === "public") return { host: server.host, via: "public" };
  return server.lanHost ? { host: server.lanHost, via: "lan" } : { host: server.host, via: "public" };
}
