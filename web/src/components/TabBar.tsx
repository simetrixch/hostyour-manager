import { Link, useLocation } from "react-router";
import { isActivePath, type MenuItem } from "../nav.ts";
import { MenuIcon } from "./icons.tsx";

/** Mobile primary navigation — a bottom tab bar (below 768px). The same menu as the NavRail. */
export function TabBar({ items }: { items: readonly MenuItem[] }) {
  const { pathname } = useLocation();
  return (
    <nav className="tabbar" aria-label="Primary">
      {items.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className={isActivePath(pathname, item.path) ? "tabbar__item tabbar__item--active" : "tabbar__item"}
        >
          <span className="tabbar__icon" aria-hidden="true">
            <MenuIcon item={item} size={20} />
          </span>
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
