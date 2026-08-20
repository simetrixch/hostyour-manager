import { describe, it, expect } from "vitest";
import type { RunView } from "../../shared/api-types.ts";
import type { RunKind, RunStatus } from "../../shared/enums.ts";
import { relevantRun, runLine } from "./serverRuns.ts";

const run = (over: { id?: string; kind?: RunKind; status?: RunStatus; targetId?: string }): RunView => ({
  id: over.id ?? "run_1",
  kind: over.kind ?? "adopt",
  targetKind: "server",
  targetId: over.targetId ?? "srv_1",
  status: over.status ?? "planned",
  summary: "",
  steps: [],
  requiredSecrets: [],
  requiredInputs: [],
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  deletedAt: null,
});

describe("relevantRun — the ONE run a server's card surfaces", () => {
  it("prefers an OPEN run over a newer failed one, so a run waiting for approval is never invisible", () => {
    const runs = [run({ id: "run_new", status: "failed" }), run({ id: "run_open", status: "planned" })];
    expect(relevantRun("srv_1", runs)?.id).toBe("run_open");
  });

  it("falls back to the most recent run only when it FAILED — a succeeded one is not the next step", () => {
    expect(relevantRun("srv_1", [run({ status: "failed" })])?.id).toBe("run_1");
    expect(relevantRun("srv_1", [run({ status: "succeeded" })])).toBeUndefined();
  });

  it("never surfaces another server's run", () => {
    expect(relevantRun("srv_1", [run({ targetId: "srv_2", status: "planned" })])).toBeUndefined();
  });
});

describe("runLine — what the card calls the run", () => {
  it("names the three tailnet repair run kinds in words, not in kind literals", () => {
    expect(runLine(run({ kind: "tailnet-disconnect", status: "planned" }))).toBe("A tailnet disconnect is planned — approve it");
    expect(runLine(run({ kind: "tailnet-reconnect", status: "running" }))).toBe("A tailnet reconnect is running — watch it");
    expect(runLine(run({ kind: "tailnet-rejoin", status: "failed" }))).toBe("The last tailnet rejoin failed — open it to retry");
  });

  it("falls back to '<kind> run' for a run kind whose name is already a noun phrase", () => {
    expect(runLine(run({ kind: "release", status: "planned" }))).toBe("A release run is planned — approve it");
  });

  it("picks the article from the noun, so a vowel does not read as 'A adoption'", () => {
    expect(runLine(run({ kind: "adopt", status: "running" }))).toBe("An adoption is running — watch it");
    expect(runLine(run({ kind: "deploy-slave", status: "planned" }))).toBe("A deployment is planned — approve it");
  });
});
