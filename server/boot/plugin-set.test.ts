import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ConfigError } from "../kernel/config.ts";
import type { Core, Plugin } from "../plugin.ts";
import { noopDef } from "../domains/runs/defs/noop.run.ts";
import { activatePlugins, inDependencyOrder } from "./plugin-set.ts";

// The planted plugins below never read the core they are handed; they only record it.
const core = {} as Omit<Core, "plugins">;

interface Planted {
  requires?: string[];
  env?: z.ZodObject<z.ZodRawShape>;
  kinds?: string[];
  provides?: unknown;
  handed?: { core: Core; config: unknown }[];
}

function planted(name: string, p: Planted = {}): Plugin {
  return {
    name,
    ...(p.requires ? { requires: p.requires } : {}),
    env: p.env ?? z.object({}),
    schema: {},
    migrations: "unused",
    activate(c, config) {
      p.handed?.push({ core: c, config });
      return { definitions: (p.kinds ?? []).map((kind) => ({ ...noopDef, kind })), provides: p.provides };
    },
  };
}

function refusal(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error("nothing was refused");
}

const NO_KINDS = new Set<string>();

describe("activating the plugins PLUGINS names", () => {
  it("activates nothing for an empty PLUGINS: the core alone is a product", () => {
    expect(activatePlugins([planted("base")], [], core, {}, NO_KINDS)).toEqual([]);
    expect(activatePlugins([], [], core, {}, NO_KINDS)).toEqual([]);
  });

  it("activates each after what it requires, and hands it the provides of those and its own parsed env", () => {
    const handed: { core: Core; config: unknown }[] = [];
    const base = planted("base", { env: z.object({ BASE_KEY: z.string() }), kinds: ["base-x"], provides: { shared: 1 }, handed });
    const leaf = planted("leaf", { requires: ["base"], kinds: ["leaf-x"], handed });
    const active = activatePlugins([leaf, base], ["leaf", "base"], core, { BASE_KEY: "v", OTHER: "o" }, NO_KINDS);
    expect(active.map((a) => a.name)).toEqual(["base", "leaf"]);
    expect(active.map((a) => a.wiring.definitions.map((d) => d.kind))).toEqual([["base-x"], ["leaf-x"]]);
    expect(handed.map((h) => h.config)).toEqual([{ BASE_KEY: "v" }, {}]);
    expect(handed.map((h) => h.core.plugins)).toEqual([{}, { base: { shared: 1 } }]);
  });

  it("REFUSES a name the build does not carry", () => {
    expect(refusal(() => activatePlugins([planted("base")], ["ghost"], core, {}, NO_KINDS))).toEqual([
      "PLUGINS names ghost, which this build does not carry (it carries: base)",
    ]);
  });

  it("REFUSES a name given twice", () => {
    expect(refusal(() => activatePlugins([planted("base")], ["base", "base"], core, {}, NO_KINDS))).toEqual(["PLUGINS names base twice"]);
  });

  it("REFUSES a plugin that requires one PLUGINS does not name", () => {
    const compiled = [planted("base"), planted("leaf", { requires: ["base"] })];
    expect(refusal(() => activatePlugins(compiled, ["leaf"], core, {}, NO_KINDS))).toEqual(["leaf requires base, which PLUGINS does not name"]);
  });

  it("REFUSES a run kind brought by two plugins, and one brought by a plugin and the core", () => {
    const compiled = [planted("base", { kinds: ["shared-x", "noop"] }), planted("leaf", { requires: ["base"], kinds: ["shared-x"] })];
    expect(refusal(() => activatePlugins(compiled, ["base", "leaf"], core, {}, new Set(["noop"])))).toEqual([
      "run kind noop is brought by the core and by base",
      "run kind shared-x is brought by base and by leaf",
    ]);
  });

  it("REFUSES a plugin env that does not parse, each issue named after its plugin", () => {
    const compiled = [planted("base", { env: z.object({ BASE_KEY: z.string(), BASE_PORT: z.coerce.number().int() }) })];
    const issues = refusal(() => activatePlugins(compiled, ["base"], core, { BASE_PORT: "x" }, NO_KINDS));
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^base: BASE_KEY: /);
    expect(issues[1]).toMatch(/^base: BASE_PORT: /);
  });

  it("REFUSES a key of a compiled but inactive plugin standing in the environment", () => {
    const compiled = [planted("base"), planted("side", { env: z.object({ SIDE_KEY: z.string().optional() }) })];
    expect(refusal(() => activatePlugins(compiled, ["base"], core, { SIDE_KEY: "left over" }, NO_KINDS))).toEqual([
      "SIDE_KEY is set, but it belongs to side, which PLUGINS does not name",
    ]);
  });

  it("names every problem at once, not the first it meets", () => {
    const compiled = [planted("base", { env: z.object({ BASE_KEY: z.string() }) }), planted("leaf", { requires: ["side"] }), planted("side", { env: z.object({ SIDE_KEY: z.string().optional() }) })];
    const issues = refusal(() => activatePlugins(compiled, ["ghost", "base", "base", "leaf"], core, { SIDE_KEY: "x" }, NO_KINDS));
    expect(issues.slice(0, 4)).toEqual([
      "PLUGINS names ghost, which this build does not carry (it carries: base, leaf, side)",
      "PLUGINS names base twice",
      "leaf requires side, which PLUGINS does not name",
      "SIDE_KEY is set, but it belongs to side, which PLUGINS does not name",
    ]);
    expect(issues[4]).toMatch(/^base: BASE_KEY: /);
    expect(issues).toHaveLength(5);
  });
});

describe("the dependency order", () => {
  it("REFUSES plugins that require each other", () => {
    const items = [{ name: "a", requires: ["b"] }, { name: "b", requires: ["a"] }, { name: "c" }];
    expect(refusal(() => inDependencyOrder(items))).toEqual(["a, b require each other"]);
  });

  it("REFUSES a requirement that is not among them", () => {
    expect(refusal(() => inDependencyOrder([{ name: "leaf", requires: ["base"] }]))).toEqual(["leaf requires base, which is not among leaf"]);
  });
});
