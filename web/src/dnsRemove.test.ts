import { describe, it, expect, vi } from "vitest";
import { removeDnsRecords } from "./api.ts";

// The DNS page's removal plans and approves in one call (#181): the confirm on the page is the
// reading of the plan. A rejected plan throws before any approve.
describe("removeDnsRecords", () => {
  const records = [{ name: "post.example.net", type: "A" as const }];

  it("approves the run it planned and answers its id", async () => {
    const planRun = vi.fn().mockResolvedValue({ runId: "run_1" });
    const approveRun = vi.fn().mockResolvedValue({ ok: true });
    await expect(removeDnsRecords({ records }, { planRun, approveRun })).resolves.toEqual({ runId: "run_1" });
    expect(planRun).toHaveBeenCalledWith("dns-remove", { records });
    expect(approveRun).toHaveBeenCalledWith("run_1");
  });

  it("never approves a plan that was refused", async () => {
    const planRun = vi.fn().mockRejectedValue(new Error("1 of the 1 record(s) cannot be taken back"));
    const approveRun = vi.fn();
    await expect(removeDnsRecords({ records }, { planRun, approveRun })).rejects.toThrow("cannot be taken back");
    expect(approveRun).not.toHaveBeenCalled();
  });
});
