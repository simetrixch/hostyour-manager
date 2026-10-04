import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TenantMoveAction, TenantMoveConfirm } from "./TenantMoveAction.tsx";
import { migrateTenant, type TenantView } from "../api.ts";
import { chosenForMove, movableEnvironments } from "../tenantRows.ts";

const row = (stage: TenantView["stage"]): TenantView =>
  ({ id: `tnt_${stage}`, guid: "tenant1", subdomain: "demo", stage, status: "active", clusterId: `cls_${stage}`, domain: "apps1.example", suspended: false } as TenantView);
const render = (stage: TenantView["stage"]): string => renderToStaticMarkup(createElement(TenantMoveConfirm, { tenant: row(stage), onCancel: () => undefined, onConfirm: () => undefined }));
const simetrix = [{ ...row("prod"), domain: "apps2.example" }, row("test"), { ...row("dev"), status: "purged" } as TenantView, { ...row("test"), id: "tnt_other", guid: "other" }];

afterEach(() => vi.unstubAllGlobals());
describe("stage Move surface and request", () => {
  it("starts with the stage choice: the tenant's running environments with their machines, the page's own preselected", () => {
    const html = renderToStaticMarkup(createElement(TenantMoveAction, { tenant: simetrix[0]!, environments: simetrix, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(html).toContain("Choose the environment to move");
    expect(html).toMatch(/name="move-stage" value="tnt_test"\/> TEST · apps1\.example/);
    expect(html).toMatch(/checked="" value="tnt_prod"\/> PROD · apps2\.example/);
    expect(html).not.toContain("tnt_dev");
    expect(html).not.toContain("tnt_other");
    // Nothing is typed or targeted before the stage is chosen.
    expect(html).not.toContain("Choose target machine");
    const fromTest = renderToStaticMarkup(createElement(TenantMoveAction, { tenant: simetrix[1]!, environments: simetrix, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(fromTest).toMatch(/checked="" value="tnt_test"/);
  });
  it("moves what was picked: PROD picked on the TEST page is PROD, and PROD's typed confirmation stands before its target", () => {
    const offered = movableEnvironments(simetrix[1]!, simetrix);
    const chosen = chosenForMove(offered, "tnt_prod", simetrix[1]!);
    expect(chosen.stage).toBe("prod");
    const html = renderToStaticMarkup(createElement(TenantMoveConfirm, { tenant: chosen, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(html).toContain('Type <span class="mono">tenant1 prod</span> to confirm');
    expect(html).not.toContain("Plan stage move");
    // A pick that is not offered (another tenant's row) never moves it: the page's own stands.
    expect(chosenForMove(offered, "tnt_other", simetrix[1]!).id).toBe("tnt_test");
  });
  it("moves the chosen environment, naming it and its machine", () => {
    const html = render("test");
    expect(html).toContain("Move &quot;demo&quot; test from apps1.example?");
  });
  it("asks for the guid and the environment before a PROD move offers a target", () => {
    const html = render("prod");
    expect(html).toContain('Type <span class="mono">tenant1 prod</span> to confirm');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Choose target machine<\/button>/);
    expect(html).not.toContain("Plan stage move");
  });
  it("binds the row's stage and source machine", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run_planned" }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await migrateTenant({ id: "tnt_test", stage: "test", clusterId: "cls_test" }, "cls_target");
    expect(fetcher).toHaveBeenCalledWith("/api/tenants/tnt_test/migrate", expect.objectContaining({
      method: "POST", body: JSON.stringify({ stage: "test", sourceClusterId: "cls_test", targetClusterId: "cls_target" }),
    }));
  });
});
