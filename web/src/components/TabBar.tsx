import { Link, useLocation } from "react-router";
import { NAV, isActivePath } from "../nav.ts";
import { NavIcon } from "./icons.tsx";

/** Mobile primary navigation — a bottom tab bar (below 768px). Rendered from NAV. */
export function TabBar() {
  const { pathname } = useLocation();
  return (
    <nav className="tabbar" aria-label="Primary">
      {NAV.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className={isActivePath(pathname, item.path) ? "tabbar__item tabbar__item--active" : "tabbar__item"}
        >
          <span className="tabbar__icon" aria-hidden="true">
            <NavIcon name={item.icon} size={20} />
          </span>
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
