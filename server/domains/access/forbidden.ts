const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * Where the 403 document loads its stylesheet from. The shipped CSP is
 * `default-src 'self'` with no `'unsafe-inline'`, so a browser refuses an inline `<style>`
 * block — the styling must arrive as a same-origin file. The route is registered in front of
 * the chokepoint: a stylesheet fetch is not a document request, so behind the gate a
 * forbidden operator's fetch would be answered with JSON 403 and the page would stay bare.
 */
export const FORBIDDEN_CSS_PATH = "/access/forbidden.css";

/** The 403 document's stylesheet, served verbatim from FORBIDDEN_CSS_PATH. */
export const FORBIDDEN_CSS = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
code{background:#eee;padding:.1em .3em;border-radius:.2em}
a{color:#0a5}
`;

/**
 * The static, server-rendered 403 document. Zero SPA dependency — the
 * SPA sits behind auth, so a forbidden operator must never be handed the app shell. Shown
 * to a browser navigation when the operator is authenticated but not in the admins group.
 */
export function renderForbidden(opts: { email?: string; group: string; signoutUrl: string }): string {
  const who = opts.email ? `signed in as <strong>${escapeHtml(opts.email)}</strong>` : "signed in";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access denied</title>
<link rel="stylesheet" href="${FORBIDDEN_CSS_PATH}"></head>
<body>
<h1>Access denied</h1>
<p>You are ${who}, but not a member of <code>${escapeHtml(opts.group)}</code>.</p>
<p>Ask an administrator to add you to that group, then sign in again.</p>
<p><a href="${escapeHtml(opts.signoutUrl)}">Sign out</a></p>
</body>
</html>`;
}
