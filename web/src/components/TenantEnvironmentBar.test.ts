import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TenantView } from "../api.ts";
import { groupTenantEnvironments } from "../tenantRows.ts";
import { ChosenTenantEnvironment, TenantEnvironmentBar } from "./TenantEnvironmentBar.tsx";

vi.mock("react-router", () => ({ Link: ({ to, children, className }: { to: string; children: import("react").ReactNode; className?: string }) => createElement("a", { href: to, className }, children) }));

const row = (id: string, stage: TenantView["stage"], status: TenantView["status"], domain: string): TenantView =>
  ({ id, guid: "ak64h58875qw", subdomain: "example", stage, status, domain, suspended: false } as TenantView);
const example = [row("tnt_p", "prod", "active", "apps2.digitacloud.app"), row("tnt_t", "test", "active", "apps1.digitacloud.app"), row("tnt_d", "dev", "purged", "apps1.digitacloud.app")];
const render = (selectedId: string, onSelect?: (r: TenantView) => void): string =>
  renderToStaticMarkup(createElement(TenantEnvironmentBar, { group: groupTenantEnvironments(example)[0]!, selectedId, onSelect }));

describe("TenantEnvironmentBar", () => {
  it("names each standing environment with its machine, and offers + add where none stands", () => {
    const html = render("tnt_p");
    expect(html).toMatch(/PROD.*apps2\.digitacloud\.app/);
    expect(html).toMatch(/TEST.*apps1\.digitacloud\.app/);
    expect(html).toContain('href="/tenants/tnt_p?addStage=dev"');
    expect(html).toContain("+ add");
    expect(html).toContain("no size recorded");
  });
  it("names each environment's size by its letter where the row records one", () => {
    const sized = example.map((r) => (r.id === "tnt_p" ? { ...r, size: "medium" as const } : r));
    const html = renderToStaticMarkup(createElement(TenantEnvironmentBar, { group: groupTenantEnvironments(sized)[0]!, selectedId: "tnt_p" }));
    expect(html).toMatch(/PROD.*apps2\.digitacloud\.app<\/span> <span>M<\/span>/);
    expect(html).toMatch(/TEST.*apps1\.digitacloud\.app<\/span> <span class="muted">no size recorded/);
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

describe("ChosenTenantEnvironment", () => {
  // The Tenants card: what it opens and acts on is the environment the page URL names.
  const card = (search: string, rows = example): string =>
    renderToStaticMarkup(createElement(ChosenTenantEnvironment, {
      group: groupTenantEnvironments(rows)[0]!, search: new URLSearchParams(search), setSearch: () => undefined,
      children: (t: TenantView, bar: import("react").ReactNode) => createElement("div", null, bar, createElement("a", { href: `/tenants/${t.id}` }, `Open ${t.stage}`)),
    }));

  it("opens on PROD where the URL names nothing", () => {
    expect(card("")).toContain('href="/tenants/tnt_p">Open prod');
  });
  it("opens and acts on TEST once TEST is chosen, with TEST selected in the bar, across a refresh of the list", () => {
    const html = card("env.ak64h58875qw=test");
    expect(html).toContain('href="/tenants/tnt_t">Open test');
    expect(html).toMatch(/aria-selected="true"[^>]*>TEST/);
    expect(card("env.ak64h58875qw=test", example.map((r) => ({ ...r })))).toContain('href="/tenants/tnt_t">Open test');
  });
});
