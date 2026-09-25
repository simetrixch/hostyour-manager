import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { isActivePath, type MenuItem } from "../nav.ts";
import { LogoMark, MenuIcon, IconSignOut } from "./icons.tsx";
import { getHealth } from "../api.ts";

/** Desktop primary navigation — a side rail (768px and up). The same menu as the TabBar (nav.ts
 *  navFor). On desktop the rail owns the brand and sign-out (the mobile topbar is hidden there). */
export function NavRail({ items }: { items: readonly MenuItem[] }) {
  const { pathname } = useLocation();
  // The running manager version (image tag), from the public /healthz probe. Shown so the
  // operator can see which version is live. Stays hidden only until the first probe resolves
  // (or if it's unreachable) — never a fabricated placeholder.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => { if (alive) setVersion(h.version); })
      .catch(() => { if (alive) setVersion(null); });
    return () => { alive = false; };
  }, []);
  return (
    <nav className="navrail" aria-label="Primary">
      <div className="navrail__brand">
        <LogoMark />
        <span>Manager</span>
      </div>
      <div className="navrail__items">
        {items.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={isActivePath(pathname, item.path) ? "navrail__item navrail__item--active" : "navrail__item"}
          >
            <span className="navrail__icon" aria-hidden="true">
              <MenuIcon item={item} />
            </span>
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
      <div className="navrail__foot">
        <a className="navrail__item" href="/auth/logout">
          <span className="navrail__icon" aria-hidden="true">
            <IconSignOut />
          </span>
          <span>Sign out</span>
        </a>
        {version !== null && (
          <div className="navrail__version" title="Running manager version (image tag)">v{version}</div>
        )}
      </div>
    </nav>
  );
}
