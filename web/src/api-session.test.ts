import { afterEach, describe, expect, it, vi } from "vitest";
import { approveRun, getRun } from "./api.ts";
import { SESSION_ENDED } from "./request.ts";

// A session the server no longer accepts (a Manager restart, an expired cookie) answers 401. A read
// sends the person to sign in and back to the page they were on; a write says it did nothing, because
// a redirect would drop the person on another page while they believe the write went through.

function signedOut(status = 401) {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign, pathname: "/runs/run_1", search: "?tab=log" } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status === 401 ? { message: "no session" } : { runId: "run_1" }), { status })));
  return assign;
}

afterEach(() => vi.unstubAllGlobals());

describe("a request in an ended session", () => {
  it("PLANTED: an approve answered 401 stays on the page and says the run did not start", async () => {
    const assign = signedOut();
    await expect(approveRun("run_1")).rejects.toThrow(SESSION_ENDED);
    expect(assign).not.toHaveBeenCalled();
  });

  it("a read answered 401 sends the person to sign in and back to the page they were on", async () => {
    const assign = signedOut();
    await expect(getRun("run_1")).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith(`/auth/login?next=${encodeURIComponent("/runs/run_1?tab=log")}`);
  });

  it("an approve the server accepts resolves as before", async () => {
    const assign = signedOut(200);
    await expect(approveRun("run_1")).resolves.toEqual({ runId: "run_1" });
    expect(assign).not.toHaveBeenCalled();
  });
});
