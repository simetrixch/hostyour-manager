import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsumerView } from "../api.ts";
import { OffboardConsumerDialog, siblingStages } from "./OffboardConsumerDialog.tsx";

const row = (stage: ConsumerView["stage"], status: ConsumerView["status"] = "active", name = "acme"): ConsumerView =>
  ({ id: `app_${name}_${stage}`, name, stage, status, domain: "master.example" } as ConsumerView);

const render = (target: ConsumerView, rows: ConsumerView[]) => renderToStaticMarkup(createElement(OffboardConsumerDialog, {
  target, siblings: siblingStages(rows, target), onConfirm: () => undefined, onCancel: () => undefined,
}));

const RULE = "The run decides from the unit&#x27;s registrations when it acts: what the stages share goes only with the last registered stage.";

describe("siblingStages", () => {
  it("splits the unit's other rows into stages that stand and stages still provisioning, and drops settled rows and other units", () => {
    const rows = [row("dev"), row("test"), row("prod", "offboarded"), row("prod", "active", "other")];
    expect(siblingStages(rows, row("test"))).toEqual({ standing: ["dev"], provisioning: [] });
    expect(siblingStages([row("dev"), row("test", "provisioning"), row("prod", "suspended")], row("dev"))).toEqual({ standing: ["prod"], provisioning: ["test"] });
  });
});

describe("OffboardConsumerDialog", () => {
  it("PLANTED: offboarding one stage of two names that stage and keeps what the stages share", () => {
    const html = render(row("test"), [row("dev"), row("test")]);
    expect(html).toContain("Offboard &quot;acme&quot; · TEST on master.example?");
    expect(html).toContain("ArgoCD prunes its workloads, and the run deletes the namespace <span class=\"mono\">acme-test</span>");
    expect(html).toContain("this stage&#x27;s Vault secrets");
    expect(html).toContain("The unit still stands at DEV, so what its stages share stays: the repo PAT, the build webhook, the release kit and the build namespace.");
    expect(html).toContain(RULE);
    expect(html).not.toMatch(/repo PAT[^.]*NOT recoverable/);
  });

  it("offboarding the unit's last stage says the repo PAT and the rest of what the stages share go too", () => {
    const html = render(row("dev"), [row("dev"), row("test", "offboarded")]);
    expect(html).toContain("Offboard &quot;acme&quot; · DEV on master.example?");
    expect(html).toContain("This is the unit&#x27;s last stage, so what its stages share goes too: the repo PAT (NOT recoverable), the build webhook, the release kit and the build namespace.");
    expect(html).toContain(RULE);
  });

  it("PLANTED: a sibling still provisioning is no promise: the dialog says the shared parts may go, the repo PAT NOT recoverable", () => {
    const html = render(row("dev"), [row("dev"), row("test", "provisioning")]);
    expect(html).not.toContain("so what its stages share stays");
    expect(html).toContain("TEST is still provisioning. What the stages share — the repo PAT, the build webhook, the release kit and the build namespace — stays only if its registration was written; if not, it goes with this stage, the repo PAT NOT recoverable.");
  });
});
