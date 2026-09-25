import { describe, it, expect } from "vitest";
import { NAV, activeWebPlugins, navFor } from "./nav.ts";
import type { Plugin } from "./plugin.ts";
import { compiledPlugins } from "./plugins.ts";

const plugin = (name: string, path: string): Plugin => ({ name, nav: [{ path, label: name, icon: null }], routes: [] });

describe("the menu", () => {
  it("is the core's alone while no plugin is active", () => {
    expect(navFor([], [plugin("alpha", "/alpha")])).toEqual([...NAV]);
  });

  it("adds each active plugin's entries after the core's, in the order the server activated them", () => {
    const compiled = [plugin("alpha", "/alpha"), plugin("beta", "/beta")];
    expect(navFor(["beta", "alpha"], compiled).slice(NAV.length)).toEqual([
      { path: "/beta", label: "beta", icon: null, plugin: "beta" },
      { path: "/alpha", label: "alpha", icon: null, plugin: "alpha" },
    ]);
  });

  it("brings nothing for an active name that has no web half in this build", () => {
    expect(activeWebPlugins(["server-only"], [plugin("alpha", "/alpha")])).toEqual([]);
  });

  it("brings the unit plugin's Sizes, DNS and Settings after the core's entries, and nothing while it is not active", () => {
    expect(navFor(["unit"], compiledPlugins).slice(NAV.length).map((item) => [item.path, item.label])).toEqual([
      ["/sizes", "Sizes"], ["/dns", "DNS"], ["/settings", "Settings"],
    ]);
    expect(activeWebPlugins(["unit"], compiledPlugins).flatMap((p) => p.routes.map((r) => r.path))).toEqual(["/sizes", "/dns", "/settings"]);
    expect(navFor([], compiledPlugins)).toEqual([...NAV]);
  });

  it("opens on the Dashboard, at the root", () => {
    expect(NAV[0]).toEqual({ path: "/", label: "Dashboard", icon: "clusters" });
  });
});
