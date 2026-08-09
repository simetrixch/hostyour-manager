import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpActivator } from "./activation-http.ts";

// The real fetch-based Activator. We stub the global fetch to capture the request the step
// makes and to script the consumer ingress's response — no network, no live server.

afterEach(() => vi.unstubAllGlobals());

describe("HttpActivator", () => {
  it("POSTs the body, sends the token ONLY as the declared header, and parses a 2xx JSON response", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return new Response('{"ok":true,"activate_url":"https://example-auth.example/activate?token=t"}', {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await new HttpActivator().invoke({
      url: "https://example-auth.example/api/v1/bootstrap/invite-admin",
      method: "POST",
      tokenHeader: "X-Bootstrap-Token",
      token: "secret-token-value",
      body: { email: "admin@acme.test" },
    });

    expect(seenUrl).toBe("https://example-auth.example/api/v1/bootstrap/invite-admin");
    expect(seenInit?.method).toBe("POST");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["X-Bootstrap-Token"]).toBe("secret-token-value");
    expect(headers["content-type"]).toBe("application/json");
    // The token must ride ONLY the header — never the URL or the body.
    expect(seenUrl).not.toContain("secret-token-value");
    expect(seenInit?.body).toBe(JSON.stringify({ email: "admin@acme.test" }));
    expect(seenInit?.body).not.toContain("secret-token-value");

    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ ok: true, activate_url: "https://example-auth.example/activate?token=t" });
  });

  it("passes an optional mail object through res.json verbatim (the step interprets it)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"ok":true,"activate_url":"https://a/x","mail":{"status":"sent","transport":"smtp"}}', {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const res = await new HttpActivator().invoke({
      url: "https://example-auth.example/api/v1/bootstrap/invite-admin",
      method: "POST",
      tokenHeader: "X-Bootstrap-Token",
      token: "t",
      body: {},
    });
    expect(res.ok).toBe(true);
    expect(res.json).toEqual({ ok: true, activate_url: "https://a/x", mail: { status: "sent", transport: "smtp" } });
  });

  it("returns ok:false with the raw body on a non-2xx (so the step can fail loud)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"admin_exists"}', { status: 409, headers: { "content-type": "application/json" } })),
    );
    const res = await new HttpActivator().invoke({
      url: "https://example-auth.example/api/v1/bootstrap/invite-admin",
      method: "POST",
      tokenHeader: "X-Bootstrap-Token",
      token: "t",
      body: {},
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.bodyText).toContain("admin_exists");
  });
});
