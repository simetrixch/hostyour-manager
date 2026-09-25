import type { Logger } from "../kernel/logger.ts";

/** One log line per boot phase with its duration, from wire(): a killed container's `--previous` log
 *  then names the phase that held the port shut, where before it named nothing until the first
 *  message of the last phase (#168). `now` is injectable for the test. */
export function bootPhases(logger: Logger, now: () => number = Date.now): (name: string) => void {
  const started = now();
  let last = started;
  return (name) => {
    const t = now();
    logger.info({ phase: name, ms: t - last, sinceBootMs: t - started }, "boot phase");
    last = t;
  };
}
