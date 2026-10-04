import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { TenantView } from "../api.ts";
import { groupTenantEnvironments } from "../tenantRows.ts";
import { ChosenTenantEnvironment } from "./TenantEnvironmentBar.tsx";

const row = (id: string, stage: TenantView["stage"]): TenantView => ({ id, guid: "g1", stage, status: "active" } as TenantView);

it("puts the environment the bar picks into the URL, replacing the entry", () => {
  const setSearch = vi.fn();
  const rows = [row("tnt_p", "prod"), row("tnt_t", "test")];
  const bar = ChosenTenantEnvironment({ group: groupTenantEnvironments(rows)[0]!, search: new URLSearchParams("tab=live"), setSearch, children: (_t, b) => b }) as ReactElement<{ onSelect: (r: TenantView) => void }>;
  bar.props.onSelect(rows[1]!);
  expect(setSearch).toHaveBeenCalledWith(new URLSearchParams("tab=live&env.g1=test"), { replace: true });
});
