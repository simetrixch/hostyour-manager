import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CiOnlyTable } from "./CiOnlyUnits.tsx";

const render = (rows: Parameters<typeof CiOnlyTable>[0]["rows"]) => renderToStaticMarkup(createElement(CiOnlyTable, { rows, onOffboard: () => undefined }));

describe("CiOnlyTable", () => {
  it("renders nothing while no unit only runs CI, so the Consumers page shows no empty table", () => {
    expect(render([])).toBe("");
  });

  it("numbers each unit and gives it an Offboard button; a missing owner reads as a dash", () => {
    const html = render([
      { name: "alpha", repoUrl: "https://github.com/x/alpha.git", owner: "team", onboardedAt: null },
      { name: "beta", repoUrl: "https://github.com/x/beta.git", owner: null, onboardedAt: null },
    ]);
    expect(html).toContain("CI only");
    expect(html).toContain("<td>1</td><td>alpha</td>");
    expect(html).toContain("<td>2</td><td>beta</td>");
    expect(html).toContain("<td>—</td>");
    expect(html.match(/Offboard<\/button>/g)).toHaveLength(2);
  });
});
