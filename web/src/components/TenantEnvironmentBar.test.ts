import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TenantView } from "../api.ts";
import { groupTenantEnvironments } from "../tenantRows.ts";
import { TenantEnvironmentBar } from "./TenantEnvironmentBar.tsx";

vi.mock("react-router", () => ({ Link: ({ to, children, className }: { to: string; children: import("react").ReactNode; className?: string }) => createElement("a", { href: to, className }, children) }));

const row = (id: string, stage: TenantView["stage"], status: TenantView["status"], domain: string): TenantView =>
  ({ id, guid: "ak64h58875qw", subdomain: "simetrix", stage, status, domain, suspended: false } as TenantView);
const simetrix = [row("tnt_p", "prod", "active", "apps2.digitacloud.app"), row("tnt_t", "test", "active", "apps1.digitacloud.app"), row("tnt_d", "dev", "purged", "apps1.digitacloud.app")];
const render = (selectedId: string, onSelect?: (r: TenantView) => void): string =>
  renderToStaticMarkup(createElement(TenantEnvironmentBar, { group: groupTenantEnvironments(simetrix)[0]!, selectedId, onSelect }));

describe("TenantEnvironmentBar", () => {
  it("names each standing environment with its machine, and offers + add where none stands", () => {
    const html = render("tnt_p");
    expect(html).toMatch(/PROD.*apps2\.digitacloud\.app/);
    expect(html).toMatch(/TEST.*apps1\.digitacloud\.app/);
    expect(html).toContain('href="/tenants/tnt_p?addStage=dev"');
    expect(html).toContain("+ add");
    expect(html).toContain("no size recorded");
  });
  it("on the tenant page links each environment to its OWN row, so every action there acts on that row", () => {
    const html = render("tnt_p");
    expect(html).toContain('href="/tenants/tnt_t"');
    expect(html).toContain('href="/tenants/tnt_p"');
  });
  it("on the Tenants page selects an environment in place", () => {
    const html = render("tnt_t", () => undefined);
    expect(html).not.toContain('href="/tenants/tnt_t"');
    expect(html).toMatch(/<button[^>]*aria-selected="true"[^>]*>TEST/);
  });
});
