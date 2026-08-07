import type { NavIconName } from "./components/icons.tsx";

export interface NavItem {
  path: string;
  label: string;
  icon: NavIconName;
}

/** THE single navigation source (skeleton mobile-DNA). Both the mobile TabBar and the desktop
 *  NavRail render from this — one config, never two drifting copies. Icons are ids resolved
 *  by the shared <NavIcon> (inline SVG — CSP-safe). */
export const NAV: readonly NavItem[] = [
  { path: "/", label: "Clusters", icon: "clusters" },
  { path: "/servers", label: "Servers", icon: "servers" },
  { path: "/consumers", label: "Consumers", icon: "consumers" },
  { path: "/tenants", label: "Tenants", icon: "tenants" },
  { path: "/sizes", label: "Sizes", icon: "sizes" },
  { path: "/branches", label: "Branches", icon: "branches" },
  { path: "/reset", label: "Reset", icon: "reset" },
];

export function isActivePath(current: string, itemPath: string): boolean {
  return itemPath === "/" ? current === "/" : current === itemPath || current.startsWith(`${itemPath}/`);
}
