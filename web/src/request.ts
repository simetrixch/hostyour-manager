// The one way the SPA talks to the Manager's API: same-origin fetch, JSON in and out, the server's error
// code kept, and what a lapsed session does to a read and to a write.

import type { ApiError } from "../../shared/api-types.ts";

/** Carries the server's error CODE (not just the message) so a caller can branch on it —
 *  e.g. the Reset wizard renders a DB-only form on NOT_CONFIGURED instead of a dead end. */
export class ApiRequestError extends Error {
  readonly code: string | undefined;
  readonly detail: Record<string, unknown> | undefined;
  constructor(message: string, code?: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.detail = detail;
  }
}

/** What a write answered 401 says: the server did nothing with it. */
export const SESSION_ENDED = "Your session ended, so this was not done. Reload the page to sign in again, then do it once more.";

/**
 * Typed API client. Same-origin fetch, so the browser sends Sec-Fetch-Site: same-origin and the csrf
 * guard needs no token. A 401 (a lapsed session, a Manager restart): a read goes to sign in and back; a
 * write stays and says it was not done, since a redirect would hide that its approve never ran.
 */
export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    if ((init?.method ?? "GET") !== "GET") throw new ApiRequestError(SESSION_ENDED, "UNAUTHENTICATED");
    window.location.assign(`/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new Error("Not signed in");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(body?.message ?? `Request failed (${res.status})`, body?.code, body?.detail);
  }
  return (await res.json()) as T;
}

export const post = <T>(path: string, body: Record<string, unknown> = {}): Promise<T> =>
  req<T>(path, { method: "POST", body: JSON.stringify(body) });
/** PUT — a full replacement of one addressed thing, where POST creates or triggers. The size table's
 *  update is the one caller: a size is read and written as a whole (all six figures at once), so a
 *  partial update would be a screen silently keeping a number the operator believed they replaced. */
export const put = <T>(path: string, body: Record<string, unknown>): Promise<T> =>
  req<T>(path, { method: "PUT", body: JSON.stringify(body) });
