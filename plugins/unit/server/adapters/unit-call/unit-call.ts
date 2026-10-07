// The concrete call to a unit's stage: fetch with the kept key in X-Manager-Key and a JSON body,
// bounded in time. A transport failure is an answer of its own (status null), never a throw, so the
// caller names it.
import type { UnitCall, UnitCallResult } from "./port.ts";

export class HttpUnitCall implements UnitCall {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async call(req: { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; key: string; body?: unknown; signal?: AbortSignal }): Promise<UnitCallResult> {
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      const headers: Record<string, string> = { "x-manager-key": req.key };
      if (req.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal,
        redirect: "manual",
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: res.status, detail: `HTTP ${res.status}`, ...(body !== undefined ? { body } : {}) };
    } catch (e) {
      return { status: null, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
