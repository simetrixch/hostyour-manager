// The redaction chokepoint. Defense-in-depth: steps must never PRINT
// secrets; this catches the accident (a remote script echoing something). Used by the
// executor's log(), step error capture, and checkpoint().
//
// Process-global registry by design — a secret registered anywhere must be masked
// everywhere. This is the one deliberate module-level state in the codebase — a security
// invariant, not a service.
const registry = new Map<string, Set<string>>();

/** Register run-scoped secret values (password bytes, opened key material) as they enter
 *  RunSecrets / withOpened. Trivially short values are ignored to avoid over-masking. */
export function registerSecret(scope: string, value: Buffer): void {
  const s = value.toString("utf8");
  if (s.length < 4) return;
  const set = registry.get(scope) ?? new Set<string>();
  set.add(s);
  registry.set(scope, set);
}

export function unregisterScope(scope: string): void {
  registry.delete(scope);
}

// Generic patterns caught even when not explicitly registered.
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
];

export function redact(text: string): string {
  let out = text;
  for (const set of registry.values()) {
    for (const secret of set) {
      if (secret) out = out.split(secret).join("•••");
    }
  }
  for (const re of PATTERNS) out = out.replace(re, "•••");
  return out;
}
