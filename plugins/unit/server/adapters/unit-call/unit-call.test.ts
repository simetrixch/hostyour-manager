import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpUnitCall } from "./unit-call.ts";

// The call carries the kept key in X-Manager-Key and the body as JSON, reads a JSON answer, and turns
// a transport failure or a timeout into an answer without a status instead of a throw.
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((done) => s.close(() => done()));
  }
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/sender-domains/customer.test/issuers`;
}

describe("HttpUnitCall", () => {
  it("sends the method, the key and the JSON body, and reads the JSON answer", async () => {
    const seen: { method?: string; key?: string; type?: string; body?: string } = {};
    const url = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        Object.assign(seen, { method: req.method, key: req.headers["x-manager-key"], type: req.headers["content-type"], body });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ removed: true }));
      });
    });
    const answer = await new HttpUnitCall().call({ method: "DELETE", url, key: "kept", body: { issuer: "https://auth.acme.example.com" } });
    expect(answer).toEqual({ status: 200, detail: "HTTP 200", body: { removed: true } });
    expect(seen).toEqual({ method: "DELETE", key: "kept", type: "application/json", body: '{"issuer":"https://auth.acme.example.com"}' });
  });

  it("answers a non-JSON body without one, and a refused connection or a timeout without a status", async () => {
    const url = await serve((_req, res) => res.writeHead(503).end("<html>"));
    expect(await new HttpUnitCall().call({ method: "PUT", url, key: "k", body: {} })).toEqual({ status: 503, detail: "HTTP 503" });
    const refused = await new HttpUnitCall().call({ method: "PUT", url: "http://127.0.0.1:1/x", key: "k", body: {} });
    expect(refused.status).toBeNull();
    const silent = await serve(() => undefined);
    const timedOut = await new HttpUnitCall({ timeoutMs: 50 }).call({ method: "PUT", url: silent, key: "k", body: {} });
    expect(timedOut.status).toBeNull();
  });
});
