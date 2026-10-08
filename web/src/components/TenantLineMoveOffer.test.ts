import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LineMoveView } from "../../../shared/api-types-line-move.ts";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown | (() => void))[],
}));

const api = vi.hoisted(() => ({
  getTenantLineMoves: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) {
      hooks.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    const setter = (valueOrFn: unknown) => {
      const next = typeof valueOrFn === "function" ? (valueOrFn as (prev: unknown) => unknown)(hooks.states[index]) : valueOrFn;
      hooks.states[index] = next;
    };
    return [hooks.states[index], setter];
  },
  useEffect: (effect: () => unknown | (() => void)) => {
    hooks.effects.push(effect);
  },
}));

vi.mock("../api.ts", () => api);

const { TenantLineMoveOffer } = await import("./TenantLineMoveOffer.tsx");

function render(): string {
  hooks.cursor = 0;
  return renderToStaticMarkup(createElement(TenantLineMoveOffer, { tenantId: "tnt_1", busy: false, onMove: () => undefined }));
}

const sampleOffer: LineMoveView = {
  line: "0.3",
  offer: {
    line: "0.4",
    fromBundle: "0.3.001-stable-20260901000000",
    toBundle: "0.4.000-stable-20261010120000",
    part: "example-platform",
    partTag: "0.4.001-stable-20261010000000-3333333",
    builds: ["example-engine"],
    refusals: [],
  },
};

describe("TenantLineMoveOffer", () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.cursor = 0;
    hooks.effects = [];
    vi.clearAllMocks();
  });

  it("while getTenantLineMoves is pending, holds 'Reading the engine line…'", () => {
    api.getTenantLineMoves.mockReturnValue(new Promise(() => undefined));
    const html = render();
    expect(html).toContain("Reading the engine line…");
    expect(html).not.toContain("Move to line");
  });

  it("after getTenantLineMoves answers with an offer, holds 'Move to line' and no longer the loading line", async () => {
    api.getTenantLineMoves.mockResolvedValue(sampleOffer);
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toEqual(sampleOffer));

    const html = render();
    expect(html).toContain("Move to line");
    expect(html).not.toContain("Reading the engine line…");
  });

  it("a view with line === null still renders nothing, as today", async () => {
    const noLine: LineMoveView = { line: null, offer: null };
    api.getTenantLineMoves.mockResolvedValue(noLine);
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toEqual(noLine));

    const html = render();
    expect(html).toBe("");
  });
});
