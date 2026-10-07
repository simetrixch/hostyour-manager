import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClosedStageLine, CLOSED_STAGE_LINE } from "./closed-stage.tsx";

describe("ClosedStageLine", () => {
  // Mutant: replacing `quiesced !== true` with `quiesced === false` fails to render when quiesced is true.
  it("renders the closed warning line when quiesced is true", () => {
    const html = renderToStaticMarkup(createElement(ClosedStageLine, { quiesced: true }));
    expect(html.replace(/&#x27;/g, "'")).toContain(CLOSED_STAGE_LINE);
    expect(html).toContain("recon__fact--down");
  });

  // Mutant: replacing `quiesced !== true` with `quiesced == null` renders when quiesced is false.
  it("renders nothing when quiesced is false", () => {
    const html = renderToStaticMarkup(createElement(ClosedStageLine, { quiesced: false }));
    expect(html).toBe("");
  });

  // Mutant: replacing `quiesced !== true` with `!quiesced` renders when quiesced is null.
  it("renders nothing when quiesced is null", () => {
    const html = renderToStaticMarkup(createElement(ClosedStageLine, { quiesced: null }));
    expect(html).toBe("");
  });
});
