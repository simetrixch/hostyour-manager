import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRegistryProbe, HttpRegistryMaintenance } from "./registry-http.ts";

// The real fetch-based RegistryProbe (ensure-images). We stub the global fetch to capture the
// manifest probe and script the registry's response — no network, no live zot. The pull credential
// rides a real temp file, exactly the mounted controller-registry-pull dockerconfigjson shape.

const HOST = "zot.m1.example";
// base64("puller:pw") — the .auths[<host>].auth value a dockerconfigjson carries.
const AUTH = Buffer.from("puller:pw").toString("base64");
const OTHER_AUTH = Buffer.from("other:pw").toString("base64");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctrl-regprobe-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function writeDockerConfig(auths: Record<string, { auth?: string }>): string {
  const file = join(dir, ".dockerconfigjson");
  writeFileSync(file, JSON.stringify({ auths }), "utf8");
  return file;
}

function stubFetch(status: number): { seen: { url: string; init: RequestInit | undefined } } {
  const seen = { url: "", init: undefined as RequestInit | undefined };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(status === 404 ? "not found" : "{}", { status });
    }),
  );
  return { seen };
}

const ref = { registryHost: HOST, repo: "platform/example-engine", tag: "0.29.0" };

describe("HttpRegistryProbe", () => {
  it("GETs the /v2 manifest URL with the host-keyed basic auth + the OCI/docker Accept set; 200 => exists", async () => {
    const file = writeDockerConfig({ "ghcr.io": { auth: OTHER_AUTH }, [HOST]: { auth: AUTH } });
    const { seen } = stubFetch(200);
    const exists = await new HttpRegistryProbe({ dockerConfigPath: file }).imageExists(ref);
    expect(exists).toBe(true);
    expect(seen.url).toBe(`https://${HOST}/v2/platform/example-engine/manifests/0.29.0`);
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${AUTH}`); // the HOST-keyed entry, not the first one
    expect(headers.accept).toContain("application/vnd.oci.image.manifest.v1+json");
    expect(headers.accept).toContain("application/vnd.docker.distribution.manifest.v2+json");
  });

  it("404 => missing (false) — the one status that means 'buildable'", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubFetch(404);
    await expect(new HttpRegistryProbe({ dockerConfigPath: file }).imageExists(ref)).resolves.toBe(false);
  });

  it("fails CLOSED when the host has no keyed entry — another registry's credential is never presented", async () => {
    // The chain-resolved host (zot.<build-plane>) can name a registry the mounted credential does
    // not cover; presenting some other entry would turn that into a misleading 401 from a foreign zot.
    const file = writeDockerConfig({ "zot.other.example": { auth: OTHER_AUTH } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(new HttpRegistryProbe({ dockerConfigPath: file }).imageExists(ref)).rejects.toThrow(new RegExp(`no auth entry for ${HOST}.*zot\\.other\\.example`));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails CLOSED (UPSTREAM) on any undecidable status — never a guess", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubFetch(503);
    await expect(new HttpRegistryProbe({ dockerConfigPath: file }).imageExists(ref)).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("fails CLOSED when the pull credential file is absent (fresh install before ESO synced) — fetch never fires", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const probe = new HttpRegistryProbe({ dockerConfigPath: join(dir, "missing.json") });
    await expect(probe.imageExists(ref)).rejects.toThrow(/controller-registry-pull/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the dockerconfigjson carries no usable auth entry", async () => {
    const file = writeDockerConfig({});
    stubFetch(200);
    await expect(new HttpRegistryProbe({ dockerConfigPath: file }).imageExists(ref)).rejects.toThrow(/no auth entry/);
  });
});

// A tiny routed fetch stub: dispatch on "METHOD path" so one test can script catalog + tags + HEAD +
// DELETE together. Each entry returns { status, json?, headers? }.
type Scripted = { status: number; json?: unknown; headers?: Record<string, string> };
function stubRouted(routes: Record<string, Scripted>): { seen: { method: string; url: string; auth: string | undefined }[] } {
  const seen: { method: string; url: string; auth: string | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ method, url, auth: headers.authorization });
      const path = url.replace(`https://${HOST}`, "");
      const r = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
      if (!r) return new Response("no route", { status: 599 });
      const body = r.json !== undefined ? JSON.stringify(r.json) : "";
      return new Response(body || null, { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });
    }),
  );
  return { seen };
}

describe("HttpRegistryMaintenance", () => {
  const cfg = (file: string) => ({ registryHost: HOST, dockerConfigPath: file });

  it("listRepos reads /v2/_catalog with the push basic auth and returns repositories[]", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    const { seen } = stubRouted({ "GET /v2/_catalog": { status: 200, json: { repositories: ["controller", "library/redis"] } } });
    const repos = await new HttpRegistryMaintenance(cfg(file)).listRepos();
    expect(repos).toEqual(["controller", "library/redis"]);
    expect(seen[0]!.auth).toBe(`Basic ${AUTH}`);
    expect(seen[0]!.url).toContain("/v2/_catalog");
  });

  it("listRepos follows the RFC-5988 Link rel=next pagination to completion", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({
      "GET /v2/_catalog": { status: 200, json: { repositories: ["controller"] }, headers: { link: '</v2/_catalog?n=1000&last=controller>; rel="next"' } },
      "GET /v2/_catalog?n=1000&last=controller": { status: 200, json: { repositories: ["example-engine"] } },
    });
    expect(await new HttpRegistryMaintenance(cfg(file)).listRepos()).toEqual(["controller", "example-engine"]);
  });

  it("listTags returns the tag list; a 404 (absent repo) yields [] not a throw", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({
      "GET /v2/controller/tags/list": { status: 200, json: { name: "controller", tags: ["1.0", "2.0"] } },
      "GET /v2/gone/tags/list": { status: 404, json: { errors: [] } },
    });
    const m = new HttpRegistryMaintenance(cfg(file));
    expect(await m.listTags("controller")).toEqual(["1.0", "2.0"]);
    expect(await m.listTags("gone")).toEqual([]);
  });

  it("listTags fails CLOSED on an undecidable status (500) — a partial list must never be trusted", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({ "GET /v2/controller/tags/list": { status: 500 } });
    await expect(new HttpRegistryMaintenance(cfg(file)).listTags("controller")).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("resolveDigest returns the Docker-Content-Digest header; a missing header fails closed", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({ "HEAD /v2/controller/manifests/1.0": { status: 200, headers: { "docker-content-digest": "sha256:beef" } } });
    expect(await new HttpRegistryMaintenance(cfg(file)).resolveDigest("controller", "1.0")).toBe("sha256:beef");

    vi.unstubAllGlobals();
    const file2 = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({ "HEAD /v2/controller/manifests/1.0": { status: 200 } }); // no digest header
    await expect(new HttpRegistryMaintenance(cfg(file2)).resolveDigest("controller", "1.0")).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("resolveDigest fails CLOSED on a 404 (a tag we just listed vanished — a race, not an answer)", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({ "HEAD /v2/controller/manifests/1.0": { status: 404 } });
    await expect(new HttpRegistryMaintenance(cfg(file)).resolveDigest("controller", "1.0")).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("deleteManifest treats 202 as done and 404 as already-gone; any other status fails closed", async () => {
    const file = writeDockerConfig({ [HOST]: { auth: AUTH } });
    stubRouted({
      "DELETE /v2/controller/manifests/sha256:beef": { status: 202 },
      "DELETE /v2/controller/manifests/sha256:gone": { status: 404 },
      "DELETE /v2/controller/manifests/sha256:bad": { status: 500 },
    });
    const m = new HttpRegistryMaintenance(cfg(file));
    await expect(m.deleteManifest("controller", "sha256:beef")).resolves.toBeUndefined();
    await expect(m.deleteManifest("controller", "sha256:gone")).resolves.toBeUndefined();
    await expect(m.deleteManifest("controller", "sha256:bad")).rejects.toMatchObject({ code: "UPSTREAM" });
  });
});
