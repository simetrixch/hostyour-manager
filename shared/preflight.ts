// Preflight report shapes. The check OUTCOME (`status`) is split from whether a failure BLOCKS the
// run that took it (`severity`), and the report carries the TOFU host key + timestamp. Shared so the
// web card and the server runner agree on one contract.

/** The outcome of a single check. */
export type PreflightStatus = "pass" | "warn" | "fail";

/** Whether a `fail` blocks. `hard` = the run cannot produce a usable server (the wrong processor
 *  architecture, no egress, no git). `soft` = recorded as a warning on the server card and
 *  re-evaluated as `hard` by the provision preflight. */
export type PreflightSeverity = "hard" | "soft";

export interface PreflightCheck {
  id: string; // "os.arch"
  title: string; // "CPU architecture"
  severity: PreflightSeverity;
  status: PreflightStatus;
  detail: string; // "x86_64"
  hint?: string; // actionable fix shown on failure
}

export interface PreflightReport {
  /** SHA256:… of the host key, recorded trust-on-first-use at the first connect. */
  hostKey?: string;
  /** epoch ms the checks ran. */
  checkedAt: number;
  checks: PreflightCheck[];
}

/** The gate: only a HARD check that FAILED blocks. Soft fails ride along as warnings
 *  (they become hard at provision time). */
export function hasHardFailure(report: PreflightReport): boolean {
  return report.checks.some((c) => c.severity === "hard" && c.status === "fail");
}

/** The shape of a host-key fingerprint, which is what `ssh-keygen -lf` prints and what the SSH
 *  adapter compares: the literal `SHA256:` followed by the base64 of a 32-byte digest with its
 *  padding stripped, which is always 43 characters. Named here because two sides check it against
 *  the same rule — the browser, so a person is told about a typo before a round trip, and the
 *  inventory write, which is the boundary that decides what may be pinned on a row. */
export const HOST_KEY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * Read a host-key fingerprint out of what a person typed, or answer null where it is not one.
 *
 * SURROUNDING WHITESPACE IS THE ONE THING FORGIVEN, because the value is copied off a terminal and
 * arrives with a newline or a leading space more often than not. Everything else is refused rather
 * than repaired: a fingerprint is compared byte for byte during key exchange, so a value this
 * function has "helped" is a pin no machine can ever satisfy, and the run refuses with a number the
 * person never typed.
 *
 * `ssh-keygen -lf` prints the fingerprint inside a line that also carries the key size and the
 * comment; only the fingerprint field belongs here, so a whole line is refused too.
 */
export function readHostKeyFingerprint(typed: string): string | null {
  const value = typed.trim();
  return HOST_KEY_FINGERPRINT_RE.test(value) ? value : null;
}
