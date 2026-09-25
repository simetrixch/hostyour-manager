import type { Plugin } from "#core/web/plugin.ts";
import { UnitSizes } from "./pages/UnitSizes.tsx";
import { Dns } from "./pages/Dns.tsx";
import { Settings } from "./pages/Settings.tsx";
import { DnsIcon, SettingsIcon, SizesIcon } from "./icons.tsx";

/** The unit plugin's web half: the size table, the DNS book and the owner credentials. The SPA shows
 *  them while the server names the unit plugin active. */
export const unitWebPlugin: Plugin = {
  name: "unit",
  nav: [
    { path: "/sizes", label: "Sizes", icon: <SizesIcon /> },
    { path: "/dns", label: "DNS", icon: <DnsIcon /> },
    { path: "/settings", label: "Settings", icon: <SettingsIcon /> },
  ],
  routes: [
    { path: "/sizes", element: <UnitSizes /> },
    { path: "/dns", element: <Dns /> },
    { path: "/settings", element: <Settings /> },
  ],
};
