import { BrowserRouter, Routes, Route } from "react-router";
import { UnitSizes } from "./pages/UnitSizes.tsx";
import { NavRail } from "./components/NavRail.tsx";
import { TabBar } from "./components/TabBar.tsx";
import { LogoMark } from "./components/icons.tsx";
import { Clusters } from "./pages/Clusters.tsx";
import { Servers } from "./pages/Servers.tsx";
import { AdoptWizard } from "./pages/AdoptWizard.tsx";
import { OperatorKeys } from "./pages/OperatorKeys.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Branches } from "./pages/Branches.tsx";
import { ResetWizard } from "./pages/ResetWizard.tsx";
import { Consumers } from "./pages/Consumers.tsx";
import { ConsumerOnboard } from "./pages/ConsumerOnboard.tsx";
import { Tenants } from "./pages/Tenants.tsx";
import { TenantCreate } from "./pages/TenantCreate.tsx";
import { TenantDetail } from "./pages/TenantDetail.tsx";

/**
 * The authenticated shell. NavRail (desktop) and TabBar (mobile) both render
 * from the single NAV config; the mobile topbar carries brand + sign-out, the desktop rail
 * takes both over (topbar hides at the 768px breakpoint). The server owns auth entirely — the
 * SPA sits behind the chokepoint, so there is no login/403 route here (server-rendered pages).
 */
export function App() {
  return (
    <BrowserRouter>
      <div className="layout">
        <NavRail />
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
              <Route path="/" element={<Clusters />} />
              <Route path="/servers" element={<Servers />} />
              <Route path="/servers/adopt" element={<AdoptWizard />} />
              {/* Under /servers rather than in NAV: an operator key is a fact about the machines,
                  and isActivePath keeps the Servers rail item lit while the page is open. */}
              <Route path="/servers/keys" element={<OperatorKeys />} />
              <Route path="/consumers" element={<Consumers />} />
              <Route path="/consumers/onboard" element={<ConsumerOnboard />} />
              <Route path="/tenants" element={<Tenants />} />
              <Route path="/tenants/create" element={<TenantCreate />} />
              <Route path="/tenants/:id" element={<TenantDetail />} />
              {/* The global /runs list was removed; each section owns its runs. The
                  detail route stays — every plan-then-approve and "Last run →" navigates here. */}
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/sizes" element={<UnitSizes />} />
              <Route path="/branches" element={<Branches />} />
              <Route path="/reset" element={<ResetWizard />} />
            </Routes>
          </main>
        </div>
        <TabBar />
      </div>
    </BrowserRouter>
  );
}
