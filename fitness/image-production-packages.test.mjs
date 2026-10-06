// THE RULE: the Manager image ships the production packages and nothing else.
//
// The runtime stage takes its node_modules from a stage that ran `npm ci --omit=dev`, never from
// the build stage, so a test or build tool (vitest, vite, eslint) is not a package inside the
// running image, and an alert in one of them is not an alert in production.
//
// That only works while everything the server loads at run time is declared under `dependencies`.
// The server runs under tsx, so tsx itself is one of those, and so is every package a shipped
// server, shared or plugin-server file imports. Tests, fixtures, suites and the plugins' browser
// code are held out: none of them is loaded by `server/index.ts`. A package counts as imported by
// `from "x"`, `import "x"`, `import("x")`, `require("x")` and `createRequire(...)("x")`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const pkg = JSON.parse(read("package.json"));

const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
  return [path];
});

const HELD_OUT = /\.(test|fixture|suite)\.tsx?$|\.tsx$/;
const shippedFiles = () => ["server", "shared", "plugins"]
  .flatMap(walk)
  .filter((file) => /\.ts$/.test(file) && !HELD_OUT.test(file))
  .filter((file) => !file.split(sep).includes("web"));

const packageOf = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

const importedPackages = (text) => {
  const found = new Set();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifier = /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\(|\bcreateRequire\([^)]*\)\s*\()\s*["']([^"'\s$./#][^"'\s$]*)["']/g;
  for (const match of code.matchAll(specifier)) {
    if (!match[1].startsWith("node:")) found.add(packageOf(match[1]));
  }
  return found;
};

const runtimeStage = () => {
  const text = read("Containerfile");
  const start = text.search(/^FROM .* AS runtime$/m);
  return start === -1 ? "" : text.slice(start);
};

describe("the Manager image ships only production packages", () => {
  it("reads the shipped trees, so a clean answer means they were looked at", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(100);
    const all = new Set(files.flatMap((file) => [...importedPackages(read(file))]));
    for (const name of ["hono", "drizzle-orm", "zod"]) expect(all.has(name), name).toBe(true);
  });

  it("sees a package in every import form a server file may use, and none in a local path or a text", () => {
    const seen = (text) => [...importedPackages(text)].sort();
    expect(seen('import "vite";')).toEqual(["vite"]);
    expect(seen('import { a } from "hono";\nimport type { B } from "@scope/pkg/sub";')).toEqual(["@scope/pkg", "hono"]);
    expect(seen('const m = await import("zod");')).toEqual(["zod"]);
    expect(seen('const load = createRequire(import.meta.url)("typescript");')).toEqual(["typescript"]);
    expect(seen('const require = createRequire(import.meta.url);\nconst ssh = require("ssh2");')).toEqual(["ssh2"]);
    expect(seen('import { x } from "./local.js";\nimport fs from "node:fs";\nlog("import done");\n// import "eslint";')).toEqual([]);
  });

  it("declares every package the shipped server imports under dependencies", () => {
    const wanted = new Set(shippedFiles().flatMap((file) => [...importedPackages(read(file))]));
    const loader = /"--import",\s*"([^"]+)"/.exec(runtimeStage().match(/^CMD .*$/m)?.[0] ?? "");
    expect(loader, "the CMD names its loader").not.toBeNull();
    wanted.add(loader[1]);
    const missing = [...wanted].filter((name) => !(name in pkg.dependencies)).sort();
    expect(missing).toEqual([]);
  });

  it("builds the runtime stage's node_modules from a production-only install", () => {
    const runtime = runtimeStage();
    expect(runtime).toMatch(/^COPY --from=prod-deps \/app\/node_modules \.\/node_modules$/m);
    expect(runtime).not.toMatch(/COPY --from=build \/app\/node_modules/);
    const stage = read("Containerfile").match(/^FROM .* AS prod-deps$[\s\S]*?(?=^FROM )/m)?.[0] ?? "";
    expect(stage).toMatch(/^RUN npm ci --omit=dev$/m);
  });

  it("keeps the build stage's full install, which the SPA build needs", () => {
    const build = read("Containerfile").match(/^FROM .* AS build$[\s\S]*?(?=^FROM )/m)?.[0] ?? "";
    expect(build).toMatch(/^RUN npm ci$/m);
  });
});
