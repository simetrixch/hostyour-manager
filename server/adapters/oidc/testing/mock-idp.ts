import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

// An in-process OIDC provider for tests: real discovery + jwks + authorize + token, with an
// ES256-signed id_token. openid-client discovers and validates against it for real — the
// adapter exercises the genuine protocol, not a stub. Over http, so the adapter's
// allowInsecureRequests path is what makes it reachable.
export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  setGroups(groups: string[]): void;
  setEmail(email: string): void;
  /** Directly register an authorization code (bypasses the browser /authorize hop). */
  mintCode(redirectUri: string): string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export async function startMockIdp(opts?: { subject?: string; email?: string; groups?: string[] }): Promise<MockIdp> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = "mock-key-1";
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const subject = opts?.subject ?? "idp-user-abc";
  const clientId = "manager";
  const clientSecret = "test-secret";
  const codes = new Set<string>();
  let email = opts?.email ?? "user@example.com";
  let groups = opts?.groups ?? [];
  let issuer = "";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      return sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "email", "profile"],
        claims_supported: ["sub", "email", "groups"],
      });
    }
    if (url.pathname === "/jwks") return sendJson(res, 200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state");
      const code = `code-${randomBytes(8).toString("hex")}`;
      codes.add(code);
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      if (state) back.searchParams.set("state", state);
      res.statusCode = 302;
      res.setHeader("location", back.href);
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      void readBody(req)
        .then(async (body) => {
          const code = new URLSearchParams(body).get("code") ?? "";
          if (!codes.delete(code)) return sendJson(res, 400, { error: "invalid_grant" });
          const nowSec = Math.floor(Date.now() / 1000);
          const idToken = await new SignJWT({ email, groups })
            .setProtectedHeader({ alg: "ES256", kid })
            .setIssuer(issuer)
            .setSubject(subject)
            .setAudience(clientId)
            .setIssuedAt(nowSec)
            .setExpirationTime(nowSec + 300)
            .sign(privateKey);
          return sendJson(res, 200, { access_token: `at-${randomBytes(8).toString("hex")}`, token_type: "Bearer", id_token: idToken, expires_in: 300 });
        })
        .catch(() => {
          res.statusCode = 500;
          res.end();
        });
      return;
    }
    if (url.pathname === "/logout") {
      res.statusCode = 302;
      res.setHeader("location", url.searchParams.get("post_logout_redirect_uri") ?? issuer);
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    setGroups(g) {
      groups = g;
    },
    setEmail(e) {
      email = e;
    },
    mintCode(_redirectUri) {
      const code = `code-${randomBytes(8).toString("hex")}`;
      codes.add(code);
      return code;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
