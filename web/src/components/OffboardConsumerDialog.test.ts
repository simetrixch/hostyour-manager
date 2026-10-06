import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsumerView } from "../api.ts";
import { OffboardConsumerDialog, otherStandingStages } from "./OffboardConsumerDialog.tsx";

const row = (stage: ConsumerView["stage"], status: ConsumerView["status"] = "active", name = "acme"): ConsumerView =>
  ({ id: `app_${name}_${stage}`, name, stage, status, domain: "master.example" } as ConsumerView);

const render = (target: ConsumerView, rows: ConsumerView[]) => renderToStaticMarkup(createElement(OffboardConsumerDialog, {
  target, otherStages: otherStandingStages(rows, target), onConfirm: () => undefined, onCancel: () => undefined,
}));

describe("otherStandingStages", () => {
  it("names the unit's other stages that still stand, and no offboarded one or another unit's", () => {
    const rows = [row("dev"), row("test"), row("prod", "offboarded"), row("prod", "active", "other")];
    expect(otherStandingStages(rows, row("test"))).toEqual(["dev"]);
  });
});

describe("OffboardConsumerDialog", () => {
  it("PLANTED: offboarding one stage of two names that stage and keeps what the stages share", () => {
    const html = render(row("test"), [row("dev"), row("test")]);
    expect(html).toContain("Offboard &quot;acme&quot; · TEST on master.example?");
    expect(html).toContain("acme-test");
    expect(html).toContain("this stage&#x27;s Vault secrets");
    expect(html).toContain("The unit still stands at DEV, so what its stages share stays: the repo PAT, the build webhook, the release kit and the build namespace.");
    expect(html).not.toMatch(/repo PAT[^.]*NOT recoverable/);
  });

  it("offboarding the unit's last stage says the repo PAT and the rest of what the stages share go too", () => {
    const html = render(row("dev"), [row("dev"), row("test", "offboarded")]);
    expect(html).toContain("Offboard &quot;acme&quot; · DEV on master.example?");
    expect(html).toContain("This is the unit&#x27;s last stage, so what its stages share goes too: the repo PAT (NOT recoverable), the build webhook, the release kit and the build namespace.");
  });
});
