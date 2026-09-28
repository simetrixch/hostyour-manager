import { describe, it, expect } from "vitest";
import { dropSecrets, heldSecrets, holdSecrets } from "./heldSecrets.ts";

// The values a dialog took for a run, held in memory until the run's page lets go of them (#317).

describe("held secrets", () => {
  it("holds values per run until they are dropped, and holds nothing for an empty set", () => {
    holdSecrets("run_1", { "consumer-secret:A": "a" });
    holdSecrets("run_2", {});
    expect(heldSecrets("run_1")).toEqual({ "consumer-secret:A": "a" });
    expect(heldSecrets("run_2")).toBeUndefined();
    dropSecrets("run_1");
    expect(heldSecrets("run_1")).toBeUndefined();
  });
});
