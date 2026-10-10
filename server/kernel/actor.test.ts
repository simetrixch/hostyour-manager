import { describe, it, expect } from "vitest";
import { runAsActor, runActor, SYSTEM_ACTOR } from "./actor.ts";

// The actor carrier and the ONE resolver the stamp columns read (db/schema/stamps.ts).

describe("runActor", () => {
  it("is the signed-in operator inside a request", () => {
    expect(runAsActor("op_mehmet", () => runActor())).toBe("op_mehmet");
  });

  it("is the system row outside any request — a boot resume or a background job belongs to no human", () => {
    expect(runActor()).toBe(SYSTEM_ACTOR);
  });

  it("follows the async continuations of the request that bound it", async () => {
    // The whole point of the AsyncLocalStorage carrier: a write deep inside an awaited chain still
    // resolves the operator that started it, without the id being threaded through every signature.
    const seen = await runAsActor("op_mehmet", async () => {
      await Promise.resolve();
      return runActor();
    });
    expect(seen).toBe("op_mehmet");
    // ...and the binding does not leak past the request.
    expect(runActor()).toBe(SYSTEM_ACTOR);
  });

  it("nests: an inner binding wins for its own chain and the outer one survives it", () => {
    runAsActor("op_outer", () => {
      expect(runAsActor("op_inner", () => runActor())).toBe("op_inner");
      expect(runActor()).toBe("op_outer");
    });
  });
});
