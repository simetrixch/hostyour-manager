// THE RULE: every image ships the production packages and nothing else: the Manager image and the
// gate-runner image, which runs as the Tekton gate task.
//
// An image's runtime stage takes its node_modules from a stage that ran `npm ci --omit=dev`, never from
// a full install, so a test or build tool (vitest, vite, eslint) is not a package inside the running
// image, and an alert in one of them is not an alert in production.
//
// That only works while everything an image loads at run time is declared under `dependencies`. Both
// run under tsx, so tsx itself is one of those, and so is every package a shipped file imports. Tests,
// fixtures, suites and browser code are held out: no entry point loads them. A package counts as
// imported by `from "x"`, `import "x"`, `import("x")`, `require("x")` and `createRequire(...)("x")`.

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

/** Each image: its Containerfile, the trees its runtime stage copies, and packages a clean read must see. */
const IMAGES = [
  { name: "Manager", containerfile: "Containerfile", trees: ["server", "shared", "plugins"], atLeast: 100, sure: ["hono", "drizzle-orm", "zod"] },
  { name: "gate-runner", containerfile: "gate-runner/Containerfile", trees: ["gate-runner/src", "shared", "plugins/unit/shared"], atLeast: 20, sure: ["yaml", "zod"] },
];

const shippedFiles = (trees) => trees
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

const runtimeStage = (containerfile) => {
  const text = read(containerfile);
  const start = text.search(/^FROM .* AS runtime$/m);
  return start === -1 ? "" : text.slice(start);
};

/** The packages `files` import, with the runtime's loader, that `dependencies` does not declare. */
const undeclared = (texts, loader, dependencies) => {
  const wanted = new Set(texts.flatMap((text) => [...importedPackages(text)]));
  if (loader) wanted.add(loader);
  return [...wanted].filter((name) => !(name in dependencies)).sort();
};

const loaderOf = (containerfile) => /"--import",\s*"([^"]+)"/.exec(runtimeStage(containerfile).match(/^CMD .*$/m)?.[0] ?? "")?.[1] ?? null;

describe("the production-packages rule itself", () => {
  it("sees a package in every import form a shipped file may use, and none in a local path or a text", () => {
    const seen = (text) => [...importedPackages(text)].sort();
    expect(seen('import "vite";')).toEqual(["vite"]);
    expect(seen('import { a } from "hono";\nimport type { B } from "@scope/pkg/sub";')).toEqual(["@scope/pkg", "hono"]);
    expect(seen('const m = await import("zod");')).toEqual(["zod"]);
    expect(seen('const load = createRequire(import.meta.url)("typescript");')).toEqual(["typescript"]);
    expect(seen('const require = createRequire(import.meta.url);\nconst ssh = require("ssh2");')).toEqual(["ssh2"]);
    expect(seen('import { x } from "./local.js";\nimport fs from "node:fs";\nlog("import done");\n// import "eslint";')).toEqual([]);
  });

  it("PLANTED DEFECT: names a development-only package a shipped file imports, by a static and by a side-effect import", () => {
    const shipped = ['import { describe } from "vitest";', 'import "vite";', 'import { z } from "zod";'];
    expect(undeclared(shipped, "tsx", { zod: "^3", tsx: "^4" })).toEqual(["vite", "vitest"]);
    expect(undeclared(['import { z } from "zod";'], "tsx", { zod: "^3", tsx: "^4" })).toEqual([]);
  });
});

for (const image of IMAGES) {
  describe(`the ${image.name} image ships only production packages`, () => {
    it("reads the shipped trees, so a clean answer means they were looked at", () => {
      const files = shippedFiles(image.trees);
      expect(files.length).toBeGreaterThan(image.atLeast);
      const all = new Set(files.flatMap((file) => [...importedPackages(read(file))]));
      for (const name of image.sure) expect(all.has(name), name).toBe(true);
    });

    it("declares every package the shipped files import, and the runtime's loader, under dependencies", () => {
      const loader = loaderOf(image.containerfile);
      expect(loader, "the CMD names its loader").not.toBeNull();
      expect(undeclared(shippedFiles(image.trees).map(read), loader, pkg.dependencies)).toEqual([]);
    });

    it("builds the runtime stage's node_modules from a production-only install", () => {
      const runtime = runtimeStage(image.containerfile);
      expect(runtime).toMatch(/^COPY --from=prod-deps \/app\/node_modules \.\/node_modules$/m);
      expect(runtime).not.toMatch(/COPY --from=build \/app\/node_modules/);
      const stage = read(image.containerfile).match(/^FROM .* AS prod-deps$[\s\S]*?(?=^FROM )/m)?.[0] ?? "";
      expect(stage).toMatch(/^RUN npm ci --omit=dev$/m);
    });
  });
}

describe("the Manager image's build stage", () => {
  it("keeps the full install, which the SPA build needs", () => {
    const build = read("Containerfile").match(/^FROM .* AS build$[\s\S]*?(?=^FROM )/m)?.[0] ?? "";
    expect(build).toMatch(/^RUN npm ci$/m);
  });
});
