// gate-runner/src/gates/g8.test.ts
import { describe, it, expect } from "vitest";
import { g8 } from "./g8.ts";
import type { GateContext, RenderedDoc } from "./gate.ts";

/** Wrap raw k8s objects as rendered docs and drop them into an otherwise-empty GateContext. */
function makeCtx(raws: Record<string, unknown>[]): GateContext {
  const rendered: RenderedDoc[] = raws.map((raw, i) => ({
    env: "dev",
    docIndex: i,
    apiVersion: typeof raw.apiVersion === "string" ? raw.apiVersion : "apps/v1",
    kind: typeof raw.kind === "string" ? raw.kind : "Deployment",
    name: "acme",
    namespace: "acme",
    raw,
  }));
  return {
    targetName: "acme",
    stage: "dev",
    chartPath: "deploy/chart",
    clusterValueFiles: [],
    files: new Map(),
    manifest: null,
    rendered,
    dependencies: [],
  };
}

/** A Deployment whose pod template runs `images` as its containers. */
function deployment(images: string[]): Record<string, unknown> {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "acme" },
    spec: { template: { spec: { containers: images.map((image, i) => ({ name: `c${i}`, image })) } } },
  };
}

describe("g8 image discipline", () => {
  it("passes a clean context: tagged images, a host:port tag, and a digest-only ref", () => {
    const ctx = makeCtx([
      deployment(["nginx:1.25.3", "zot.local:5000/app:2.1.0", "busybox@sha256:deadbeefdeadbeefdeadbeefdeadbeef"]),
    ]);
    const r = g8.check(ctx);
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // Failure mode 1: a container image with NO tag (implicit latest).
  it("fails an untagged image (implicit :latest)", () => {
    const r = g8.check(makeCtx([deployment(["nginx"])]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain('"nginx"');
    expect(r.reason).toMatch(/no tag/i);
  });

  // Failure mode 2: a container image with an explicit :latest tag.
  it("fails an explicit :latest tag", () => {
    const r = g8.check(makeCtx([deployment(["nginx:latest"])]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain('"nginx:latest"');
    expect(r.reason).toMatch(/:latest/i);
  });

  // Failure mode 3: :latest but pinned by a digest — the digest wins, so this PASSES.
  it("passes a :latest tag that also carries an @sha256 digest", () => {
    const ref = "registry:5000/app:latest@sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
    const r = g8.check(makeCtx([deployment([ref])]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // The scan must reach initContainers (not just containers), and cite the offending ref.
  it("fails a mutable image hiding in initContainers", () => {
    const raw: Record<string, unknown> = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "acme" },
      spec: {
        template: {
          spec: {
            initContainers: [{ name: "init", image: "migrate:latest" }],
            containers: [{ name: "app", image: "app:1.0.0" }],
          },
        },
      },
    };
    const r = g8.check(makeCtx([raw]));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain('"migrate:latest"');
    expect(r.evidence?.[0]?.fieldPath).toContain("initContainers");
  });

  // Regression (adversarial finding): a bogus "@0:0" digest on a :latest ref is neither a real
  // pinning digest nor a deployable one, so it must NOT satisfy the digest exception => FAIL.
  it("fails a :latest ref whose only digest is a bogus @0:0", () => {
    const r = g8.check(makeCtx([deployment(["app:latest@0:0"])]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain('"app:latest@0:0"');
  });

  // Regression: a genuine @sha256 digest (64 hex chars) still pins a :latest ref => PASS.
  it("passes a :latest ref carrying a real @sha256 digest (64 hex)", () => {
    const ref = "app:latest@sha256:" + "a".repeat(64);
    const r = g8.check(makeCtx([deployment([ref])]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // Regression: a syntactically-shaped but too-short hex ("deadbeef" = 8 chars < 32) is not a real
  // digest, so a :latest ref carrying only it is not pinned => FAIL.
  it("fails a :latest ref whose @sha256 digest is too short to be real", () => {
    const r = g8.check(makeCtx([deployment(["app:latest@sha256:deadbeef"])]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain('"app:latest@sha256:deadbeef"');
  });

  it("does not crash on malformed pod specs (non-object containers, non-string image)", () => {
    const raw: Record<string, unknown> = {
      kind: "Pod",
      spec: { containers: ["not-an-object", { name: "x", image: 42 }, { image: "ok:1.0" }] },
    };
    const r = g8.check(makeCtx([raw]));
    // Only the one well-formed, properly-tagged image is considered => pass.
    expect(r.status).toBe("pass");
  });
});
