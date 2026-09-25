import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A census over config.ts, not a behaviour test: it walks the source and asserts that every key the
// file declares is actually consumed. A config key can die at either end — an env var the schema
// validates but parseConfig never maps into the Config object, and a Config field nothing outside
// this file ever reads — and both leave a key that looks live in the deployment values while
// changing nothing.
//
// Tests are deliberately NOT counted as readers, the same rule the reachability lint runs on: a
// field only config.test.ts still touches is a leftover with a test keeping it warm.
//
// A reader is a member access `.<field>` in shipped source — the grammar the codebase uses
// everywhere (`cfg.port`, `config.oidc.issuer`, `c.master?.fqdn`). A field that appears in none of
// it has no consumer at all.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG_FILE = "server/kernel/config.ts";
const SOURCE_ROOTS = ["server", "shared", "web/src", "gate-runner/src"];

/** Every shipped .ts/.tsx file under the source roots — tests excluded. */
function shippedSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const path = relative(ROOT, full).replaceAll("\\", "/");
      if (path === CONFIG_FILE) continue;
      out.push({ path, text: readFileSync(full, "utf8") });
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(ROOT, root));
  return out;
}

/** The `{...}` starting at `open`, brace-balanced. */
function block(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block at index ${open} of ${CONFIG_FILE}`);
}

/** Comments carry prose like "enable gate: onboarding", which would parse as a field. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const configSource = readFileSync(join(ROOT, CONFIG_FILE), "utf8");
const sources = shippedSources();

describe("config census: every env key reaches the Config object", () => {
  const envKeys = [...configSource.matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\./gm)].map((m) => m[1] as string);

  it("declares env keys at all (the census has something to check)", () => {
    expect(envKeys.length).toBeGreaterThan(20);
    expect(envKeys).toContain("PUBLIC_URL");
  });

  it("reads every EnvSchema key in parseConfig or a refine", () => {
    // `e` is the parsed env inside parseConfig and inside every .refine predicate. A key nobody
    // reads there is validated at boot and then dropped on the floor.
    const unread = envKeys.filter((key) => !new RegExp(`\\be\\.${key}\\b`).test(configSource));
    expect(unread, `EnvSchema keys with no reader in ${CONFIG_FILE}: ${unread.join(", ")}`).toEqual([]);
  });
});

describe("config census: every Config field has a reader", () => {
  const interfaceStart = configSource.indexOf("export interface Config {");
  const body = stripComments(block(configSource, configSource.indexOf("{", interfaceStart)));
  // Field names at every depth — the nested objects (oidc, vault, master, …) are declared inline on
  // one line, so this matches on the `name:` token rather than on line starts.
  const fields = [...new Set([...body.matchAll(/([A-Za-z][A-Za-z0-9_]*)\??\s*:/g)].map((m) => m[1] as string))];

  it("parses the Config interface (the census has something to check)", () => {
    expect(fields).toContain("publicUrl");
    expect(fields).toContain("issuer"); // a nested field, proving the depth walk works
    expect(fields.length).toBeGreaterThan(30);
  });

  it("finds a shipped, non-test reader for every field", () => {
    const orphaned: string[] = [];
    for (const field of fields) {
      const access = new RegExp(`\\.\\s*${field}\\b`);
      if (!sources.some((s) => access.test(s.text))) orphaned.push(field);
    }
    expect(orphaned, `Config fields nothing outside ${CONFIG_FILE} reads: ${orphaned.join(", ")}`).toEqual([]);
  });
});
