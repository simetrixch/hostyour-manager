// How a server's tailnet membership is WORDED on its card. A pure module beside runScreen.ts /
// relocationBand.ts / tenantRows.ts, for the same reason those are: vitest runs with
// environment "node" and includes no .tsx, so wording left inside the page cannot be tested — and
// wording is the whole substance here.
//
// Two rules govern every line below.
//   1. A reading is a SNAPSHOT, not a status. What the card shows is what one run saw at one
//      moment, and the wording always says when. Green is therefore reserved for a fresh reading
//      of a joined host; everything else — never read, read long ago, unreadable — reads as
//      exactly that.
//   2. No sentence tells the operator to do something. The page offers Adopt only on a bare or
//      undeployed server (LIFECYCLE in pages/Servers.tsx) and offers nothing at all on the master,
//      while this paragraph renders on every card — so an instruction here would be followable
//      only by the servers whose reading is least likely to be wrong. The sentences state what was
//      measured and what would measure it again, and let the card's own buttons be the buttons.
import type { ServerView } from "../../shared/api-types.ts";
import { isMasterRole, type ServerTailnetState } from "../../shared/enums.ts";

/** How long a JOINED reading keeps its green chip. Past this the chip goes neutral and the
 *  sentence's age carries the whole claim: a green pill for a membership nobody has re-read is the
 *  one thing this surface must never show, and there is no live probe behind it to keep it true.
 *  Nothing else keys on this — age does not make "no client" any less true, and the other states
 *  are already neutral or warn. */
export const TAILNET_READING_FRESH_MS = 60 * 60 * 1000;

/** What takes a new reading. Every sentence that mentions re-reading ends with this, so the card
 *  never implies a live probe behind the number. Deliberately not a list of run kinds: adopt,
 *  deploy-slave, redeploy and each of the three tailnet repair run kinds take one, and a list here
 *  would be a fifth place to keep in step with them. */
const RE_READ = "only a run takes a new one";

export interface TailnetChip {
  /** The chip text, self-describing beside the role chip that sits next to it. */
  label: string;
  /** The chip's class list — neutral, ok or warn, all three already in the design system. */
  className: string;
  /** One sentence under the card: what the reading says, and when it was taken. */
  detail: string;
  /** The run that took the reading, so the sentence can link to the log it came from. Null
   *  whenever there is no readable reading — there is no run to point at. */
  runId: string | null;
}

/** "just now" / "14 min ago" / "3 h ago" / "6 d ago". Coarse on purpose: the age is here to tell a
 *  fresh reading from an old one, not to be a clock. A negative age (a host clock ahead of this
 *  browser) reads "just now" rather than a nonsense future. */
function readingAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The one place the tailnet pair becomes words. Narrows on the READ outcome first, because that
 *  is what carries the provenance, and only then on the state the reading produced. Total over
 *  both — a state with no readable reading behind it is said to be exactly that, never guessed at
 *  from the column alone. */
export function tailnetChip(server: ServerView, now: number): TailnetChip {
  const read = server.tailnet;
  const state = server.tailnetState;
  // "Nothing was measured" has two spellings and they always agree: "unknown" is the column
  // default, and recordTailnetReading writes state and document in one statement, so a row that
  // carries one carries the other. Both land here rather than one of them falling through to a
  // switch arm describing a row only a hand-edit of the database could produce.
  if (state === "unknown" || read.kind === "none") {
    return {
      label: "tailnet: not read",
      className: "chip",
      detail: "No run has read this server's tailnet membership yet.",
      runId: null,
    };
  }
  if (read.kind === "unsupported") {
    return {
      label: "tailnet: reading unreadable",
      className: "chip chip--warn",
      detail: `The stored reading is version ${read.v}; this manager reads version 0 only, so ${RE_READ}.`,
      runId: null,
    };
  }
  if (read.kind === "unreadable") {
    return {
      label: "tailnet: reading unreadable",
      className: "chip chip--warn",
      detail: `The stored reading did not parse (${read.reason}), so ${RE_READ}.`,
      runId: null,
    };
  }

  const { facts } = read;
  const age = readingAge(Math.max(0, now - facts.observedAt));
  const stale = now - facts.observedAt > TAILNET_READING_FRESH_MS;
  const taken = `Read ${age}; ${RE_READ}.`;
  const runId = facts.runId;
  // The coordinator is named, never judged: a host on somebody else's network holds an address out
  // of the same range and reports Running exactly like ours, and the manager is told no
  // coordinator URL of its own to compare against. Naming it is what lets an operator see the
  // difference at all.
  const via = facts.coordinator ? ` via ${facts.coordinator}` : "";

  switch (state) {
    case "joined":
      return {
        label: facts.address ? `tailnet: ${facts.address}` : "tailnet: joined",
        className: stale ? "chip" : "chip chip--ok",
        detail: `${facts.address ? `On the tailnet at ${facts.address}${via}.` : `On the tailnet${via}.`} ${taken}`,
        runId,
      };
    case "not-joined":
      return {
        label: "tailnet: not joined",
        className: "chip chip--warn",
        detail:
          `The tailnet client is installed${facts.clientVersion ? ` (${facts.clientVersion})` : ""} and reports ` +
          `${facts.backendState ?? "no state"} — this host is on no tailnet. ${taken}`,
        runId,
      };
    case "client-unreadable":
      return {
        label: "tailnet: client unreadable",
        className: "chip chip--warn",
        detail:
          `The tailnet client is installed${facts.clientVersion ? ` (${facts.clientVersion})` : ""} but would not say ` +
          `what it is doing, so whether this host is on the tailnet is unmeasured — is tailscaled running? ${taken}`,
        runId,
      };
    case "no-client":
      return {
        label: "tailnet: no client",
        className: "chip chip--warn",
        detail: `No tailnet client on this host. ${taken}`,
        runId,
      };
  }
}

/** Which of the three tailnet repair run kinds a server's card may offer. */
export interface TailnetRunKindOffer {
  disconnect: boolean;
  reconnect: boolean;
  rejoin: boolean;
}

/** The readings in which a run has SEEN a tailnet client on the host. The other two have not:
 *  "no-client" is a run that looked and found none, "unknown" is a row nothing has looked at. */
const CLIENT_SEEN: ReadonlySet<ServerTailnetState> = new Set<ServerTailnetState>(["joined", "not-joined", "client-unreadable"]);

/**
 * Which run kinds this card may offer, and on what.
 *
 * All three drive the tailnet CLIENT on the host, so the one thing they share is that a run has
 * seen a client there: on a host with none the first command exits saying so, and a host nothing
 * has read yet gives the page nothing to base an offer on.
 *
 * They are deliberately NOT keyed on the membership itself. A reading is a snapshot, so "joined" an
 * hour ago says nothing about now; hiding reconnect from a host that once read joined would let a
 * stale number decide what the operator may attempt. Each run kind reads the live state on the host and
 * returns saying so when there is nothing to do.
 *
 * Two conditions stand on their own. The MASTER is offered every one of these but the DISCONNECT,
 * which is the line the plan itself draws (server/domains/runs/defs/tailnet.kit.ts): the master's
 * in-cluster components — its per-slave ArgoCD, Vault on every ESO login, this manager's own kube
 * client — reach every slave over the private network a disconnect would cut, so taking the master
 * off it is not a repair. Joining it is: a master carries a machine of the infrastructure like any
 * other, and a master off its own network cannot dial the address every slave is registered under.
 * REJOIN additionally needs a live cluster, because the credential is minted per machine against the
 * coordinator under that cluster's FQDN and stage.
 *
 * ONE DECISION AND NOT TWO. What a master may do is decided in the plan; this reads the same line
 * rather than stating a second one, because a card that offers less than the plan admits leaves a
 * repair reachable only by somebody who knows the API.
 */
export function tailnetRunKindOffer(server: ServerView, o: { liveCluster: boolean }): TailnetRunKindOffer {
  const seen = CLIENT_SEEN.has(server.tailnetState);
  return { disconnect: seen && !isMasterRole(server.role), reconnect: seen, rejoin: seen && o.liveCluster };
}
