// The consumer-PAT scope contract. Onboarding is a two-way deal: the platform
// GIVES the consumer a home (namespace, build, deploy, managed Vault credentials) and TAKES a small,
// DECLARED set of rights INTO the consumer's own GitHub repo. Every one of those rights is required for
// a concrete onboard step:
//
//   repo             — clone the repo (read) AND push the release-kit scripts (contents write)
//   workflow         — commit .github/workflows/release.yml (GitHub refuses to let a PAT create/update
//                      a workflow file without it)
//   admin:repo_hook  — create the build webhook (push → Tekton)
//
// This module is the SINGLE source of truth for that set. Before the preflight-scopes gate, the scopes
// were discovered REACTIVELY — the run failed at setup-webhook for a missing admin:repo_hook, then (once
// fixed) at inject-release-kit for a missing workflow — and every miss cost a fresh token round-trip
// with the consumer (a classic PAT's scopes cannot be edited after creation). The gate reads a token's
// granted scopes once, up front, and reports the COMPLETE missing set in a single message.
//
// Pure: no IO. The adapter reads the raw X-OAuth-Scopes list; this module decides what is required.

/** The classic-PAT scopes an onboard requires on the consumer repo, in canonical (message) order. */
export const REQUIRED_CONSUMER_PAT_SCOPES = ["repo", "workflow", "admin:repo_hook"] as const;

export type ConsumerPatScope = (typeof REQUIRED_CONSUMER_PAT_SCOPES)[number];

/** Each required scope + the onboard step that needs it — for a human-readable failure message. */
export const CONSUMER_PAT_SCOPE_REASONS: Readonly<Record<ConsumerPatScope, string>> = {
  repo: "clone the repo and push the release scripts",
  workflow: "commit the release workflow (.github/workflows/release.yml)",
  "admin:repo_hook": "create the build webhook (push → Tekton)",
};

// Which GRANTED scopes satisfy each REQUIRED one. A granted parent scope covers a required capability
// even when the exact name differs: `admin:repo_hook` is satisfied by the narrower `write:repo_hook`
// (enough to create a hook), so an operator who deliberately minted a tighter token is not falsely
// rejected. `repo` and `workflow` have no narrower equivalent that still works here, so each is only
// satisfied by itself. A granted `repo` implies its OWN sub-scopes but NEVER `workflow` or
// `admin:repo_hook` (both are separate top-level classic scopes), so membership is the right test.
const SATISFIED_BY: Readonly<Record<ConsumerPatScope, readonly string[]>> = {
  repo: ["repo"],
  workflow: ["workflow"],
  "admin:repo_hook": ["admin:repo_hook", "write:repo_hook"],
};

/** The required scopes NOT granted by a token, in canonical order (empty ⇒ the token is sufficient).
 *  `granted` is the raw X-OAuth-Scopes list (comma-split); it is trimmed + de-blanked here so the caller
 *  can pass it straight through. Pure. */
export function missingConsumerPatScopes(granted: readonly string[]): ConsumerPatScope[] {
  const have = new Set(granted.map((s) => s.trim()).filter(Boolean));
  return REQUIRED_CONSUMER_PAT_SCOPES.filter((req) => !SATISFIED_BY[req].some((s) => have.has(s)));
}

/** A one-line "scope (why)" enumeration of the full required set — the shared tail of every
 *  preflight-scopes failure message, so the operator always sees the COMPLETE contract, not just the
 *  gap. */
export function requiredConsumerPatScopesSummary(): string {
  return REQUIRED_CONSUMER_PAT_SCOPES.map((s) => `${s} (${CONSUMER_PAT_SCOPE_REASONS[s]})`).join("; ");
}
