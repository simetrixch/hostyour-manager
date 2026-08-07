import { describe, it, expect } from "vitest";
import { verdictOf } from "./http-probe.ts";

// The reachability verdict is what verify-quiesced trusts, so its boundary cases are pinned here:
// "reachable" must mean the UNIT answered — a 404 is the edge saying nothing routes the host (the
// quiesced state), a 5xx is an edge with no backend, and everything else (a page, a redirect, an
// auth challenge) proves access is still open.
describe("verdictOf", () => {
  it("reads a served page, a redirect and an auth challenge as REACHABLE — the unit still answers", () => {
    for (const status of [200, 301, 302, 401, 403]) {
      expect(verdictOf(status)).toEqual({ reachable: true, detail: `HTTP ${status}` });
    }
  });

  it("reads 404 and 5xx as UNREACHABLE — nothing routes the host, or nothing serves behind the edge", () => {
    for (const status of [404, 500, 502, 503]) {
      expect(verdictOf(status).reachable).toBe(false);
    }
  });
});
