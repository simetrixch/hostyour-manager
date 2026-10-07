// The fake Vault the tests of the unit plugin's Vault adapters talk to: an HTTP server that records
// every request and answers with the status a test sets, and the Manager's own kubernetes-auth
// scaffold around it.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultSelfSeeder } from "./vault-self-seeder.ts";
import type { VaultSelfAuth } from "./vault-self-login.ts";

export interface Recorded {
  method: string;
  url: string;
  token?: string;
  body?: unknown;
}

/** The running fake; a test that needs another answer shape swaps its request listener. */
export let server: Server;

/** What the fake Vault answers and what it was asked, reset by every start. A test sets a field to
 *  replay a status: `dataPut` is what the KV-v2 data write answers (200: the entry did not exist and
 *  was created; a test replays Vault's cas-conflict with 400), `metaList` what a metadata LIST answers
 *  (404: no key stands under the folder), `metaLists` what the LIST of one folder answers
 *  instead, by the folder's path below the mount, and `dataGet` what a KV-v2 data read answers. */
export const vault = {
  base: "",
  recorded: [] as Recorded[],
  loginStatus: 200,
  metaDeleteStatus: 200,
  dataPut: { status: 200, body: "{}" },
  metaList: { status: 404, body: "{}" },
  metaLists: {} as Record<string, { status: number; body: string }>,
  dataGet: { status: 404, body: "{}" },
};

export function startVault(): Promise<void> {
  Object.assign(vault, { base: "", recorded: [], loginStatus: 200, metaDeleteStatus: 200, dataPut: { status: 200, body: "{}" }, metaList: { status: 404, body: "{}" }, metaLists: {}, dataGet: { status: 404, body: "{}" } });
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method ?? "", url: req.url ?? "" };
      const t = req.headers["x-vault-token"];
      if (typeof t === "string") rec.token = t;
      if (raw) {
        try {
          rec.body = JSON.parse(raw);
        } catch {
          rec.body = raw;
        }
      }
      vault.recorded.push(rec);
      if (req.url?.endsWith("/login")) {
        if (vault.loginStatus !== 200) {
          res.writeHead(vault.loginStatus);
          res.end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ auth: { client_token: "s.tok123" } }));
        return;
      }
      if (req.method === "GET" && req.url?.includes("/metadata/") && req.url.endsWith("?list=true")) {
        const answer = vault.metaLists[req.url.replace(/^\/v1\/secret\/metadata\//, "").replace(/\?list=true$/, "")] ?? vault.metaList;
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
        return;
      }
      if (req.method === "DELETE" && req.url?.includes("/metadata/")) {
        res.writeHead(vault.metaDeleteStatus);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url?.includes("/data/")) {
        res.writeHead(vault.dataGet.status, { "content-type": "application/json" });
        res.end(vault.dataGet.body);
        return;
      }
      if (req.method === "POST" && req.url?.includes("/data/")) {
        res.writeHead(vault.dataPut.status, { "content-type": "application/json" });
        res.end(vault.dataPut.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      const addr = server.address();
      vault.base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
      resolve();
    }),
  );
}

export function stopVault(): Promise<void> {
  return new Promise<void>((r) => server.close(() => r()));
}

/** Every call rides the Manager's OWN kubernetes-auth identity, so every test needs a real
 *  ServiceAccount token file on disk — a scaffold torn down per test. */
export function withSelfAuth<T>(fn: (self: VaultSelfAuth) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mgr-seeder-sa-"));
  const saTokenPath = join(dir, "token");
  writeFileSync(saTokenPath, "sa-jwt\n", "utf8");
  return fn({ addr: vault.base, k8sAuthMount: "kubernetes", k8sRole: "manager", saTokenPath }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export function withSelf<T>(fn: (seeder: VaultSelfSeeder) => Promise<T>): Promise<T> {
  return withSelfAuth((self) => fn(new VaultSelfSeeder({ self })));
}
