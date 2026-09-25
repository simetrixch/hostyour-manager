import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { masterKubeClients } from "../../boot/master-kube.ts";
import { KubeClusterReader } from "../../adapters/kube/kube.ts";
import { makeClusterKubeResolver } from "../inventory/cluster-kube.ts";
import { buildRunDefinitions, register, type RunDefinitions } from "./run-definitions.ts";
import { noopDef } from "./defs/noop.run.ts";

describe("a run kind has one definition", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("refuses a second definition of a kind, and keeps the first", () => {
    const runDefinitions: RunDefinitions = new Map();
    register(runDefinitions, noopDef);
    const second = { ...noopDef };
    expect(() => register(runDefinitions, second)).toThrow("run kind noop is registered twice");
    expect(runDefinitions.get("noop")).toBe(noopDef);
  });

  it("refuses a definition handed in beside the core's that brings one of the core's kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-rd-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const config = parseConfig({ ...REQUIRED_ENV, PUBLIC_URL: "https://m1.example.com", OIDC_ISSUER: "https://idp.example/o/manager/", OIDC_CLIENT_ID: "manager", OIDC_CLIENT_SECRET: "secret", MANAGER_VERSION: "test", DATA_DIR: dir, ADMIN_SOCKET_PATH: join(dir, "admin.sock") } as NodeJS.ProcessEnv);
    const resolver = makeClusterKubeResolver({
      db: db.db,
      master: masterKubeClients(config),
      openCredential: () => Promise.reject(new Error("no credential is opened here")),
      buildClusterReader: (input) => new KubeClusterReader(input),
    });
    expect(() => buildRunDefinitions({ db: db.db, resolver }, [{ ...noopDef }])).toThrow("run kind noop is registered twice");
  });
});
