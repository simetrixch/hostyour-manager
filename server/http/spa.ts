import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "./app-env.ts";

/** Where `vite build` (root=web, outDir=dist) drops the bundle. cwd is the app root at runtime
 *  (`node server/index.ts`) and under vitest. */
export function spaDistDir(): string {
  return resolve(process.cwd(), "web", "dist");
}

/** Size of the built index.html (0 when unbuilt) — backs the spa.bytes degrading self-check. */
export function spaBytes(distDir: string = spaDistDir()): number {
  const index = join(resolve(distDir), "index.html");
  return existsSync(index) && statSync(index).isFile() ? statSync(index).size : 0;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * Serve the built SPA behind the chokepoint. Registered LAST so the API routes
 * win; the "*" fallback returns index.html for document GETs (client-side routing), never for
 * /api. Everything here is already gated — the shell only ever reaches an authenticated member
 * (a forbidden operator got the 403 document upstream).
 */
export function registerSpa(app: Hono<AppEnv>, distDir: string): void {
  const root = resolve(distDir);
  const indexPath = join(root, "index.html");

  app.get("/assets/*", (c) => {
    const target = resolve(join(root, c.req.path));
    if (target !== root && !target.startsWith(root + sep)) return c.notFound(); // path-traversal guard
    if (!existsSync(target) || !statSync(target).isFile()) return c.notFound();
    return new Response(readFileSync(target), {
      headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" },
    });
  });

  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    if (!existsSync(indexPath)) return c.text("The Manager UI is not built yet (run `npm run build:web`).", 503);
    return c.html(readFileSync(indexPath, "utf8"));
  });
}
