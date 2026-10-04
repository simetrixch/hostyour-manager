import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TenantMoveAction } from "./TenantMoveAction.tsx";
import { migrateTenant } from "../api.ts";

afterEach(() => vi.unstubAllGlobals());
describe("stage Move surface and request", () => {
  it("asks for a stage before offering a target, with no implicit stage selection", () => {
    const html = renderToStaticMarkup(createElement(TenantMoveAction, {
      tenant: { guid: "tenant1", subdomain: "demo" }, onCancel: () => undefined, onConfirm: () => undefined,
    }));
    expect(html).toContain("choose its stage");
    expect(html).toContain("Choose a stage");
    expect(html).toContain("Choose target machine");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Plan stage move");
  });
  it("uses the chosen stage row, not the tenant page's row, and binds its stage and source machine", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run_planned" }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await migrateTenant({ id: "tnt_test", stage: "test", clusterId: "cls_test" }, "cls_target");
    expect(fetcher).toHaveBeenCalledWith("/api/tenants/tnt_test/migrate", expect.objectContaining({
      method: "POST", body: JSON.stringify({ stage: "test", sourceClusterId: "cls_test", targetClusterId: "cls_target" }),
    }));
  });
});
