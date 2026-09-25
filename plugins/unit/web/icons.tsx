import type { JSX } from "react";

/** The unit plugin's menu glyphs: self-contained inline SVG (strict CSP: no icon fonts, no CDN),
 *  drawn in the core's rail style — stroke icons that inherit currentColor, at the rail's size. */

const stroke = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** A table of rows and columns — the three sizes and their figures. */
export function SizesIcon(): JSX.Element {
  return (
    <svg {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16" />
    </svg>
  );
}

/** A globe with its meridians — the public name space every record of this installation stands in. */
export function DnsIcon(): JSX.Element {
  return (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </svg>
  );
}

/** A cog — the owner credentials the onboardings ask for. */
export function SettingsIcon(): JSX.Element {
  return (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </svg>
  );
}
