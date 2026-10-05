import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerSpa, spaBytes } from "./spa.ts";
import type { AppEnv } from "./app-env.ts";

describe("SPA static serving", () => {
  const dirs: string[] = [];
  function dist(withBuild = true): string {
    const dir = mkdtempSync(join(tmpdir(), "mgr-spa-"));
    dirs.push(dir);
    if (withBuild) {
      writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>");
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets", "app.js"), "export const x = 1;");
    }
    return dir;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function app(distDir: string): Hono<AppEnv> {
    const a = new Hono<AppEnv>();
    registerSpa(a, distDir);
    return a;
  }

  it("serves index.html for a document GET (client-side routing)", async () => {
    const res = await app(dist()).request("/runs/abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("id=root");
  });

  it("serves a hashed asset with a long immutable cache header", async () => {
    const res = await app(dist()).request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("does not intercept /api routes (falls through to 404)", async () => {
    const res = await app(dist()).request("/api/whatever");
    expect(res.status).toBe(404);
  });

  it("returns 503 when the bundle is not built (dev-safe boot)", async () => {
    const res = await app(dist(false)).request("/");
    expect(res.status).toBe(503);
  });

  it("serves the tab icon the page names, not the page in its place", async () => {
    const dir = dist();
    writeFileSync(join(dir, "favicon.svg"), "<svg/>");
    const res = await app(dir).request("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe("<svg/>");
  });

  // The icon comes from the Manager's own origin (its CSP is default-src 'self'). The file is the
  // company's S app icon, written from the simplidigita signature's assets; that package's test
  // goes red when the two drift.
  it("the page names the S as its tab icon and ships it", () => {
    expect(readFileSync(join("web", "index.html"), "utf8")).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(readFileSync(join("web", "public", "favicon.svg"), "utf8")).toContain('<mask id="female-upper">');
  });

  it("spaBytes reports index size when built, 0 when absent", () => {
    expect(spaBytes(dist())).toBeGreaterThan(0);
    expect(spaBytes(dist(false))).toBe(0);
  });
});
