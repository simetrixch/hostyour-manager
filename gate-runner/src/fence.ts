// gate-runner/src/fence.ts
// SECURITY-CRITICAL — the sandbox self-probe. Before the runner trusts a job it
// PROVES its own egress fence from the inside: the must-fail targets (the mother's LAN Traefik) and
// the Manager's own address MUST be UNreachable (a blocked TCP connect is the fence working), and
// the must-pass target (github.com, the one egress the job legitimately needs) MUST be reachable. The
// result is frozen into the report as a SandboxAttestation the Manager re-checks. Fail closed: any
// target we cannot AFFIRMATIVELY prove blocked counts as not-denied, and any target we cannot prove
// reachable counts as not-reached, so an error or a misconfigured target never masquerades as a
// proven fence. TCP probing is injected (ConnectFn) so this is unit-testable without touching the net.
import { createConnection } from "node:net";
import type { SandboxAttestation } from "../../shared/gates.ts";

/** The confirmed-listening attestation + the three probe roles the runner must verify. */
export interface FenceConfig {
  /** LAN targets that MUST be blocked (the mother's Traefik). Echoed verbatim into the report. */
  mustFailTargets: string[];
  /** The Manager's own address — a second must-fail probe (the runner must not reach home). */
  managerAddr: string;
  /** The one egress the job legitimately needs (github.com) — must be reachable. */
  mustPassTarget: string;
  /** The Manager's attestation that the must-fail targets were confirmed listening; echoed. */
  confirmedListening: boolean;
  /** Per-connect budget; defaults to DEFAULT_TIMEOUT_MS when unset or non-positive. */
  timeoutMs?: number;
}

/** Injected TCP probe: resolves true iff a connection was established, false if it was blocked. */
export type ConnectFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const DEFAULT_PORT = 443;
const DEFAULT_TIMEOUT_MS = 3000;

interface HostPort {
  host: string;
  port: number;
}

/** 1..65535, else the default. Guards a hostile / malformed port from reaching the socket layer. */
function normalizePort(port: number): number {
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/** Parse a target — a bare host, a "host:port", or a URL like "https://10.1.1.1:443/" — into a
 *  host + port, defaulting the port to 443. Never throws: a shape we cannot parse yields host ""
 *  (which the probes then treat as unprovable => fail closed). Handles bracketed / bare IPv6. */
function parseTarget(target: string): HostPort {
  const raw = typeof target === "string" ? target.trim() : "";
  if (raw === "") return { host: "", port: DEFAULT_PORT };

  // URL form: anything carrying a scheme separator. WHATWG URL strips a scheme-default port (":443"
  // on https, ":80" on http), so an empty url.port must fall back to the SCHEME's default — http to
  // 80, else 443 — otherwise an http://host:80 must-fail target (the mother's LAN Traefik HTTP
  // entrypoint) would be probed on 443 and the fence attestation would be vacuous.
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      const host = stripBrackets(url.hostname);
      const schemeDefault = url.protocol === "http:" ? 80 : DEFAULT_PORT;
      const port = url.port !== "" ? normalizePort(Number(url.port)) : schemeDefault;
      return { host, port };
    } catch {
      // fall through: treat a malformed URL as a host:port string
    }
  }

  // Bracketed IPv6 literal, optionally with a port: "[::1]" or "[::1]:8443".
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) {
      const host = raw.slice(1, end);
      const rest = raw.slice(end + 1);
      const port = rest.startsWith(":") ? normalizePort(Number(rest.slice(1))) : DEFAULT_PORT;
      return { host, port };
    }
    return { host: raw, port: DEFAULT_PORT };
  }

  const firstColon = raw.indexOf(":");
  const lastColon = raw.lastIndexOf(":");
  // No colon => bare host. Multiple colons (unbracketed) => a bare IPv6 literal, port defaults.
  if (firstColon === -1 || firstColon !== lastColon) {
    return { host: raw, port: DEFAULT_PORT };
  }
  const host = raw.slice(0, lastColon);
  const port = normalizePort(Number(raw.slice(lastColon + 1)));
  return { host: host === "" ? raw : host, port };
}

/** Drop the surrounding brackets URL.hostname keeps on an IPv6 literal ("[::1]" -> "::1"). */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True only if the connect AFFIRMATIVELY returned false (the fence blocked it). An empty host or a
 *  thrown connect means we could not prove a block, so it is NOT denied — fail closed. */
async function probeDenied(connect: ConnectFn, hp: HostPort, timeoutMs: number): Promise<boolean> {
  if (hp.host === "") return false;
  try {
    return (await connect(hp.host, hp.port, timeoutMs)) === false;
  } catch {
    return false;
  }
}

/** True only if the connect AFFIRMATIVELY returned true (the target was reachable). An empty host or
 *  a thrown connect means we could not prove reachability, so it is NOT reached — fail closed. */
async function probeReached(connect: ConnectFn, hp: HostPort, timeoutMs: number): Promise<boolean> {
  if (hp.host === "") return false;
  try {
    return (await connect(hp.host, hp.port, timeoutMs)) === true;
  } catch {
    return false;
  }
}

/** The default TCP probe: open a socket to host:port, resolve true on "connect", false on
 *  "timeout"/"error", and always destroy the socket. Never rejects. */
const defaultConnect: ConnectFn = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof createConnection> | undefined;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (socket !== undefined) socket.destroy();
      resolve(result);
    };
    try {
      socket = createConnection({ host, port });
      socket.setTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });

/** Prove the egress fence from inside the sandbox and return the attestation frozen into the report.
 *  The `connect` probe is injectable (tests pass a fake); it defaults to a real node:net TCP probe. */
export async function selfProbe(cfg: FenceConfig, connect: ConnectFn = defaultConnect): Promise<SandboxAttestation> {
  const timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Echo the configured must-fail targets verbatim — never derive or guess them. Coerce defensively
  // so a runtime non-string cannot later break the report schema.
  const mustFailTargets = (Array.isArray(cfg.mustFailTargets) ? cfg.mustFailTargets : []).map((t) =>
    typeof t === "string" ? t : String(t),
  );

  const denied = await Promise.all(mustFailTargets.map((t) => probeDenied(connect, parseTarget(t), timeoutMs)));
  const managerAddrDenied = await probeDenied(connect, parseTarget(cfg.managerAddr), timeoutMs);
  const mustPassReached = await probeReached(connect, parseTarget(cfg.mustPassTarget), timeoutMs);

  return {
    mustFailTargets,
    mustFailTargetsConfirmedListening: cfg.confirmedListening === true,
    // Every must-fail target must be denied. An EMPTY list proves nothing, so it is not a pass —
    // a deliberate fail-closed refinement of the plain `.every()` (which is vacuously true on []).
    mustFailDenied: denied.length > 0 && denied.every((d) => d),
    managerAddrDenied,
    mustPassReached,
  };
}
