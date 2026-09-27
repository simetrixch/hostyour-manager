// The Versions dialog's choice, apart from its markup: what each part shows as chosen, what a plan would
// move, and how a version is written for a person.
import type { VersionsView } from "../../shared/api-types.ts";

type Part = VersionsView["parts"][number];

/** The version a part shows as chosen: the operator's choice, else the one it runs where it runs one. */
export function selectedVersion(part: Part, chosen: Readonly<Record<string, string>>): string | undefined {
  return chosen[part.name] ?? (part.running.length === 1 ? part.running[0] : undefined);
}

/** What a plan would move: every part whose choice differs from the one version it runs. */
export function versionChanges(parts: readonly Part[], chosen: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(parts.flatMap((p) => {
    const tag = chosen[p.name];
    return tag !== undefined && !(p.running.length === 1 && p.running[0] === tag) ? [[p.name, tag]] : [];
  }));
}

/** Every part that offers a version, on its newest one. */
export function newestVersions(parts: readonly Part[]): Record<string, string> {
  return Object.fromEntries(parts.flatMap((p) => (p.versions[0] ? [[p.name, p.versions[0].tag]] : [])));
}

/** `0.1.16` for a release or image tag `<x.y.z>-<channel>-<ts14>[-<sha7>]`. */
export const versionOf = (tag: string): string => tag.split("-")[0] ?? tag;

/** `0.1.16 · 27.09.2026 13:51 UTC`, the channel said where it is not stable. */
export function versionLabel(tag: string): string {
  const [version, channel, ts] = tag.split("-");
  const at = ts && ts.length === 14 ? `${ts.slice(6, 8)}.${ts.slice(4, 6)}.${ts.slice(0, 4)} ${ts.slice(8, 10)}:${ts.slice(10, 12)} UTC` : "";
  return [version, channel === "stable" ? "" : channel, at].filter(Boolean).join(" · ");
}
