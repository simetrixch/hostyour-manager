import { describe, it, expect } from "vitest";
import { gateReleaseWorkflow, workflowTriggers } from "./release-workflow.ts";
import { RELEASE_KIT_WORKFLOW } from "#unit/server/release-kit/release-kit.ts";

const FOREIGN = "name: Publish packages\non:\n  push:\n    tags:\n      - 'v*.*.*'\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: []\n";

// A unit's own package publish with the kit's two trigger names and a tag filter of its own, which a
// comparison of the names alone passes as an older kit.
const SAME_NAMES_OWN_FILTER = "name: Release\non:\n  push:\n    tags: ['v*']\n  workflow_dispatch:\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: []\n";

// Every kit before the publish job: a manual dispatch and nothing else.
const KIT_BEFORE_PUBLISH = "name: Release\non:\n  workflow_dispatch:\n    inputs:\n      version:\n        type: string\n      channel:\n        type: choice\n        options: [stable, beta, alpha]\n      stage:\n        type: choice\n        options: [dev, test, prod]\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash release/release.sh \"$VERSION\" \"$CHANNEL\" \"$STAGE\"\n";

// A manual workflow of a unit's own: started by hand like every older kit, with inputs of its own.
const OWN_MANUAL = "name: Deploy docs\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: string\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n";

describe("G28 release workflow (hard)", () => {
  it("passes an absent file and the kit's own bytes", () => {
    expect(gateReleaseWorkflow({ found: null })).toMatchObject({ id: "G28", severity: "hard", status: "pass", reason: null });
    expect(gateReleaseWorkflow({ found: RELEASE_KIT_WORKFLOW.content })).toMatchObject({ status: "pass", reason: null });
  });

  it("passes an older kit — the same triggers and tag filter, other bytes — because the replace brings it forward", () => {
    const older = RELEASE_KIT_WORKFLOW.content.replace("name: Release", "name: Release (old)");
    expect(older).not.toBe(RELEASE_KIT_WORKFLOW.content);
    const g = gateReleaseWorkflow({ found: older });
    expect(g.status).toBe("pass");
    expect(g.found).toContain("older release kit");
  });

  it("passes a kit from before the publish job, which carried workflow_dispatch alone", () => {
    const g = gateReleaseWorkflow({ found: KIT_BEFORE_PUBLISH });
    expect(g.status).toBe("pass");
    expect(g.found).toContain("older release kit (on: workflow_dispatch)");
  });

  it("PLANTED DEFECT: refuses a workflow with the kit's trigger names and a push filter of its own", () => {
    // Without the filter comparison this is the one foreign workflow the gate would replace in silence.
    expect(workflowTriggers(SAME_NAMES_OWN_FILTER)).toEqual(workflowTriggers(RELEASE_KIT_WORKFLOW.content));
    const g = gateReleaseWorkflow({ found: SAME_NAMES_OWN_FILTER });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("the unit's own workflow (on: push, workflow_dispatch)");
  });

  it("PLANTED DEFECT: refuses a manual workflow of the unit's own, which carries the older kits' one trigger", () => {
    // Without the input comparison this workflow would pass as an older kit and be replaced, at an
    // onboarding and, for a library, at every boot without an operator looking.
    expect(workflowTriggers(OWN_MANUAL)).toEqual(["workflow_dispatch"]);
    const g = gateReleaseWorkflow({ found: OWN_MANUAL });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("the unit's own workflow (on: workflow_dispatch)");
  });

  it("refuses a manual workflow with the kit's three inputs that runs no release/release.sh", () => {
    const lookalike = KIT_BEFORE_PUBLISH.replace("bash release/release.sh", "bash deploy.sh");
    expect(lookalike).not.toContain("release/release.sh");
    expect(gateReleaseWorkflow({ found: lookalike }).status).toBe("fail");
  });

  it("refuses a workflow the unit owns, naming the path, its triggers and the way out", () => {
    const g = gateReleaseWorkflow({ found: FOREIGN });
    expect(g.status).toBe("fail");
    expect(g.found).toContain(RELEASE_KIT_WORKFLOW.path);
    expect(g.found).toContain("on: push");
    expect(g.reason).toMatch(/move it to another file under \.github\/workflows\//);
    expect(g.evidence?.[0]).toMatchObject({ source: "repo", file: RELEASE_KIT_WORKFLOW.path, value: "push" });
  });

  it("refuses a file it cannot read as a workflow, and the kit's trigger names without the kit's tag filter", () => {
    expect(gateReleaseWorkflow({ found: "on: [\n" }).status).toBe("fail");
    expect(gateReleaseWorkflow({ found: "on: [workflow_dispatch, push]\n" }).status).toBe("fail");
  });

  it("reads the triggers in the three shapes GitHub accepts", () => {
    expect(workflowTriggers("on: workflow_dispatch\n")).toEqual(["workflow_dispatch"]);
    expect(workflowTriggers("on: [push, workflow_dispatch]\n")).toEqual(["push", "workflow_dispatch"]);
    expect(workflowTriggers("on:\n  workflow_dispatch: {}\n  push: {}\n")).toEqual(["push", "workflow_dispatch"]);
    expect(workflowTriggers("name: x\n")).toBeNull();
    expect(workflowTriggers(RELEASE_KIT_WORKFLOW.content)).toEqual(["push", "workflow_dispatch"]);
  });
});
