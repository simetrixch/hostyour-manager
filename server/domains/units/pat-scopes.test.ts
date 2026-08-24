import { describe, it, expect } from "vitest";
import { REQUIRED_CONSUMER_PAT_SCOPES, missingConsumerPatScopes, requiredConsumerPatScopesSummary } from "./pat-scopes.ts";

describe("consumer PAT scope contract", () => {
  it("requires exactly repo + workflow + admin:repo_hook, in canonical order", () => {
    expect([...REQUIRED_CONSUMER_PAT_SCOPES]).toEqual(["repo", "workflow", "admin:repo_hook"]);
  });

  it("returns [] when all three required scopes are granted (extra scopes ignored)", () => {
    expect(missingConsumerPatScopes(["repo", "workflow", "admin:repo_hook", "gist"])).toEqual([]);
  });

  it("reports the COMPLETE missing set at once (never one at a time), in canonical order", () => {
    expect(missingConsumerPatScopes([])).toEqual(["repo", "workflow", "admin:repo_hook"]);
    expect(missingConsumerPatScopes(["repo"])).toEqual(["workflow", "admin:repo_hook"]);
    expect(missingConsumerPatScopes(["repo", "workflow"])).toEqual(["admin:repo_hook"]);
  });

  it("accepts the narrower write:repo_hook as satisfying admin:repo_hook", () => {
    expect(missingConsumerPatScopes(["repo", "workflow", "write:repo_hook"])).toEqual([]);
  });

  it("trims + ignores blank entries (raw X-OAuth-Scopes is comma+space separated)", () => {
    expect(missingConsumerPatScopes([" repo ", "", "workflow", "  admin:repo_hook"])).toEqual([]);
  });

  it("does NOT let a granted repo imply workflow or admin:repo_hook (separate top-level scopes)", () => {
    const missing = missingConsumerPatScopes(["repo"]);
    expect(missing).toContain("workflow");
    expect(missing).toContain("admin:repo_hook");
  });

  it("summary lists all three scopes with a reason each", () => {
    const s = requiredConsumerPatScopesSummary();
    for (const scope of REQUIRED_CONSUMER_PAT_SCOPES) expect(s).toContain(scope);
  });
});
