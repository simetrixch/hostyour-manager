import { describe, it, expect } from "vitest";
import type { BatchV1Api, CoreV1Api } from "@kubernetes/client-node";
import { runKubeJob, type JobClients } from "./kube-job.ts";
import type { JobSpec } from "./port.ts";

const notFound = (): Error => Object.assign(new Error("jobs.batch \"x\" not found"), { code: 404 });

const spec: JobSpec = { name: "dump-x", image: "dbtools:1", script: "echo hi" };

/** A scripted batch/core pair over one piece of state: does a Job of the name exist, and does it
 *  ever settle. `stuckTerminating` keeps the Job present through every delete — the wedged-node
 *  picture the bounded delete-wait exists for. */
function fakeWorld(opts: { leftover?: boolean; stuckTerminating?: boolean; settles?: boolean } = {}): { c: JobClients; calls: string[] } {
  const calls: string[] = [];
  let exists = opts.leftover ?? false;
  const batch = {
    async deleteNamespacedJob(): Promise<void> {
      calls.push("delete");
      if (!exists) throw notFound();
      if (!opts.stuckTerminating) exists = false;
    },
    async createNamespacedJob(): Promise<void> {
      calls.push("create");
      exists = true;
    },
    async readNamespacedJob(): Promise<{ status: { succeeded?: number } }> {
      calls.push("read");
      if (!exists) throw notFound();
      return { status: opts.settles ? { succeeded: 1 } : {} };
    },
  } as unknown as BatchV1Api;
  const core = {
    async listNamespacedPod(): Promise<{ items: never[] }> {
      return { items: [] };
    },
  } as unknown as CoreV1Api;
  return { c: { batch, core, pollMs: 1, deleteWaitMs: 25 }, calls };
}

describe("runKubeJob", () => {
  it("deletes a Job the poll walked away from on TIMEOUT — the Job must not outlive its run", async () => {
    // The Job never settles, so ttlSecondsAfterFinished never starts counting: without the
    // timeout-path delete it keeps writing after the run has already failed.
    const { c, calls } = fakeWorld();
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 20 });
    expect(result.succeeded).toBe(false);
    expect(calls.indexOf("create")).toBeLessThan(calls.lastIndexOf("delete"));
  });

  it("leaves a Job that SETTLED to its TTL — only an unsettled Job is reaped", async () => {
    const { c, calls } = fakeWorld({ settles: true });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 1000 });
    expect(result.succeeded).toBe(true);
    expect(calls.lastIndexOf("delete")).toBeLessThan(calls.indexOf("create"));
  });

  it("bounds the leftover delete-wait — a Job stuck Terminating fails loud instead of pinning the run forever", async () => {
    const { c, calls } = fakeWorld({ leftover: true, stuckTerminating: true });
    await expect(runKubeJob(c, "ns", spec, { timeoutMs: 1000 })).rejects.toThrow(/still present/);
    expect(calls).not.toContain("create"); // the refusal comes before anything new is created
  });

  it("an abort during the delete-wait returns without creating — no 409 against the still-present Job", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { c, calls } = fakeWorld({ leftover: true, stuckTerminating: true });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 1000, signal: ctrl.signal });
    expect(result.succeeded).toBe(false);
    expect(calls).not.toContain("create");
  });
});
