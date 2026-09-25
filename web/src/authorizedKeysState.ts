// How a server's AUTHORIZED KEYS are worded on its card, and what one operator key's card may
// offer per server. A pure module beside tailnetState.ts / passwordLoginState.ts, for the same
// reason those are: vitest runs with environment "node" and includes no .tsx, so wording left
// inside a page cannot be tested — and wording is the whole substance here.
//
// The same two rules as the two chips next to it govern every line below.
//   1. A reading is a SNAPSHOT, not a status. What the card shows is what one run saw at one
//      moment, and the wording always says when. Green is reserved for a fresh reading of a host
//      whose every key line this platform can name.
//   2. No sentence tells the operator to do something. The card's own buttons are the buttons.
//
// One rule is this chip's alone: a key nobody here placed is never softened. It is a working way
// into the machine that no run kind on this surface can take off, and this chip is where an operator
// finds out it exists.
import type { AuthorizedKeyFact, ServerView } from "../../shared/api-types.ts";

/** How long an "accounted" reading keeps its green chip. Past this the chip goes neutral and the
 *  sentence's age carries the whole claim: nothing re-reads a host on its own, and authorized_keys
 *  is a plain file anyone with a shell on the box can append to. Nothing else keys on this — age
 *  does not make a foreign key any less present, and the other states are already warn. */
export const AUTHORIZED_KEYS_READING_FRESH_MS = 60 * 60 * 1000;

/** What takes a new reading. Every sentence that mentions re-reading ends with this, so the card
 *  never implies a live probe behind the value. */
const RE_READ = "only a run takes a new one";

export interface AuthorizedKeysChip {
  label: string;
  className: string;
  detail: string;
  /** The run that took the reading, so the sentence can link to the log it came from. */
  runId: string | null;
}

/** "just now" / "14 min ago" / "3 h ago" / "6 d ago". Coarse on purpose: the age is here to tell a
 *  fresh reading from an old one, not to be a clock. */
function readingAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The operator keys a reading found, named by their labels — what a sentence has to say so the
 *  operator learns WHO can reach the machine rather than how many can. */
function operatorLabels(keys: readonly AuthorizedKeyFact[]): string[] {
  return keys.filter((k) => k.kind === "operator" && k.label !== null).map((k) => k.label as string);
}

/** The one place the authorized-keys pair becomes words. Narrows on the READ outcome first, because
 *  that is what carries the provenance, and only then on the state the reading produced. */
export function authorizedKeysChip(server: ServerView, now: number): AuthorizedKeysChip {
  const read = server.authorizedKeys;
  const state = server.authorizedKeysState;
  // "Nothing was measured" has two spellings and they always agree: "unknown" is the column
  // default, and recordAuthorizedKeysReading writes state and document in one statement.
  if (state === "unknown" || read.kind === "none") {
    return {
      label: "authorized keys: not read",
      className: "chip",
      detail: "No run has read who this server's authorized_keys lets in.",
      runId: null,
    };
  }
  if (read.kind === "unsupported") {
    return {
      label: "authorized keys: reading unreadable",
      className: "chip chip--warn",
      detail: `The stored reading is version ${read.v}; this manager reads version 0 only, so ${RE_READ}.`,
      runId: null,
    };
  }
  if (read.kind === "unreadable") {
    return {
      label: "authorized keys: reading unreadable",
      className: "chip chip--warn",
      detail: `The stored reading did not parse (${read.reason}), so ${RE_READ}.`,
      runId: null,
    };
  }

  const { facts } = read;
  const stale = now - facts.observedAt > AUTHORIZED_KEYS_READING_FRESH_MS;
  const taken = `Read ${readingAge(Math.max(0, now - facts.observedAt))}; ${RE_READ}.`;
  const runId = facts.runId;
  const foreign = facts.keys.filter((k) => k.kind === "foreign");
  const labels = operatorLabels(facts.keys);
  const mine = facts.keys.filter((k) => k.kind === "manager").length;
  const who =
    `${mine} key of this manager's own and ` +
    (labels.length === 0 ? "no operator key" : `the operator key(s) ${labels.join(", ")}`) + ".";

  switch (state) {
    case "accounted":
      return {
        label: "authorized keys: all known",
        className: stale ? "chip" : "chip chip--ok",
        detail: `Every one of the ${facts.keys.length} key(s) on this host is one this manager can also take off — ${who} ${taken}`,
        runId,
      };
    case "unaccounted": {
      // TWO different things land here and the chip says which: a key line nobody on this platform
      // placed, and a line this manager could not read as a key at all. The second is not
      // harmless — sshd's parser is not this one, so such a line may well be authenticating
      // somebody — and a chip that named only the first would count it as zero.
      const counts = [
        ...(foreign.length > 0 ? [`${foreign.length} foreign`] : []),
        ...(facts.unparsed > 0 ? [`${facts.unparsed} unreadable`] : []),
      ];
      const named = foreign.length > 0
        ? `${foreign.length} key(s) here were placed by nothing on this platform, so no run kind can remove them — ` +
          `${foreign.map((k) => `${k.fingerprint}${k.comment ? ` (${k.comment})` : ""}`).join(", ")}. `
        : "";
      const unread = facts.unparsed > 0
        ? `${facts.unparsed} line(s) in the file are not a key this manager can read, and sshd may still take one of ` +
          `them — they have to be looked at on the host. `
        : "";
      return {
        label: `authorized keys: ${counts.join(", ")}`,
        className: "chip chip--warn",
        detail: `${named}${unread}Beside them: ${who} ${taken}`,
        runId,
      };
    }
    case "unreadable":
      return {
        label: "authorized keys: unreadable",
        className: "chip chip--warn",
        detail: `~/.ssh/authorized_keys could not be read on this host, so who it lets in is unmeasured. ${taken}`,
        runId,
      };
  }
}

/** Which authorized-keys run kinds a server's card may offer. */
export interface AuthorizedKeysRunKindOffer {
  read: boolean;
}

/** Every one of these run kinds drives one host over this manager's own key, so the one thing they
 *  share is that the manager HAS one — `hasKey`, which is the credential itself
 *  (server/domains/inventory/write.ts builds it from an unrotated ssh_key row) and the same fact the
 *  plans refuse on (defs/operator-key.kit.ts). A server's STATUS is not that fact: it says where the
 *  machine stands in its deployment, and a deployment that stopped before installing a key still
 *  moves it.
 *
 *  Deliberately NOT keyed on the reading. A reading is a snapshot, so hiding the read button from a
 *  host that looked clean an hour ago would let a stale value decide what the operator may look at —
 *  on the one surface where being wrong means a key nobody is watching. */
export function authorizedKeysRunKindOffer(server: ServerView): AuthorizedKeysRunKindOffer {
  return { read: server.hasKey };
}

/** What ONE operator key's row says about ONE server, on the operator-keys page. */
export interface OperatorKeyPlacement {
  /** "present" — the last reading found this key. "absent" — it read the file and this key was not
   *  in it. "unread" — nothing readable has been recorded, which is neither of the two. */
  state: "present" | "absent" | "unread";
  line: string;
  /** Both acts are offered on the same predicate the plan refuses on, and never on the state above:
   *  a snapshot may not decide what an operator is allowed to attempt, and each run kind reads the live
   *  file and says what it found. */
  place: boolean;
  remove: boolean;
}

export function operatorKeyPlacement(server: ServerView, fingerprint: string): OperatorKeyPlacement {
  const acts = { place: server.hasKey, remove: server.hasKey };
  const read = server.authorizedKeys;
  if (read.kind !== "v0") {
    return { state: "unread", line: "No readable reading — nothing here can say whether this key is on the host.", ...acts };
  }
  const found = read.facts.keys.find((k) => k.fingerprint === fingerprint);
  if (!found) {
    return { state: "absent", line: `Not in the ${read.facts.keys.length} key(s) the last reading found.`, ...acts };
  }
  return {
    state: "present",
    line: found.kind === "operator"
      ? `On the host, under the label "${found.label ?? ""}" this platform placed it with.`
      : `On the host, but under a comment this platform did not write (${found.comment || "no comment"}) — a removal by label will not reach it.`,
    ...acts,
  };
}
