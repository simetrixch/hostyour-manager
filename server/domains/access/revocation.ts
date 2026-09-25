// Process-global session controls. Module-level state by design — like
// the redactor, these are inherently per-process. bootEpoch fail-closes every session across
// a restart: under SSO that's the safe direction AND the cheap one (one silent redirect).
let bootEpoch = Date.now();
const revokedJtis = new Set<string>();

export function bootEpochMs(): number {
  return bootEpoch;
}

export function revokeJti(jti: string): void {
  revokedJtis.add(jti);
}

export function isRevoked(jti: string): boolean {
  return revokedJtis.has(jti);
}

/** Test-only: simulate a process restart (bumps bootEpoch so prior sessions fail-close). */
export function __setBootEpochForTest(ms: number): void {
  bootEpoch = ms;
}
