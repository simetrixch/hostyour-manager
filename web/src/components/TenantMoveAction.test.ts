import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TenantMoveAction } from "./TenantMoveAction.tsx";
import { migrateTenant, type TenantView } from "../api.ts";

const row = (stage: TenantView["stage"]): TenantView =>
  ({ id: `tnt_${stage}`, guid: "tenant1", subdomain: "demo", stage, status: "active", clusterId: `cls_${stage}`, domain: "apps1.example", suspended: false } as TenantView);
const render = (stage: TenantView["stage"]): string => renderToStaticMarkup(createElement(TenantMoveAction, { tenant: row(stage), onCancel: () => undefined, onConfirm: () => undefined }));

afterEach(() => vi.unstubAllGlobals());
describe("stage Move surface and request", () => {
  it("moves the environment of the page it is opened on, naming it and its machine", () => {
    const html = render("test");
    expect(html).toContain("Move &quot;demo&quot; test from apps1.example?");
    expect(html).not.toContain("Choose a stage");
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
