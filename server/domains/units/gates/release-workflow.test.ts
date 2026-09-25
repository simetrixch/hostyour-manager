import { describe, it, expect } from "vitest";
import { gateReleaseWorkflow, workflowTriggers } from "./release-workflow.ts";
import { RELEASE_KIT_WORKFLOW } from "#unit/server/release-kit/release-kit.ts";

const FOREIGN = "name: Publish packages\non:\n  push:\n    tags:\n      - 'v*.*.*'\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: []\n";

describe("G28 release workflow (hard)", () => {
  it("passes an absent file and the kit's own bytes", () => {
    expect(gateReleaseWorkflow({ found: null })).toMatchObject({ id: "G28", severity: "hard", status: "pass", reason: null });
    expect(gateReleaseWorkflow({ found: RELEASE_KIT_WORKFLOW.content })).toMatchObject({ status: "pass", reason: null });
  });

  it("passes an older kit — the same triggers, other bytes — because the replace brings it forward", () => {
    const older = RELEASE_KIT_WORKFLOW.content.replace("name: Release", "name: Release (old)");
    expect(older).not.toBe(RELEASE_KIT_WORKFLOW.content);
    const g = gateReleaseWorkflow({ found: older });
    expect(g.status).toBe("pass");
    expect(g.found).toContain("older release kit");
  });

  it("refuses a workflow the unit owns, naming the path, its triggers and the way out", () => {
    const g = gateReleaseWorkflow({ found: FOREIGN });
    expect(g.status).toBe("fail");
    expect(g.found).toContain(RELEASE_KIT_WORKFLOW.path);
    expect(g.found).toContain("on: push");
    expect(g.reason).toMatch(/move it to another file under \.github\/workflows\//);
    expect(g.evidence?.[0]).toMatchObject({ source: "repo", file: RELEASE_KIT_WORKFLOW.path, value: "push" });
  });

  it("refuses a file it cannot read as a workflow, and one that adds a trigger to the kit's", () => {
    expect(gateReleaseWorkflow({ found: "on: [\n" }).status).toBe("fail");
    expect(gateReleaseWorkflow({ found: "on: [workflow_dispatch, push]\n" }).status).toBe("fail");
  });

  it("reads the triggers in the three shapes GitHub accepts", () => {
    expect(workflowTriggers("on: workflow_dispatch\n")).toEqual(["workflow_dispatch"]);
    expect(workflowTriggers("on: [push, workflow_dispatch]\n")).toEqual(["push", "workflow_dispatch"]);
    expect(workflowTriggers("on:\n  workflow_dispatch: {}\n  push: {}\n")).toEqual(["push", "workflow_dispatch"]);
    expect(workflowTriggers("name: x\n")).toBeNull();
    expect(workflowTriggers(RELEASE_KIT_WORKFLOW.content)).toEqual(["workflow_dispatch"]);
  });
});
