// The per-server tailnet document, stored as JSON in servers.tailnet_json beside the
// servers.tailnet_state enum. `tailnet` is the word headscale and its client use for the private
// network between the master and its slaves, so it is the word an operator meets in the software's
// own output.
//
// The pair sits on `servers` and not on `clusters`, where the plane pair sits, because a cluster row
// is only as old as the deployment that wrote it: a server at "bare" has none at all, and a machine
// whose deployment stopped part way carries one that is not live. Both are machines whose membership
// has to be visible — the join runs inside the deployment, so a run that got that far put the host on
// the network and a run that stopped after it left it there.
import { z } from "zod";
import type { ServerTailnetFacts, ServerTailnetRead } from "./api-types.ts";
import type { ServerTailnetState } from "./enums.ts";

/**
 * ServerTailnet **v0** — one reading of a host's tailnet membership.
 *
 *  - `v`             — the schema version; ALWAYS 0 for this shape. readServerTailnet below
 *                      narrows on it before touching the body, so a future v1 can be added
 *                      without rewriting stored v0 rows and without a v0 reader guessing.
 *  - `observedAt`    — epoch ms the reading was taken.
 *  - `runId`         — the run that took it, so the card can link to the log it came from.
 *  - `clientVersion` — `tailscale version`, or null when there is no client to ask.
 *  - `backendState`  — the client's own `.BackendState`, or null when it would not answer.
 *  - `address`       — the tailnet address the host holds, or null when it holds none. A READING,
 *                      never a transport setting: nothing dials it. Which address a session opens
 *                      on is resolved from the two COLUMNS `servers.host` and `servers.lan_host`
 *                      (server/executor/transport.ts), and this document is not in that path.
 *  - `coordinator`   — the client's own `.ControlURL`, or null when it would not answer.
 *
 * `satisfies z.ZodType<ServerTailnetFacts>` pins the parsed shape to the ONE wire declaration
 * (shared/api-types.ts), so the two cannot drift apart in a green build — and that declaration is
 * what every caller names, so the shape is written down once and only once.
 */
const ServerTailnetV0 = z.object({
  v: z.literal(0),
  observedAt: z.number().int().positive(),
  runId: z.string().min(1),
  clientVersion: z.string().min(1).nullable(),
  backendState: z.string().min(1).nullable(),
  address: z.string().min(1).nullable(),
  coordinator: z.string().min(1).nullable(),
}) satisfies z.ZodType<ServerTailnetFacts>;

/** Just the version, read on its own so an unknown version is answered as such instead of failing
 *  the whole body's schema and reading as corruption. */
const Versioned = z.object({ v: z.number().int() });

/**
 * Read a stored tailnet document: narrow on `v` FIRST, parse the body only for a version this
 * build knows, and name every other outcome instead of collapsing it to null.
 *
 * The version is the contract's whole point and it only holds if a reader uses it. The plane
 * document next door has the same pair (shared/plane.ts readClusterPlane) for the same reason.
 */
export function readServerTailnet(stored: unknown): ServerTailnetRead {
  if (stored === null || stored === undefined) return { kind: "none" };
  const versioned = Versioned.safeParse(stored);
  if (!versioned.success) return { kind: "unreadable", reason: "no version field" };
  if (versioned.data.v !== 0) return { kind: "unsupported", v: versioned.data.v };
  const parsed = ServerTailnetV0.safeParse(stored);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { kind: "v0", facts: parsed.data };
}

/** The word the client prints for a node that is on a network. Every other backend state —
 *  NeedsLogin, Stopped, NoState, Starting — is a client that is not on one. */
const BACKEND_RUNNING = "Running";

/** What a host reported about its tailnet client, straight off the probe. Three separate absences,
 *  because they are three different facts: no binary at all, a binary whose version call failed,
 *  and a binary whose state could not be read. Folding any two of them loses the distinction the
 *  state below is made of. */
export interface TailnetProbe {
  /** The `tailscale` binary is on the host. */
  installed: boolean;
  clientVersion: string | null;
  /** The client's `.BackendState`, or null when the client did not answer. */
  backendState: string | null;
  address: string | null;
  coordinator: string | null;
}

/** Fold one probe into the pair the row stores: the state the card keys on, and the document that
 *  says where that state came from. Written together, in one statement, by one step — the state
 *  without its reading is a claim with no provenance.
 *
 *  The BACKEND STATE decides membership, never the address: a client that cannot be reached prints
 *  no address either, so reading the empty address as "not joined" would state as measured fact the
 *  exact thing the run failed to measure. */
export function tailnetReading(probe: TailnetProbe, meta: { runId: string; observedAt: number }): {
  state: ServerTailnetState;
  doc: ServerTailnetFacts;
} {
  const state: ServerTailnetState = !probe.installed
    ? "no-client"
    : probe.backendState === null
      ? "client-unreadable"
      : probe.backendState === BACKEND_RUNNING
        ? "joined"
        : "not-joined";
  return {
    state,
    doc: {
      v: 0,
      observedAt: meta.observedAt,
      runId: meta.runId,
      clientVersion: probe.installed ? probe.clientVersion : null,
      backendState: probe.installed ? probe.backendState : null,
      address: probe.address,
      coordinator: probe.coordinator,
    },
  };
}
