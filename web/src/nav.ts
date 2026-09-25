import type { ReactNode } from "react";
import type { NavIconName } from "./components/icons.tsx";
import type { Plugin } from "./plugin.ts";

export interface NavItem {
  path: string;
  label: string;
  icon: NavIconName;
}

/** The core's navigation (skeleton mobile-DNA). Both the mobile TabBar and the desktop NavRail
 *  render the menu navFor builds from it and the active plugins' entries — one config, never two
 *  drifting copies. Icons are ids resolved by the shared <NavIcon> (inline SVG — CSP-safe). */
export const NAV: readonly NavItem[] = [
  { path: "/", label: "Dashboard", icon: "clusters" },
  { path: "/servers", label: "Servers", icon: "servers" },
  { path: "/consumers", label: "Consumers", icon: "consumers" },
  { path: "/tenants", label: "Tenants", icon: "tenants" },
  { path: "/branches", label: "Branches", icon: "branches" },
  { path: "/mail", label: "Mail", icon: "mail" },
  { path: "/reset", label: "Reset", icon: "reset" },
];

/** A menu entry an active plugin brings, drawn with the plugin's own icon. */
export interface PluginNavItem {
  path: string;
  label: string;
  icon: ReactNode;
  plugin: string;
}

export type MenuItem = NavItem | PluginNavItem;

/** The web halves of the plugins the server activated, in its order. A name with no web half in this
 *  build brings nothing. */
export function activeWebPlugins(active: readonly string[], compiled: readonly Plugin[]): Plugin[] {
  return active.flatMap((name) => compiled.filter((p) => p.name === name));
}

/** The menu: the core's entries, then each active plugin's. */
export function navFor(active: readonly string[], compiled: readonly Plugin[]): MenuItem[] {
  return [...NAV, ...activeWebPlugins(active, compiled).flatMap((p) => p.nav.map((item) => ({ ...item, plugin: p.name })))];
}

export function isActivePath(current: string, itemPath: string): boolean {
  return itemPath === "/" ? current === "/" : current === itemPath || current.startsWith(`${itemPath}/`);
}
