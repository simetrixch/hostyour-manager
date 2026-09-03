// How a server's PASSWORD LOGIN is worded on its card, and which of the two run kinds the card offers.
// A pure module beside tailnetState.ts / serverRuns.ts, for the same reason those are: vitest runs
// with environment "node" and includes no .tsx, so wording left inside the page cannot be tested —
// and wording is the whole substance here.
//
// The same two rules as the tailnet chip next to it govern every line below.
//   1. A reading is a SNAPSHOT, not a status. What the card shows is what one run saw at one
//      moment, and the wording always says when. Green is reserved for a fresh reading of a host
//      whose daemon answered "no" to both keywords.
//   2. No sentence tells the operator to do something. The card's own buttons are the buttons.
//
// One rule is this chip's alone: the word for a door that is open is "on", and it is never soft.
// A host that takes a password takes it from everyone who can reach its SSH port, and this chip is
// where an operator finds that out.
import type { ServerView } from "../../shared/api-types.ts";

/** How long an "off" reading keeps its green chip. Past this the chip goes neutral and the
 *  sentence's age carries the whole claim: nothing re-reads the daemon on its own, and a host's
 *  sshd configuration is rewritten by things this manager does not drive — cloud-init writes its
 *  own drop-in again on every boot. Nothing else keys on this; age does not make "on" any less
 *  true, and the other states are already warn. */
export const PASSWORD_LOGIN_READING_FRESH_MS = 60 * 60 * 1000;

/** What takes a new reading. Every sentence that mentions re-reading ends with this, so the card
 *  never implies a live probe behind the value. */
const RE_READ = "only a run takes a new one";

export interface PasswordLoginChip {
  /** The chip text, self-describing beside the role and tailnet chips it sits with. */
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
 *  fresh reading from an old one, not to be a clock. */
function readingAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The one place the password-login pair becomes words. Narrows on the READ outcome first, because
 *  that is what carries the provenance, and only then on the state the reading produced. Total over
 *  both — a state with no readable reading behind it is said to be exactly that. */
export function passwordLoginChip(server: ServerView, now: number): PasswordLoginChip {
  const read = server.passwordLogin;
  const state = server.passwordLoginState;
  // "Nothing was measured" has two spellings and they always agree: "unknown" is the column
  // default, and recordPasswordLoginReading writes state and document in one statement.
  if (state === "unknown" || read.kind === "none") {
    return {
      label: "password login: not read",
      className: "chip",
      detail: "No run has read what this server's sshd answers.",
      runId: null,
    };
  }
  if (read.kind === "unsupported") {
    return {
      label: "password login: reading unreadable",
      className: "chip chip--warn",
      detail: `The stored reading is version ${read.v}; this manager reads version 0 only, so ${RE_READ}.`,
      runId: null,
    };
  }
  if (read.kind === "unreadable") {
    return {
      label: "password login: reading unreadable",
      className: "chip chip--warn",
      detail: `The stored reading did not parse (${read.reason}), so ${RE_READ}.`,
      runId: null,
    };
  }

  const { facts } = read;
  const age = readingAge(Math.max(0, now - facts.observedAt));
  const stale = now - facts.observedAt > PASSWORD_LOGIN_READING_FRESH_MS;
  const taken = `Read ${age}; ${RE_READ}.`;
  const runId = facts.runId;
  // The values are quoted from `sshd -T` rather than summarised, because the summary is exactly
  // what a drop-in file can get wrong: the daemon's own words are the only ones that settled it.
  const said =
    `sshd -T said passwordauthentication ${facts.passwordAuthentication ?? "(absent)"}, ` +
    `kbdinteractiveauthentication ${facts.kbdInteractiveAuthentication ?? "(absent)"}, ` +
    `pubkeyauthentication ${facts.pubkeyAuthentication ?? "(absent)"}.`;

  switch (state) {
    case "off":
      return {
        label: "password login: off",
        className: stale ? "chip" : "chip chip--ok",
        detail: `This host takes key logins only. ${said} ${taken}`,
        runId,
      };
    case "on":
      return {
        label: "password login: on",
        className: "chip chip--warn",
        detail: `This host takes a password from anyone who can reach its SSH port. ${said} ${taken}`,
        runId,
      };
    case "unreadable":
      return {
        label: "password login: unreadable",
        className: "chip chip--warn",
        detail:
          `The daemon would not print its effective configuration, so whether this host takes a password is ` +
          `unmeasured — can the login user run sshd -T under sudo? ${taken}`,
        runId,
      };
  }
}

/** Which of the two password-login run kinds a server's card may offer. */
export interface PasswordLoginRunKindOffer {
  disable: boolean;
  enable: boolean;
}

/**
 * Which run kinds this card may offer, and on what.
 *
 * Both drive one host's sshd over this manager's own key, so the one thing they share is that
 * the manager HAS one — `hasKey`, which is the credential itself (server/domains/inventory/write.ts
 * builds it from an unrotated ssh_key row), and which is the same fact the plan refuses on
 * (defs/password-login.kit.ts), so this card can never offer a run the server then rejects. A
 * server's STATUS is not that fact: it says where the machine stands in its deployment, and a
 * deployment that stopped before installing a key still moves it.
 *
 * They are deliberately NOT keyed on the reading. A reading is a snapshot, so "off" an hour ago
 * says nothing about now, and hiding the disable button from a host that once read off would let a
 * stale value decide what the operator may attempt — on the one surface where being wrong means an
 * open door nobody is looking at. Each run kind reads the live daemon and says what it found.
 *
 * The MASTER is offered both, unlike the tailnet run kinds: it is an internet-facing machine with an
 * sshd like any other, and its own card is the only place its password door is visible.
 */
export function passwordLoginRunKindOffer(server: ServerView): PasswordLoginRunKindOffer {
  return { disable: server.hasKey, enable: server.hasKey };
}
