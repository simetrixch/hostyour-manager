import type { InstantAnswer, MetricsQuery } from "../port.ts";

// In-memory MetricsQuery fake, shipped beside the port so every suite drives the same belief about
// what the real client does. It records every query it was ASKED, because the whole of what the
// caller decides is which series it names — a step that queried the master's own cluster instead of
// the slave's would answer green and be invisible in the verdict alone.
//
// THE DEFAULT IS A SERIES, which is the state a healthy run ends in: a happy-path suite scripts
// nothing, and a test about a machine that is not pushing yet says so out loud.

export class FakeMetricsQuery implements MetricsQuery {
  readonly asked: string[] = [];

  constructor(private answer: InstantAnswer = { kind: "answered", series: 1 }) {}

  /** What the next query — and every one after it — is answered with. */
  set(answer: InstantAnswer): void {
    this.answer = answer;
  }

  async instant(query: string, _opts: { signal?: AbortSignal }): Promise<InstantAnswer> {
    this.asked.push(query);
    return this.answer;
  }
}
