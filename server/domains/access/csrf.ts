import type { Config } from "../../kernel/config.ts";

// Same-origin enforcement for unsafe methods. Compares ORIGINS, not raw
// strings — a PUBLIC_URL with a path or trailing slash cannot silently disable the guard.
export function csrfOk(headers: { secFetchSite?: string | undefined; origin?: string | undefined }, config: Config): boolean {
  if (headers.secFetchSite === "same-origin") return true;
  if (headers.origin) {
    try {
      return new URL(headers.origin).origin === config.origin;
    } catch {
      return false;
    }
  }
  return false;
}
