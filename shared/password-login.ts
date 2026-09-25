// The per-server password-login document, stored as JSON in servers.password_login_json beside the
// servers.password_login_state enum — the same pair, written by one statement, that shared/
// tailnet.ts keeps for tailnet membership.
//
// WHAT THIS PAIR IS ABOUT. A host's sshd answers a password or it does not, and the only place
// that question is already answered is the daemon's own `sshd -T` printout: sshd takes the FIRST
// occurrence of a keyword and reads /etc/ssh/sshd_config.d in alphabetical order, so a drop-in that
// sorts late states one thing while the daemon does the other. Nothing here is derived from a
// file's content, and the probe that fills it reads no file either.
import { z } from "zod";
import type { ServerPasswordLoginFacts, ServerPasswordLoginRead } from "./api-types.ts";
import type { ServerPasswordLoginState } from "./enums.ts";

/**
 * ServerPasswordLogin **v0** — one reading of what a host's sshd resolved.
 *
 *  - `v`          — the schema version; ALWAYS 0 for this shape. readServerPasswordLogin narrows
 *                   on it before touching the body, so a future v1 can be added without rewriting
 *                   stored v0 rows and without a v0 reader guessing.
 *  - `observedAt` — epoch ms the reading was taken.
 *  - `runId`      — the run that took it, so the card can link to the log it came from.
 *  - the three `sshd -T` values, each null when the daemon did not print that line.
 *
 * `satisfies z.ZodType<ServerPasswordLoginFacts>` pins the parsed shape to the ONE wire
 * declaration (shared/api-types.ts), so the two cannot drift apart in a green build.
 */
const ServerPasswordLoginV0 = z.object({
  v: z.literal(0),
  observedAt: z.number().int().positive(),
  runId: z.string().min(1),
  passwordAuthentication: z.string().min(1).nullable(),
  kbdInteractiveAuthentication: z.string().min(1).nullable(),
  pubkeyAuthentication: z.string().min(1).nullable(),
}) satisfies z.ZodType<ServerPasswordLoginFacts>;

/** Just the version, read on its own so an unknown version is answered as such instead of failing
 *  the whole body's schema and reading as corruption. */
const Versioned = z.object({ v: z.number().int() });

/** Read a stored password-login document: narrow on `v` FIRST, parse the body only for a version
 *  this build knows, and name every other outcome instead of collapsing it to null. */
export function readServerPasswordLogin(stored: unknown): ServerPasswordLoginRead {
  if (stored === null || stored === undefined) return { kind: "none" };
  const versioned = Versioned.safeParse(stored);
  if (!versioned.success) return { kind: "unreadable", reason: "no version field" };
  if (versioned.data.v !== 0) return { kind: "unsupported", v: versioned.data.v };
  const parsed = ServerPasswordLoginV0.safeParse(stored);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { kind: "v0", facts: parsed.data };
}

/** The word sshd prints for a door it has been told to keep shut. Every other value it can print
 *  for these keywords — "yes", and the "any"/"prohibit-password" family other keywords take — is a
 *  door that is not shut. */
const SHUT = "no";

/** What a host's sshd said about itself, straight off the probe. `readable` is separate from the
 *  three values because a run that could not ask has measured NOTHING, and reporting that silence
 *  as "no password door found" would state as fact the exact thing the run failed to measure. */
export interface PasswordLoginProbe {
  /** `sshd -T` ran and printed a configuration. */
  readable: boolean;
  passwordAuthentication: string | null;
  kbdInteractiveAuthentication: string | null;
  pubkeyAuthentication: string | null;
}

/** Fold one probe into the pair the row stores: the state the card keys on, and the document that
 *  says where that state came from. Written together, in one statement, by one step.
 *
 *  "off" is claimed ONLY when both keywords were READ and both said no. A missing line therefore
 *  reads as "on", which is the direction a security surface has to fall in: an unmeasured door is
 *  not a shut one, and the run kind that shuts it fails loudly rather than letting this fold guess. */
export function passwordLoginReading(
  probe: PasswordLoginProbe,
  meta: { runId: string; observedAt: number },
): { state: ServerPasswordLoginState; doc: ServerPasswordLoginFacts } {
  const state: ServerPasswordLoginState =
    !probe.readable || probe.passwordAuthentication === null
      ? "unreadable"
      : probe.passwordAuthentication === SHUT && probe.kbdInteractiveAuthentication === SHUT
        ? "off"
        : "on";
  return {
    state,
    doc: {
      v: 0,
      observedAt: meta.observedAt,
      runId: meta.runId,
      passwordAuthentication: probe.passwordAuthentication,
      kbdInteractiveAuthentication: probe.kbdInteractiveAuthentication,
      pubkeyAuthentication: probe.pubkeyAuthentication,
    },
  };
}
