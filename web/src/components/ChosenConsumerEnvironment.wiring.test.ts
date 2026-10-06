import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ConsumerView } from "../api.ts";
import { groupEnvironments } from "../tenantRows.ts";
import { ChosenConsumerEnvironment } from "./ConsumerCardHead.tsx";

const row = (id: string, stage: ConsumerView["stage"]): ConsumerView => ({ id, name: "acme", stage, status: "active" } as ConsumerView);
const group = () => groupEnvironments([row("app_p", "prod"), row("app_t", "test")], (r) => r.name)[0]!;
const shown = (search: URLSearchParams) => ChosenConsumerEnvironment({ group: group(), search, setSearch: vi.fn(), children: (c) => c.id }) as unknown as string;

it("PLANTED: opens the card on the stage the URL names, so a remount keeps it", () => {
  expect(shown(new URLSearchParams("env.acme=test"))).toBe("app_t");
});

it("opens the card on the default stage where the URL names none", () => {
  expect(shown(new URLSearchParams())).toBe("app_p");
});

it("puts the stage the head picks into the URL, replacing the entry", () => {
  const setSearch = vi.fn();
  const head = ChosenConsumerEnvironment({ group: group(), search: new URLSearchParams("tab=live"), setSearch, children: (_c, h) => h }) as ReactElement<{ onSelect: (r: ConsumerView) => void }>;
  head.props.onSelect(row("app_t", "test"));
  expect(setSearch).toHaveBeenCalledWith(new URLSearchParams("tab=live&env.acme=test"), { replace: true });
});
