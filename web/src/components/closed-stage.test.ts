import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClosedStageLine, CLOSED_STAGE_LINE } from "./closed-stage.tsx";

describe("ClosedStageLine", () => {
  it("renders the closed warning line when quiesced is true", () => {
    const html = renderToStaticMarkup(createElement(ClosedStageLine, { quiesced: true }));
    expect(html.replace(/&#x27;/g, "'")).toContain(CLOSED_STAGE_LINE);
    expect(html).toContain("recon__fact--down");
  });

  it("renders nothing when quiesced is false", () => {
    const html = renderToStaticMarkup(createElement(ClosedStageLine, { quiesced: false }));
    expect(html).toBe("");
  });

  it("renders nothing when quiesced is null", () => {
    const html = renderToStaticMarkup(createElement(ClosedStageLine, { quiesced: null }));
    expect(html).toBe("");
  });
});
