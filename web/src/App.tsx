import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, useParams } from "react-router";
import { NavRail } from "./components/NavRail.tsx";
import { TabBar } from "./components/TabBar.tsx";
import { LogoMark } from "./components/icons.tsx";
import { getPlugins } from "./api.ts";
import { activeWebPlugins, navFor } from "./nav.ts";
import { compiledPlugins } from "./plugins.ts";

// EACH PAGE IS ITS OWN CHUNK, loaded when its route is first opened. Imported statically, every page
// landed in one bundle the first screen had to load whole, and the build warned that it passed 500 kB.
const Dashboard = lazy(() => import("./pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })));
const Servers = lazy(() => import("./pages/Servers.tsx").then((m) => ({ default: m.Servers })));
const InstallationDomain = lazy(() => import("./pages/InstallationDomain.tsx").then(m => ({ default: m.InstallationDomain })));
const OperatorKeys = lazy(() => import("./pages/OperatorKeys.tsx").then((m) => ({ default: m.OperatorKeys })));
const RunDetail = lazy(() => import("./pages/RunDetail.tsx").then((m) => ({ default: m.RunDetail })));
const Branches = lazy(() => import("./pages/Branches.tsx").then((m) => ({ default: m.Branches })));
const Mail = lazy(() => import("./pages/Mail.tsx").then((m) => ({ default: m.Mail })));
const ResetWizard = lazy(() => import("./pages/ResetWizard.tsx").then((m) => ({ default: m.ResetWizard })));
const Consumers = lazy(() => import("./pages/Consumers.tsx").then((m) => ({ default: m.Consumers })));
const ConsumerOnboard = lazy(() => import("./pages/ConsumerOnboard.tsx").then((m) => ({ default: m.ConsumerOnboard })));
const Tenants = lazy(() => import("./pages/Tenants.tsx").then((m) => ({ default: m.Tenants })));
const TenantCreate = lazy(() => import("./pages/TenantCreate.tsx").then((m) => ({ default: m.TenantCreate })));
const TenantDetail = lazy(() => import("./pages/TenantDetail.tsx").then((m) => ({ default: m.TenantDetail })));
/** One tenant page per row: a switch of environment mounts it afresh, so no open dialog or loaded row
 *  of the previous environment carries over to the next. */
export function TenantDetailOfRow() {
  return <TenantDetail key={useParams().id} />;
}

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
            <Suspense fallback={<div className="loading"><span className="spinner" aria-hidden="true" />Loading…</div>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/servers" element={<Servers />} />
              <Route path="/installation-domain" element={<InstallationDomain />} />
              {/* Under /servers rather than in NAV: an operator key is a fact about the machines,
                  and isActivePath keeps the Servers rail item lit while the page is open. */}
              <Route path="/servers/keys" element={<OperatorKeys />} />
              <Route path="/consumers" element={<Consumers />} />
              <Route path="/consumers/onboard" element={<ConsumerOnboard />} />
              <Route path="/tenants" element={<Tenants />} />
              <Route path="/tenants/create" element={<TenantCreate />} />
              <Route path="/tenants/:id" element={<TenantDetailOfRow />} />
              {/* The global /runs list was removed; each section owns its runs. The
                  detail route stays — every plan-then-approve and "Last run →" navigates here. */}
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/branches" element={<Branches />} />
              <Route path="/mail" element={<Mail />} />
              <Route path="/reset" element={<ResetWizard />} />
              {pluginRoutes.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
            </Routes>
            </Suspense>
          </main>
        </div>
        <TabBar items={menu} />
      </div>
    </BrowserRouter>
  );
}
