import { describe, it, expect } from "vitest";
import { renderForbidden, FORBIDDEN_CSS_PATH, FORBIDDEN_CSS } from "./forbidden.ts";

describe("forbidden 403 document", () => {
  it("renders a non-empty document naming the email, group, and sign-out link", () => {
    const html = renderForbidden({ email: "user@x.example", group: "admins", signoutUrl: "/auth/logout" });
    expect(html.length).toBeGreaterThan(100);
    expect(html).toContain("user@x.example");
    expect(html).toContain("admins");
    expect(html).toContain("/auth/logout");
  });

  it("escapes HTML in the email (no injection)", () => {
    const html = renderForbidden({ email: "<script>x", group: "admins", signoutUrl: "/auth/logout" });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders without an email", () => {
    const html = renderForbidden({ group: "admins", signoutUrl: "/auth/logout" });
    expect(html).toContain("signed in");
    expect(html).toContain("admins");
  });

  it("carries NO inline style — the shipped CSP has no 'unsafe-inline', so a browser refuses it", () => {
    const html = renderForbidden({ email: "user@x.example", group: "admins", signoutUrl: "/auth/logout" });
    expect(html).not.toContain("<style");
    expect(html).not.toContain("style=");
    expect(html).toContain(`<link rel="stylesheet" href="${FORBIDDEN_CSS_PATH}">`);
  });

  it("the stylesheet styles the elements the document renders", () => {
    for (const selector of ["body{", "code{", "a{"]) expect(FORBIDDEN_CSS).toContain(selector);
  });
});
