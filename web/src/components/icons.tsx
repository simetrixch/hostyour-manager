import type { JSX } from "react";

/** Self-contained inline SVG icons (strict CSP: no icon fonts, no CDN). Stroke icons inherit
 *  currentColor so they follow the text tone of whatever primitive they sit in. */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export type NavIconName = "clusters" | "servers" | "runs" | "branches" | "reset" | "consumers" | "tenants" | "sizes";

/** Nav glyphs, keyed by the NAV config's icon id (clusters = overview grid, servers = rack,
 *  runs = terminal prompt, branches = git-branch, reset = restore arrow, consumers = package box,
 *  sizes = a table of rows and columns — the three sizes and their figures,
 *  tenants = stacked layers — one pointer fanning out to a multi-app package). */
export function NavIcon({ name, size = 18 }: { name: NavIconName; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      {name === "clusters" && (
        <>
          <rect x="3" y="3" width="7.5" height="9.5" rx="1.5" />
          <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5" />
          <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.5" />
          <rect x="3" y="15.5" width="7.5" height="5.5" rx="1.5" />
        </>
      )}
      {name === "servers" && (
        <>
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </>
      )}
      {name === "runs" && (
        <>
          <path d="m5 17 6-5-6-5" />
          <path d="M13 19h6" />
        </>
      )}
      {name === "branches" && (
        <>
          <path d="M6 3.5v12" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <path d="M18 8.5a9 9 0 0 1-9 9" />
        </>
      )}
      {name === "sizes" && (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M3 15h18M9 4v16" />
        </>
      )}
      {name === "reset" && (
        <>
          <path d="M1.5 4v6h6" />
          <path d="M3.8 15a9 9 0 1 0 2.1-9.4L1.5 10" />
        </>
      )}
      {name === "consumers" && (
        <>
          <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
        </>
      )}
      {name === "tenants" && (
        <>
          <path d="M12 2.5 21 7l-9 4.5L3 7Z" />
          <path d="m21 12-9 4.5L3 12" />
          <path d="m21 17-9 4.5L3 17" />
        </>
      )}
    </svg>
  );
}

/** Brand mark: a master node fanned out to two slave nodes — the controller's star topology. */
export function LogoMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="var(--accent-bg)" />
      <path
        d="M10.9 8.9 8.2 14.4M13.1 8.9l2.7 5.5"
        stroke="var(--on-accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.75"
      />
      <circle cx="12" cy="7.2" r="1.9" fill="var(--on-accent)" />
      <circle cx="7.2" cy="16.4" r="1.9" fill="var(--on-accent)" />
      <circle cx="16.8" cy="16.4" r="1.9" fill="var(--on-accent)" />
    </svg>
  );
}

export function IconSignOut({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function IconChevronRight({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function IconLock({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function IconShield({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
    </svg>
  );
}
