import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { collectContainerImages, requiredImagesFrom, ensureImagesStep, type RequiredImage, type EnsureImagesPorts } from "./ensure-images.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";

const HOST = "zot.m1.example";

const doc = (kind: string, raw: Record<string, unknown>): RenderedDoc => ({
  apiVersion: "apps/v1", kind, name: `${kind.toLowerCase()}-x`, namespace: "zsjs023ctne0", raw,
});

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_img", stepName: "ensure-images", db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function ports(over: Partial<EnsureImagesPorts> = {}): EnsureImagesPorts {
  return { registryProbe: new FakeRegistryProbe(), ...over };
}

const ENGINE: RequiredImage = { repo: "example-engine", tag: "0.4.0" };
const APPS: RequiredImage = { repo: "example-apps", tag: "1.1.0" };
const AUTH: RequiredImage = { repo: "example-auth", tag: "0.5.0" };

function step(prt: EnsureImagesPorts, requiredImages: readonly RequiredImage[]) {
  return ensureImagesStep(prt, { requiredImages, registryHost: HOST });
}

describe("collectContainerImages", () => {
  it("collects containers[] + initContainers[] images from nested pod templates, deduped + sorted", () => {
    const docs = [
      doc("Deployment", {
        kind: "Deployment",
        spec: { template: { spec: {
          initContainers: [{ name: "init", image: `${HOST}/example-apps:1.1.0` }],
          containers: [{ name: "app", image: `${HOST}/example-engine:0.4.0` }, { name: "sidecar", image: "docker.io/library/redis:7" }],
        } } },
      }),
      // A CronJob nests the pod template one level deeper — the recursive walk needs no kind table.
      doc("CronJob", {
        kind: "CronJob",
        spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "job", image: `${HOST}/example-engine:0.4.0` }] } } } } },
      }),
      doc("ConfigMap", { kind: "ConfigMap", data: { note: "no images here" } }),
    ];
    expect(collectContainerImages(docs)).toEqual([
      "docker.io/library/redis:7",
      `${HOST}/example-apps:1.1.0`,
      `${HOST}/example-engine:0.4.0`,
    ]);
  });
});

describe("requiredImagesFrom", () => {
  it("keeps only <registryHost>/ refs and splits each into repo:tag", () => {
    const out = requiredImagesFrom(
      [
        `${HOST}/example-engine:0.4.0`,
        `${HOST}/example-report-backend:0.2.0`,
        `${HOST}/example-auth:0.5.0`,
        "docker.io/library/redis:7", // a foreign registrations is upstream's, never ours to check
        "ghcr.io/x/y:1", // ditto
      ],
      HOST,
    );
    expect(out).toEqual([
      { repo: "example-engine", tag: "0.4.0" },
      { repo: "example-report-backend", tag: "0.2.0" },
      { repo: "example-auth", tag: "0.5.0" },
    ]);
  });

  it("dedupes on repo:tag, probes 'latest' for an untagged ref, and carries a digest through as the tag", () => {
    const out = requiredImagesFrom(
      [
        `${HOST}/example-engine:0.4.0`,
        `${HOST}/example-engine:0.4.0`, // duplicate across members
        `${HOST}/example-apps`, // untagged ⇒ the pull default "latest" is still probed
        `${HOST}/example-web@sha256:${"a".repeat(64)}`,
      ],
      HOST,
    );
    expect(out).toEqual([
      { repo: "example-engine", tag: "0.4.0" },
      { repo: "example-apps", tag: "latest" },
      { repo: "example-web", tag: `sha256:${"a".repeat(64)}` },
    ]);
  });
});

describe("ensureImagesStep", () => {
  it("no-ops (no probe) when the render pulls no registry-hosted image", async () => {
    const probe = new FakeRegistryProbe();
    const logs: string[] = [];
    await step(ports({ registryProbe: probe }), []).run(ctx(logs));
    expect(probe.probes).toEqual([]);
    expect(logs.some((l) => l.includes("nothing to check"))).toBe(true);
  });

  it("all present ⇒ probes every image exactly once and passes", async () => {
    const probe = new FakeRegistryProbe(); // defaults: everything present
    const logs: string[] = [];
    await step(ports({ registryProbe: probe }), [ENGINE, APPS, AUTH]).run(ctx(logs));
    expect(probe.probes).toEqual(["example-engine:0.4.0", "example-apps:1.1.0", "example-auth:0.5.0"]);
    expect(logs.some((l) => l.includes("all 3 required image(s) present"))).toBe(true);
  });

  it("one missing image fails the step naming it", async () => {
    const probe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] });
    await expect(step(ports({ registryProbe: probe }), [ENGINE, APPS]).run(ctx([]))).rejects.toThrow(
      /missing image\(s\) in zot\.m1\.example: example-engine:0\.4\.0 —/,
    );
  });

  it("probes EVERY image before failing, so the error names the whole missing set at once", async () => {
    const probe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0", "example-auth:0.5.0"] });
    await expect(step(ports({ registryProbe: probe }), [ENGINE, APPS, AUTH]).run(ctx([]))).rejects.toThrow(
      /missing image\(s\) in zot\.m1\.example: example-engine:0\.4\.0, example-auth:0\.5\.0 —/,
    );
    // The present image was probed too — the step never short-circuits on the first miss.
    expect(probe.probes).toEqual(["example-engine:0.4.0", "example-apps:1.1.0", "example-auth:0.5.0"]);
  });

  it("fails with a validation error, so the run stops before any pointer/project mutation", async () => {
    const probe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] });
    await expect(step(ports({ registryProbe: probe }), [ENGINE]).run(ctx([]))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
