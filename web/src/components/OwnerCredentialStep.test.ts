import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerCredentialStep } from "./OwnerCredentialStep.tsx";

// The consumer wizard mounts this step INSIDE its own form (#242): a form of its own would nest, and
// a nested form's submit bubbles to the wizard's, which then posts the onboarding.
describe("OwnerCredentialStep", () => {
  it("is not a form, and its Record is a plain button", () => {
    for (const need of [{ kind: "repository-pat" as const }, { kind: "packages-reader" as const, scopes: ["acme"] }]) {
      const html = renderToStaticMarkup(createElement(OwnerCredentialStep, { owner: "acme-owner", need, onRecord: async () => undefined, subject: "The repository" }));
      expect(html).not.toContain("<form");
      expect(html).toContain('type="button"');
      expect(html).not.toContain('type="submit"');
      expect(html).toContain("acme-owner");
    }
  });
});
