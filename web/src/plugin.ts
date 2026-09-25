import type { ReactElement, ReactNode } from "react";

/** The web half of a plugin (server/plugin.ts is the other): its menu entries and its pages. The SPA
 *  shows a plugin only while the server names it active (GET /api/plugins). */
export interface Plugin {
  /** Equals the server half's name. */
  readonly name: string;
  /** Its menu entries, each with its own icon: NavIconName is the core's closed set. */
  readonly nav: readonly { path: string; label: string; icon: ReactNode }[];
  readonly routes: readonly { path: string; element: ReactElement }[];
}
