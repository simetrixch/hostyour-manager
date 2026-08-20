import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A census over the WORD, beside the census over the run kind list in registry-census.test.ts.
// shared/enums.ts:343 names the type RunKind and every literal in RUN_KIND; "verb" is borrowed from
// grammar and names nothing in this codebase. Under the two patterns below it stood 562 times across
// 128 files before #15, which removed 379 of them across 91 — measured with this census, because the
// figure #15's own ticket carried was produced by a different pattern and does not reproduce.
// Nothing then stopped the word standing in web/, so onboard-abort.ts told an operator "Offboard is
// the removal run kind for a serving consumer" while PurgeTenantDialog.tsx said "verb" about the
// same act in the next dialog.
// The sweep is #20; this is what keeps it swept.
//
// Two shapes are searched, because the word arrived in both. In prose and in a prop name it is the
// plain English word, `\bverbs?\b`. In an identifier it is a camelCase segment — `tailnetVerbOffer`,
// `planServerVerb`. Neither pattern matches `verbatim`, which is a different word, and neither
// matches `deleteServerById`, whose letters v-e-r-B are a case-insensitive substring search's false
// positive rather than the word.
//
// KUBE'S WORD IS NOT OURS. server/adapters/kube/port.ts:464 declares `verbs: string[]` because that
// is the name the Kubernetes RBAC API gives the field, and kube-rbac.ts:65 assigns RoleManifest to
// the client's V1Role, whose V1PolicyRule requires it — a rename there does not compile. The four
// files that carry kube's word are named one by one below instead of matched by a pattern, so a new
// file reaching for "verb" fails this census and its author has to say which of the two uses it is.
//
// WHAT IT DOES NOT READ, named rather than counted: `deploy/`, `docker/`, `Containerfile`,
// `README.md` and the config files at the root. Those carry no run kind vocabulary today and a word
// in them reaches nobody through the product's surfaces, which is what this census is about.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_ROOTS = ["server", "shared", "web/src", "gate-runner/src"];
const SELF = "server/domains/runs/run-kind-word-census.test.ts";

/** The files carrying the Kubernetes RBAC field `verbs` and kube's own noun for one grant in a
 *  RoleManifest. Every other file in the tree says "run kind" for a RunKind.
 *
 *  THESE FOUR ARE EXEMPT FROM THE BAN, NOT MERELY FROM THE PATTERN: the word in them is a foreign
 *  API's own name and MUST stay. A file that stops carrying it is a failure of its own — the test
 *  below asserts each still does, because an allowlist entry for a file that no longer needs one
 *  would silently cover a future misuse. */
const KUBE_RBAC_FILES = [
  "server/adapters/kube/kube.ts",
  "server/adapters/kube/port.ts",
  "server/domains/onboarding/build-rbac.ts",
  "server/domains/onboarding/build-rbac.test.ts",
];

/** The English word standing on its own — prose, and a prop declared `verb: "move" | "restore"`. */
const WORD = /\bverbs?\b/i;
/** The word as a camelCase segment of an identifier — `tailnetVerbOffer`, `PasswordLoginVerbOffer`. */
const SEGMENT = /[a-zA-Z]Verbs?(?=[A-Z]|\b)/;

/** Every shipped `.ts`/`.tsx`/`.css` file under the source roots, TESTS AND STYLESHEETS INCLUDED:
 *  the word sat in `web/src/authorizedKeysState.test.ts` and in `web/src/ds/ui.css`, so a census
 *  that read only shipped modules would have reported the tree clean while both still said it. */
function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx?|css)$/.test(entry.name)) continue;
      const path = relative(ROOT, full).replaceAll("\\", "/");
      if (path === SELF) continue;
      out.push({ path, text: readFileSync(full, "utf8") });
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(ROOT, root));
  return out;
}

const says = (text: string): boolean => WORD.test(text) || SEGMENT.test(text);

describe("run-kind word census: one word reaches the operator, and it is RunKind's", () => {
  it("reads every source root, so a clean answer means the tree was looked at", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(400);
    for (const root of SOURCE_ROOTS) {
      expect(files.filter((f) => f.path.startsWith(`${root}/`)).length, root).toBeGreaterThan(5);
    }
    // The two file kinds a module-only walk would have missed.
    expect(files.filter((f) => f.path.endsWith(".test.ts")).length).toBeGreaterThan(50);
    expect(files.filter((f) => f.path.endsWith(".css")).length).toBeGreaterThan(0);
  });

  it("still finds kube's RBAC word in each file the allowlist names — the scan is looking", () => {
    // The innocent case. These four are the only lawful "verb" in the tree, and a file here that has
    // stopped saying it is an allowlist entry that would silently cover a future misuse instead.
    const byPath = new Map(sourceFiles().map((f) => [f.path, f.text]));
    for (const path of KUBE_RBAC_FILES) {
      const text = byPath.get(path);
      expect(text, `${path} is not in the scanned tree`).toBeDefined();
      expect(says(text ?? ""), `${path} no longer carries kube's RBAC word`).toBe(true);
    }
  });

  it("leaves no other file calling a RunKind a verb", () => {
    const offenders = sourceFiles()
      .filter((f) => !KUBE_RBAC_FILES.includes(f.path))
      .filter((f) => says(f.text))
      .map((f) => {
        const line = f.text.split("\n").findIndex((l) => WORD.test(l) || SEGMENT.test(l)) + 1;
        return `${f.path}:${line}`;
      });
    expect(offenders, `files calling a RunKind a verb — say "run kind" (shared/enums.ts RUN_KIND): ${offenders.join(", ")}`)
      .toEqual([]);
  });
});
