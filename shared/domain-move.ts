import { z } from "zod";
import { publicFqdn } from "./consumer.ts";

export const DomainChangeSchema = z.object({
  path: z.array(z.string()).min(1), before: z.string(), after: z.string(),
  anchors: z.array(z.object({ path: z.array(z.string()), value: z.string() })),
});
export type DomainChange = z.infer<typeof DomainChangeSchema>;

export function moveDomain(host: string, from: string, to: string): string {
  if (host.length > 253) throw new Error("hostname exceeds the DNS length limit");
  const prefix = host.startsWith("*.") ? "*." : "";
  const bare = prefix ? host.slice(2) : host;
  publicFqdn.parse(bare);
  const next = bare === from ? to : bare.endsWith(`.${from}`) ? bare.slice(0, -from.length) + to : bare;
  publicFqdn.parse(next);
  if ((prefix + next).length > 253) throw new Error("mapped hostname exceeds the DNS length limit");
  return prefix + next;
}

/** Only public addresses are journaled; connection strings and signed URLs never enter a plan. */
export function movePublicAddress(value: string, from: string, to: string): string {
  if (value.startsWith(".") && publicFqdn.safeParse(value.slice(1)).success) return `.${moveDomain(value.slice(1), from, to)}`;
  if (publicFqdn.safeParse(value).success) return moveDomain(value, from, to);
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("a public domain address contains credentials, a query or a fragment");
  if (moveDomain(url.hostname, from, to) === url.hostname) return value;
  url.hostname = moveDomain(url.hostname, from, to);
  return url.toString().replace(/\/$/, value.endsWith("/") ? "/" : "");
}

function at(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, root);
}

export function domainChanges(root: unknown, from: string, to: string, prefixes: readonly string[]): DomainChange[] {
  const changes: DomainChange[] = [];
  const walk = (value: unknown, path: string[], anchors: DomainChange["anchors"]): void => {
    if (typeof value === "string") {
      const field = path.at(-1) ?? "";
      const envName = anchors.filter(a => a.path.at(-1) === "name").at(-1)?.value ?? "";
      const domainField = /(?:domain|fqdn|host|url|issuer|origin|apex|endpoint)/i;
      if (!domainField.test(field) && !path.includes("ownDomainRedirects") && !(field === "value" && domainField.test(envName))) return;
      let after: string;
      try { after = movePublicAddress(value, from, to); }
      catch { throw new Error(`domain field ${path.join(".")} cannot be safely journaled`); }
      if (after !== value) changes.push({ path, before: value, after, anchors });
    } else if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      const marks = [...anchors];
      for (const key of ["name", "chart"]) if (typeof object[key] === "string") marks.push({ path: [...path, key], value: object[key] });
      for (const key of Object.keys(object).sort()) walk(object[key], [...path, key], marks);
    }
  };
  for (const key of prefixes) walk(at(root, [key]), [key], []);
  return changes;
}

/** Compare individual fields inside the branch turn; retain unrelated edits and refuse shifted arrays. */
export function applyDomainChanges<T>(entry: T, changes: readonly DomainChange[], reverse = false): T {
  const next = structuredClone(entry);
  for (const change of changes) {
    if (change.path.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("unsafe domain field path");
    for (const anchor of change.anchors) if (at(next, anchor.path) !== anchor.value) throw new Error(`domain field ${change.path.join(".")} moved since planning`);
    const before = reverse ? change.after : change.before, after = reverse ? change.before : change.after;
    const standing = at(next, change.path);
    if (standing === after) continue;
    if (standing !== before) throw new Error(`domain field ${change.path.join(".")} changed since planning`);
    const parent = at(next, change.path.slice(0, -1));
    if (parent === null || typeof parent !== "object") throw new Error("a planned domain field no longer exists");
    (parent as Record<string, unknown>)[change.path.at(-1)!] = after;
  }
  return next;
}
