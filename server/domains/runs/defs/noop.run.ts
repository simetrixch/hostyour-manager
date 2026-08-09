import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";

const paramsSchema = z.record(z.string(), z.unknown());

const abortError = (): Error => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(abortError());
    }, { once: true });
  });

// The 3 steps are idempotent by contract; re-running after a crash is safe (they only
// emit/checkpoint/sleep). This is the permanent resume-proof fixture and
// the exit-bar body of the end-to-end slice.
const steps: Step[] = [
  {
    name: "log-lines",
    title: "Emit demo output",
    run: async (ctx) => {
      for (let i = 1; i <= 5; i++) ctx.log("stdout", `demo line ${i}`);
    },
  },
  {
    name: "checkpoint",
    title: "Record a checkpoint",
    run: async (ctx) => {
      ctx.checkpoint({ marker: "reached", n: 42 });
    },
  },
  {
    name: "sleep",
    title: "Wait briefly",
    run: async (ctx) => {
      await sleep(50, ctx.signal);
    },
  },
];

export const noopDef: RunDefinition = {
  kind: "noop",
  paramsSchema,
  mutating: false,
  plan: async () => ({
    kind: "noop",
    targetKind: "self",
    targetId: "controller",
    summary: "No-op demo run: 3 steps, ~0.1 s.",
    steps: steps.map((s) => ({ name: s.name, title: s.title })),
    warnings: [],
    requiredSecrets: [],
  }),
  steps: () => steps,
};
