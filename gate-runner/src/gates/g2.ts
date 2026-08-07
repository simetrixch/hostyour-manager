// gate-runner/src/gates/g2.ts
// G2 "determinism" (hard). Rejects Helm charts whose templates render non-deterministically: any use
// of the cluster-lookup function `lookup`, of `.Capabilities`, or of the install-phase predicates
// `.Release.IsInstall` / `.Release.IsUpgrade` makes `helm template` depend on live cluster state or on
// the install/upgrade phase, so what the sandbox validated is not what ArgoCD later deploys.
//
// The scan inspects Go-template ACTIONS, not raw file bytes, over every file helm may evaluate as a
// template:
//   - every file UNDER A `templates/` DIRECTORY — the root chart's templates/** AND any subchart's
//     charts/*/templates/** — REGARDLESS OF EXTENSION. helm renders a templates/secret.json or an
//     extension-less templates/foo just the same (the chart loader keys on the templates/ path, not
//     the suffix), so an extension allowlist would be a bypass.
//   - values*.yaml / values*.yml at any level: helm's `tpl` can render a value as a template, so a
//     `lookup` hidden in a value must be seen.
// For each such file it extracts the text of every `{{ ... }}` action, SKIPPING comment actions
// (`{{/* ... */}}`, `{{- /* ... */ -}}`), and fails if any action uses a forbidden construct. Matching
// is token-aware (word boundaries), so `include "app.lookupSidecars"` (a partial merely NAMED lookup)
// and `.Values.Capabilities.tier` (a user value named Capabilities) do NOT false-trigger, while the
// built-in `lookup` / `.Capabilities` / `.Release.Is*` do.
import type { CheckGate, GateContext } from "./gate.ts";
import type { GateEvidence, GateResult } from "../../../shared/gates.ts";
import { fail, pass } from "./result.ts";

const ID = "G2";
const TITLE = "determinism";
const SEVERITY = "hard" as const;

/** The forbidden constructs, matched token-aware against an action's text:
 *  - `lookup` as a call, not preceded by a word char or `.` (so `app.lookupSidecars` / `.Values.lookup`
 *    do not match) and ending at a word boundary;
 *  - `.Capabilities` / `.Release.IsInstall` / `.Release.IsUpgrade` where the leading `.` is NOT
 *    preceded by a word char (so `.Values.Capabilities` — a value merely named Capabilities — does not
 *    match, but the built-in ` .Capabilities` / `(.Capabilities` does). */
const FORBIDDEN: readonly { token: string; re: RegExp }[] = [
  { token: "lookup", re: /(?<![\w.])lookup\b/ },
  { token: ".Capabilities", re: /(?<!\w)\.Capabilities\b/ },
  { token: ".Release.IsInstall", re: /(?<!\w)\.Release\.IsInstall\b/ },
  { token: ".Release.IsUpgrade", re: /(?<!\w)\.Release\.IsUpgrade\b/ },
];

const EVIDENCE_CAP = 20; // GateEvidenceSchema caps `evidence` at 20 entries.
const LIST_CAP = 20; // keep `found` bounded even for a hostile chart with very many violations.
const SNIPPET_MAX = 200; // keep a cited action snippet short (the schema value cap is 256).

const EXPECTED =
  "templates must not use lookup / .Capabilities / .Release.IsInstall|IsUpgrade (contract determinism, L7)";

/** `<chartPath>/` with the chart path's trailing slash(es) normalized away and a single slash
 *  re-appended. A file is under the chart iff its forward-slash relpath starts with this prefix. An
 *  empty chart path yields "" — every file is then under the (implicit) chart root. */
function chartPrefix(chartPath: string): string {
  const raw = typeof chartPath === "string" ? chartPath : "";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

/** True if helm would evaluate this chart-relative path as a Go template: any file under a
 *  `templates/` directory (root or subchart) regardless of extension, or a values*.yaml/.yml that
 *  `tpl` can render. */
function isTemplateFile(rel: string): boolean {
  if (rel === "templates" || rel.startsWith("templates/") || rel.includes("/templates/")) return true;
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  return /^values.*\.ya?ml$/.test(base);
}

/** Defensive iterability check so a hostile hand-built ctx.files (not a real Map) cannot crash the
 *  gate — a non-iterable value is simply treated as "no files". */
function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  );
}

// Extracts the text of every NON-COMMENT Go-template action (`{{ ... }}`) from `text`.
//
// Comment actions (opened by `{{` then `/*`, closed by `*/` then `}}`, with optional `{{-` / `-}}`
// trim markers) are skipped whole, so a `lookup` mentioned inside a doc comment does not count. The
// closing `}}` of a non-comment action is found string-literal-aware (Go "...", '...', and raw
// `...` backtick strings), so a `}}` hidden inside a quoted argument — e.g. `{{ printf "}}" (lookup
// ...) }}` — cannot prematurely end the action and smuggle the rest past the scan. An unterminated
// `{{` (or unterminated string/comment) yields no action: such input is a Go parse error that fails
// `helm template` (rejected by the render gate) or is inert data never passed to `tpl`.
function extractActions(text: string): string[] {
  const actions: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const open = text.indexOf("{{", i);
    if (open === -1) break;
    const bodyStart = open + 2;

    // Comment? Allow an optional `-` trim marker and surrounding whitespace before `/*`. Over-matching
    // here only skips input Go would itself reject as a parse error (so it never renders), never a
    // real action.
    let c = bodyStart;
    if (text[c] === "-") c += 1;
    while (c < n && (text[c] === " " || text[c] === "\t" || text[c] === "\n" || text[c] === "\r")) {
      c += 1;
    }
    if (text[c] === "/" && text[c + 1] === "*") {
      const starSlash = text.indexOf("*/", c + 2);
      if (starSlash === -1) break; // unterminated comment: nothing past it executes
      const commentClose = text.indexOf("}}", starSlash + 2);
      if (commentClose === -1) break;
      i = commentClose + 2;
      continue;
    }

    // Non-comment action: walk to the closing `}}`, treating string literals as opaque.
    let quote: string | null = null;
    let p = bodyStart;
    let close = -1;
    while (p < n) {
      const ch = text[p];
      if (quote !== null) {
        if (quote !== "`" && ch === "\\") {
          p += 2; // escape inside "..." / '...' — skip the escaped character
          continue;
        }
        if (ch === quote) quote = null;
        p += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        p += 1;
        continue;
      }
      if (ch === "}" && text[p + 1] === "}") {
        close = p;
        break;
      }
      p += 1;
    }
    if (close === -1) break; // unterminated action: Go parse error (rejected) or inert data
    actions.push(text.slice(bodyStart, close));
    i = close + 2;
  }
  return actions;
}

interface Violation {
  file: string;
  token: string;
  snippet: string; // the offending action, whitespace-collapsed and length-capped
}

/** Collapse an action's whitespace and cap its length so it is safe to cite in `found`/evidence. */
function collapse(action: string): string {
  const s = action.replace(/\s+/g, " ").trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

export const g2: CheckGate = {
  id: ID,
  title: TITLE,
  severity: SEVERITY,
  check(ctx: GateContext): GateResult {
    const prefix = chartPrefix(ctx.chartPath);
    const scope = prefix === "" ? "<chart root>" : prefix;
    let filesScanned = 0;
    let actionsScanned = 0;
    const violations: Violation[] = [];

    const entries = isIterable(ctx.files) ? ctx.files : [];
    for (const pair of entries) {
      // Defensive over a hostile shape: an entry must be a [string, string] pair.
      if (!Array.isArray(pair)) continue;
      const file = pair[0];
      const contents = pair[1];
      if (typeof file !== "string" || typeof contents !== "string") continue;
      if (!file.startsWith(prefix)) continue;
      if (!isTemplateFile(file.slice(prefix.length))) continue;
      filesScanned += 1;
      const actions = extractActions(contents);
      actionsScanned += actions.length;
      for (const action of actions) {
        for (const { token, re } of FORBIDDEN) {
          if (re.test(action)) {
            violations.push({ file, token, snippet: collapse(action) });
          }
        }
      }
    }

    if (violations.length === 0) {
      return pass({
        id: ID,
        title: TITLE,
        severity: SEVERITY,
        expected: EXPECTED,
        found: `Scanned ${actionsScanned} template action(s) across ${filesScanned} file(s) under "${scope}"; none use lookup, .Capabilities, or .Release.IsInstall/IsUpgrade.`,
      });
    }

    const shown = violations
      .slice(0, LIST_CAP)
      .map((v) => `${v.file}: {{ ${v.snippet} }} uses ${v.token}`)
      .join("; ");
    const more = violations.length > LIST_CAP ? ` (and ${violations.length - LIST_CAP} more)` : "";
    const tokens = [...new Set(violations.map((v) => v.token))].join(", ");
    const evidence: GateEvidence[] = violations.slice(0, EVIDENCE_CAP).map((v) => ({
      source: "repo",
      file: v.file,
      value: `{{ ${v.snippet} }}`.slice(0, 256),
    }));

    return fail({
      id: ID,
      title: TITLE,
      severity: SEVERITY,
      expected: EXPECTED,
      found: `${violations.length} non-deterministic template action(s) under "${scope}": ${shown}${more}.`,
      reason:
        `a template action using ${tokens} makes helm template depend on live cluster state or the ` +
        `install/upgrade phase (helm can even evaluate a value as a template via tpl), so the ` +
        `sandbox-validated render is not what deploys; remove these constructs.`,
      evidence,
    });
  },
};
