// The boot phase log (boot-phases.ts): one line per phase, its own duration and the time since boot.
import { describe, it, expect } from "vitest";
import { bootPhases } from "./boot-phases.ts";
import type { Logger } from "../kernel/logger.ts";

describe("bootPhases", () => {
  it("writes name, the phase's own duration and the time since boot, in order", () => {
    const lines: unknown[][] = [];
    const logger = { info: (...args: unknown[]) => { lines.push(args); } } as unknown as Logger;
    const ticks = [1000, 1250, 31250, 31300];
    const phase = bootPhases(logger, () => ticks.shift() ?? 0);
    phase("database");
    phase("credential store");
    phase("self-checks");
    expect(lines).toEqual([
      [{ phase: "database", ms: 250, sinceBootMs: 250 }, "boot phase"],
      [{ phase: "credential store", ms: 30000, sinceBootMs: 30250 }, "boot phase"],
      [{ phase: "self-checks", ms: 50, sinceBootMs: 30300 }, "boot phase"],
    ]);
  });
});
