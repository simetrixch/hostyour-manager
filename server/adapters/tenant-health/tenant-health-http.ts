// The concrete tenant-health client: a token-gated GET against the tenant's own public ingress.
//
// The token rides ONLY as the declared header — never in the URL, where it would land in an access
// log on the way, and never in the body of a GET.
//
// EVERYTHING that is not a readable answer becomes `reached: false` with a reason, and nothing here
// throws. A tenant that is mid-restart, behind a DNS change or mid-deploy is a normal state of a
// cluster, and a check that turned those into findings would be muted within a week — after which it
// reports nothing at all, including the one thing it exists for.
import type { TenantHealth, TenantHealthReader, TenantHealthRequest } from "./port.ts";

/** Bound the captured body so a hostile or huge response cannot blow the run log or memory. */
const BODY_CAP = 512;

/** How long one tenant may take. Short on purpose: the check fans out over every tenant of an
 *  installation, and one that is down must not hold the others behind it. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Reads the administrator count out of a parsed body.
 *
 * Two spellings are accepted because the endpoint predates this reader — the operator that used to
 * poll it read `adminCount`, and the auth service answers `admins`. Returns null when neither is
 * present as a non-negative whole number, which the caller turns into "reached, unreadable" rather
 * than into a zero: a body this cannot parse is not evidence that nobody can administer the tenant. */
export function adminsIn(json: unknown): number | null {
  if (typeof json !== "object" || json === null) return null;
  const bag = json as Record<string, unknown>;
  for (const key of ["admins", "adminCount"]) {
    const value = bag[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

export class HttpTenantHealthReader implements TenantHealthReader {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async read(input: TenantHealthRequest): Promise<TenantHealth> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const onOuterAbort = (): void => timer.abort((input.signal as AbortSignal).reason);
    if (input.signal) {
      if (input.signal.aborted) timer.abort(input.signal.reason);
      else input.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(input.url, {
        method: "GET",
        headers: { accept: "application/json", [input.tokenHeader]: input.token },
        signal: timer.signal,
        // Never follow a redirect off the declared host: the token is a header, and a header travels
        // with a cross-host redirect.
        redirect: "manual",
      });
      const raw = await res.text();
      const body = raw.length > BODY_CAP ? `${raw.slice(0, BODY_CAP)}…[truncated]` : raw;
      if (!res.ok) {
        // The status alone, and the body only because the endpoint's own refusals say why. Whatever
        // it contains is not a credential this sent — the token went as a header.
        return { reached: false, because: `answered ${res.status}: ${body.trim() || "(no body)"}` };
      }
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        return { reached: false, because: "answered 200 with a body that is not JSON" };
      }
      const admins = adminsIn(json);
      if (admins === null) {
        return { reached: false, because: 'answered 200, and the body carries no "admins" count' };
      }
      return { reached: true, admins };
    } catch (cause) {
      // A transport failure — DNS, TLS, connection refused, the timeout above. All of them are
      // states a cluster is legitimately in.
      return { reached: false, because: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      clearTimeout(t);
      if (input.signal) input.signal.removeEventListener("abort", onOuterAbort);
    }
  }
}
