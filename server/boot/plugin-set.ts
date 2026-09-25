import type { z } from "zod";
import { ConfigError } from "../kernel/config.ts";
import type { Core, Plugin, Wiring } from "../plugin.ts";

/** A plugin PLUGINS names, activated: its name and what it brought. */
export interface ActivePlugin {
  readonly name: string;
  readonly wiring: Wiring;
}

interface Requiring {
  readonly name: string;
  readonly requires?: readonly string[] | undefined;
}

/** `items` in an order where each stands after every one it requires. Every name an item requires
 *  must be among them, and items that require each other are refused. */
export function inDependencyOrder<T extends Requiring>(items: readonly T[]): T[] {
  const names = new Set(items.map((p) => p.name));
  const missing = items.flatMap((p) => (p.requires ?? []).filter((r) => !names.has(r)).map((r) => `${p.name} requires ${r}, which is not among ${[...names].join(", ")}`));
  if (missing.length > 0) throw new ConfigError(missing);
  const ordered: T[] = [];
  const placed = new Set<string>();
  let rest = [...items];
  while (rest.length > 0) {
    const ready = rest.filter((p) => (p.requires ?? []).every((r) => placed.has(r)));
    if (ready.length === 0) throw new ConfigError([`${rest.map((p) => p.name).join(", ")} require each other`]);
    for (const p of ready) {
      ordered.push(p);
      placed.add(p.name);
    }
    rest = rest.filter((p) => !placed.has(p.name));
  }
  return ordered;
}

/**
 * Activates the plugins `named` (the key PLUGINS) out of the ones this build `compiled`, each after
 * the plugins it requires, and returns them in that order. Collects every problem and throws once,
 * as parseConfig does. Refused: a name the build does not carry; a name given twice; a plugin
 * requiring one that is not active; a plugin `env` that does not parse; a key of a compiled but
 * inactive plugin standing in `env` (a plugin's `env` strips what it does not declare, so an unused
 * key would otherwise be dropped in silence); a run kind brought by two plugins, or by a plugin and
 * the core (`coreKinds`). An empty `named` activates nothing: the core alone is a product.
 */
export function activatePlugins(
  compiled: readonly Plugin[],
  named: readonly string[],
  core: Omit<Core, "plugins">,
  env: NodeJS.ProcessEnv,
  coreKinds: ReadonlySet<string>,
): ActivePlugin[] {
  const problems: string[] = [];
  const byName = new Map(compiled.map((p) => [p.name, p]));
  const seen = new Set<string>();
  const active: Plugin[] = [];
  for (const name of named) {
    if (seen.has(name)) {
      problems.push(`PLUGINS names ${name} twice`);
      continue;
    }
    seen.add(name);
    const plugin = byName.get(name);
    if (plugin) active.push(plugin);
    else problems.push(`PLUGINS names ${name}, which this build does not carry (it carries: ${[...byName.keys()].join(", ") || "none"})`);
  }
  const activeNames = new Set(active.map((p) => p.name));
  for (const p of active) {
    for (const r of p.requires ?? []) if (!activeNames.has(r)) problems.push(`${p.name} requires ${r}, which PLUGINS does not name`);
  }
  const activeKeys = new Set(active.flatMap((p) => Object.keys(p.env.shape)));
  for (const p of compiled) {
    if (activeNames.has(p.name)) continue;
    for (const key of Object.keys(p.env.shape)) {
      if (env[key] !== undefined && !activeKeys.has(key)) problems.push(`${key} is set, but it belongs to ${p.name}, which PLUGINS does not name`);
    }
  }
  const parsed: { name: string; requires: readonly string[] | undefined; plugin: Plugin; config: z.output<Plugin["env"]> }[] = [];
  for (const p of active) {
    const result = p.env.safeParse(env);
    if (result.success) parsed.push({ name: p.name, requires: p.requires, plugin: p, config: result.data });
    else for (const i of result.error.issues) problems.push(`${p.name}: ${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  const provided = new Map<string, unknown>();
  const broughtBy = new Map<string, string>();
  const activated: ActivePlugin[] = [];
  for (const { name, requires, plugin, config } of inDependencyOrder(parsed)) {
    const wiring = plugin.activate({ ...core, plugins: Object.fromEntries((requires ?? []).map((r) => [r, provided.get(r)])) }, config);
    provided.set(name, wiring.provides);
    for (const { kind } of wiring.definitions) {
      const owner = coreKinds.has(kind) ? "the core" : broughtBy.get(kind);
      if (owner !== undefined) problems.push(`run kind ${kind} is brought by ${owner} and by ${name}`);
      else broughtBy.set(kind, name);
    }
    activated.push({ name, wiring });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return activated;
}
