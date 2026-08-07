import { pino } from "pino";
import type { Config } from "./config.ts";

// pino only. Callers add child bindings {runId, step}; the redaction
// chokepoint is the executor's log() helper (D) — request/response bodies are NEVER
// logged here.
export function createLogger(config: Config) {
  return pino({ level: config.logLevel });
}

export type Logger = ReturnType<typeof createLogger>;
