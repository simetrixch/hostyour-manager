// G28 release workflow (HARD). The release kit's one file outside its own directory is
// `.github/workflows/release.yml`, a path a unit may already own for a workflow of its own — a
// package publish on `on: push: tags`, say. inject-release-kit writes every kit file whose bytes
// differ, so that workflow would be replaced in silence three steps after the operator approved. A
// write of this kind is judged before the first write: this gate reads the file at the plan and
// refuses the onboarding while a workflow that is not the kit's stands there.
//
// What passes: no file, the kit's own bytes, and an older kit, which the replace exists to bring
// forward — one with the kit's triggers AND the kit's release-tag filter, or one with
// `workflow_dispatch` alone, the one trigger every kit before the publish job carried. What fails:
// every other file, and a file that is not readable as YAML, because nothing can say what it is.
// Trigger NAMES alone no longer tell the kit apart, because the kit triggers on `push` too: a unit's
// own package publish on `push: tags` beside `workflow_dispatch` carries the same two names.
import { parse as parseYaml } from "yaml";
import type { GateResult } from "../../../../shared/gates.ts";
import { RELEASE_KIT_WORKFLOW } from "#unit/server/release-kit/release-kit.ts";

/** The trigger names a workflow declares under `on:`, in each of the three shapes GitHub reads —
 *  a string, a list or a map — or null for text that is not a workflow file. */
export function workflowTriggers(text: string): string[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  const on = (doc as { on?: unknown } | null)?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.every((t) => typeof t === "string") ? (on as string[]).slice().sort() : null;
  if (on !== null && typeof on === "object") return Object.keys(on).sort();
  return null;
}

/** The `on.push` filter of a workflow file as one comparable string, or null where it declares none
 *  or is not YAML. */
function pushFilter(text: string): string | null {
  try {
    const on = (parseYaml(text) as { on?: unknown } | null)?.on;
    return on !== null && typeof on === "object" && !Array.isArray(on) && "push" in on ? JSON.stringify((on as { push: unknown }).push) : null;
  } catch {
    return null;
  }
}

const KIT_TRIGGERS = workflowTriggers(RELEASE_KIT_WORKFLOW.content);
const KIT_PUSH_FILTER = pushFilter(RELEASE_KIT_WORKFLOW.content);
const OLDER_KIT_TRIGGERS = ["workflow_dispatch"];
const same = (a: readonly string[] | null, b: readonly string[] | null): boolean => a !== null && b !== null && a.join(",") === b.join(",");

export function gateReleaseWorkflow(input: { found: string | null }): GateResult {
  const path = RELEASE_KIT_WORKFLOW.path;
  const base = {
    id: "G28",
    title: "release workflow",
    severity: "hard" as const,
    expected: `${path} is absent, or it is the release kit's own workflow (on: ${KIT_TRIGGERS?.join(", ")}, the push on the kit's release tags) or an older kit (on: ${OLDER_KIT_TRIGGERS.join(", ")}) — the onboarding writes the kit there and may replace nothing else`,
  };
  if (input.found === null) {
    return { ...base, status: "pass", found: `${path} is absent — the kit will be written there`, reason: null, detail: "no release workflow yet" };
  }
  if (input.found === RELEASE_KIT_WORKFLOW.content) {
    return { ...base, status: "pass", found: `${path} carries the current release kit`, reason: null, detail: "release workflow is the kit's" };
  }
  const triggers = workflowTriggers(input.found);
  if ((same(triggers, KIT_TRIGGERS) && pushFilter(input.found) === KIT_PUSH_FILTER) || same(triggers, OLDER_KIT_TRIGGERS)) {
    return { ...base, status: "pass", found: `${path} carries an older release kit (on: ${triggers?.join(", ")}) — the onboarding brings it forward`, reason: null, detail: "release workflow is an older kit" };
  }
  return {
    ...base,
    status: "fail",
    found: triggers === null
      ? `${path} is not readable as a workflow file, so it cannot be the release kit's`
      : `${path} is the unit's own workflow (on: ${triggers.join(", ")}), not the release kit's`,
    reason: `the onboarding writes the release kit to ${path} and would replace this workflow; move it to another file under .github/workflows/ and plan the onboarding again`,
    detail: "release workflow is not the kit's",
    evidence: [{ source: "repo" as const, file: path, fieldPath: "on", value: (triggers ?? ["(unreadable)"]).join(", ").slice(0, 256) }],
  };
}
