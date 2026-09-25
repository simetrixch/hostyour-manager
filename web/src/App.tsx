import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router";
import { UnitSizes } from "#unit/web/pages/UnitSizes.tsx";
import { NavRail } from "./components/NavRail.tsx";
import { TabBar } from "./components/TabBar.tsx";
import { LogoMark } from "./components/icons.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Servers } from "./pages/Servers.tsx";
import { OperatorKeys } from "./pages/OperatorKeys.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Branches } from "./pages/Branches.tsx";
import { Mail } from "./pages/Mail.tsx";
import { Settings } from "#unit/web/pages/Settings.tsx";
import { Dns } from "#unit/web/pages/Dns.tsx";
import { ResetWizard } from "./pages/ResetWizard.tsx";
import { Consumers } from "./pages/Consumers.tsx";
import { ConsumerOnboard } from "./pages/ConsumerOnboard.tsx";
import { Tenants } from "./pages/Tenants.tsx";
import { TenantCreate } from "./pages/TenantCreate.tsx";
import { TenantDetail } from "./pages/TenantDetail.tsx";
import { getPlugins } from "./api.ts";
import { activeWebPlugins, navFor } from "./nav.ts";
import { compiledPlugins } from "./plugins.ts";

/**
 * The authenticated shell. NavRail (desktop) and TabBar (mobile) both render the one menu navFor
 * builds; the mobile topbar carries brand + sign-out, the desktop rail takes both over (topbar hides
 * at the 768px breakpoint). The server owns auth entirely — the SPA sits behind the chokepoint, so
 * there is no login/403 route here (server-rendered pages).
 *
 * The menu and the routes are the core's, plus those of every plugin the server names active. Until
 * that answer arrives, and where it cannot be read, the core's alone are shown: no plugin page is
 * offered that the server has not said it serves.
 */
export function App() {
  const [active, setActive] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    getPlugins()
      .then((v) => { if (alive) setActive(v.active); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const menu = navFor(active, compiledPlugins);
  const pluginRoutes = activeWebPlugins(active, compiledPlugins).flatMap((p) => p.routes);
  return (
    <BrowserRouter>
      <div className="layout">
        <NavRail items={menu} />
        <div className="shell">
          <header className="topbar">
            <span className="topbar__brand">
              <LogoMark size={20} />
              <strong>Manager</strong>
            </span>
            <a className="topbar__signout" href="/auth/logout">
              Sign out
            </a>
          </header>
          <main className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/servers" element={<Servers />} />
              {/* Under /servers rather than in NAV: an operator key is a fact about the machines,
                  and isActivePath keeps the Servers rail item lit while the page is open. */}
              <Route path="/servers/keys" element={<OperatorKeys />} />
              <Route path="/consumers" element={<Consumers />} />
              <Route path="/consumers/onboard" element={<ConsumerOnboard />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/tenants" element={<Tenants />} />
              <Route path="/tenants/create" element={<TenantCreate />} />
              <Route path="/tenants/:id" element={<TenantDetail />} />
              {/* The global /runs list was removed; each section owns its runs. The
                  detail route stays — every plan-then-approve and "Last run →" navigates here. */}
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/sizes" element={<UnitSizes />} />
              <Route path="/branches" element={<Branches />} />
              <Route path="/mail" element={<Mail />} />
              <Route path="/dns" element={<Dns />} />
              <Route path="/reset" element={<ResetWizard />} />
              {pluginRoutes.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
            </Routes>
          </main>
        </div>
        <TabBar items={menu} />
      </div>
    </BrowserRouter>
  );
}
