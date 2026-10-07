// A call to a unit's stage as the Manager itself: the stage accepts the key the Manager keeps for it
// (unit-call-key.ts) in X-Manager-Key, and the call carries a JSON body. A port so a run step depends
// on the abstraction; the fetch impl is unit-call.ts, the fake testing/fake.ts.

/** What the unit answered. `status` is null where no response came (refused, DNS, timeout); `body`
 *  is the parsed JSON answer, absent where it was none; `detail` names either for the run log. */
export interface UnitCallResult {
  status: number | null;
  detail: string;
  body?: unknown;
}

export interface UnitCall {
  call(req: { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; key: string; body?: unknown; signal?: AbortSignal }): Promise<UnitCallResult>;
}
