// In-memory UnitCall fake: answers through a handler the test gives, and records every call with the
// key it carried, so a test can assert what the Manager presented and to which URL.
import type { UnitCall, UnitCallResult } from "../port.ts";

export type UnitCallRequest = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; key: string; body?: unknown };

export class FakeUnitCall implements UnitCall {
  readonly calls: UnitCallRequest[] = [];

  constructor(private readonly answer: (req: UnitCallRequest) => UnitCallResult) {}

  async call(req: UnitCallRequest & { signal?: AbortSignal }): Promise<UnitCallResult> {
    const { signal: _signal, ...seen } = req;
    this.calls.push(seen);
    return this.answer(seen);
  }
}
