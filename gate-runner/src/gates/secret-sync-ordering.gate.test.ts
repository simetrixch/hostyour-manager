// gate-runner/src/gates/secret-sync-ordering.gate.test.ts
import { describe, it, expect } from "vitest";
import { secretSyncOrderingGate } from "./secret-sync-ordering.gate.ts";
import type { GateContext, RenderedDoc } from "./gate.ts";

function makeCtx(raws: Record<string, unknown>[]): GateContext {
  const rendered: RenderedDoc[] = raws.map((raw, i) => ({
    env: "dev",
    docIndex: i,
    apiVersion: String(raw.apiVersion),
    kind: String(raw.kind),
    name: String((raw.metadata as { name: string }).name),
    namespace: "acme",
    raw,
  }));
  return { targetName: "acme", stage: "dev", chartPath: "deploy/chart", clusterValueFiles: [], files: new Map(), manifest: null, rendered, dependencies: [] };
}

const annotated = (wave?: number, hook?: string): Record<string, unknown> => ({
  ...(wave === undefined ? {} : { "argocd.argoproj.io/sync-wave": String(wave) }),
  ...(hook === undefined ? {} : { "argocd.argoproj.io/hook": hook }),
});

function claim(name: string, secretName: string | undefined, wave?: number): Record<string, unknown> {
  return {
    apiVersion: "platform.hostyour.cloud/v1alpha1",
    kind: "ServiceClaim",
    metadata: { name, annotations: annotated(wave) },
    spec: { service: name === "registry-pull" ? "registry" : name, ...(secretName === undefined ? {} : { secretName }) },
  };
}

function deployment(pod: Record<string, unknown>, wave?: number, hook?: string): Record<string, unknown> {
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "app", annotations: annotated(wave, hook) }, spec: { template: { spec: pod } } };
}

const pulls = (secret: string) => ({ imagePullSecrets: [{ name: secret }], containers: [{ name: "app", image: "x:1" }] });

describe("secretSyncOrderingGate G30", () => {
  it("PLANTED: a Deployment pulling with a claim's Secret in the claim's own wave is refused, naming both and the wave", () => {
    const r = secretSyncOrderingGate.check(makeCtx([claim("registry-pull", "acme-registry-pull"), deployment(pulls("acme-registry-pull"))]));
    expect(r.status).toBe("fail");
    expect(r.found).toContain("Deployment/app");
    expect(r.found).toContain("ServiceClaim/registry-pull");
    expect(r.found).toContain("wave 0");
  });

  it("PLANTED innocent: the same chart with the claim one wave earlier passes", () => {
    const r = secretSyncOrderingGate.check(makeCtx([claim("registry-pull", "acme-registry-pull", -1), deployment(pulls("acme-registry-pull"))]));
    expect(r.status).toBe("pass");
  });

  it("reads every way a pod names a Secret: env, envFrom, volumes, projected volumes, init containers", () => {
    const pods = [
      { containers: [{ name: "a", env: [{ name: "U", valueFrom: { secretKeyRef: { name: "s", key: "U" } } }] }] },
      { containers: [{ name: "a", envFrom: [{ secretRef: { name: "s" } }] }] },
      { containers: [{ name: "a" }], volumes: [{ name: "v", secret: { secretName: "s" } }] },
      { containers: [{ name: "a" }], volumes: [{ name: "v", projected: { sources: [{ secret: { name: "s" } }] } }] },
      { containers: [{ name: "a" }], initContainers: [{ name: "i", env: [{ name: "U", valueFrom: { secretKeyRef: { name: "s", key: "U" } } }] }] },
    ];
    for (const pod of pods) expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s"), deployment(pod)])).status).toBe("fail");
  });

  it("takes a claim's Secret name as the provisioner does when the claim names none: <claim>-<service>", () => {
    expect(secretSyncOrderingGate.check(makeCtx([claim("redis", undefined), deployment(pulls("redis-redis"))])).status).toBe("fail");
  });

  it("refuses a PreSync hook that uses a claim's Secret, whatever the waves: it runs before every wave", () => {
    const r = secretSyncOrderingGate.check(makeCtx([claim("redis", "s", -5), deployment(pulls("s"), 0, "PreSync")]));
    expect(r.status).toBe("fail");
    expect(r.found).toContain("PreSync");
  });

  it("reads a CronJob's and a StatefulSet's pod, and passes a workload that uses no claim's Secret", () => {
    const cron = { apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "nightly" }, spec: { jobTemplate: { spec: { template: { spec: pulls("s") } } } } };
    expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s"), cron])).status).toBe("fail");
    const sts = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "mta" }, spec: { template: { spec: pulls("s") } } };
    expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s"), sts])).status).toBe("fail");
    expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s"), deployment(pulls("other"))])).status).toBe("pass");
  });

  it("PLANTED: a pod reading the Secret an ExternalSecret writes in the pod's own wave is refused, target.name or the ExternalSecret's own name", () => {
    const external = (name: string, target: string | undefined, wave?: number) => ({
      apiVersion: "external-secrets.io/v1", kind: "ExternalSecret", metadata: { name, annotations: annotated(wave) },
      spec: target === undefined ? {} : { target: { name: target } },
    });
    const env = (secret: string) => ({ containers: [{ name: "a", env: [{ name: "T", valueFrom: { secretKeyRef: { name: secret, key: "T" } } }] }] });
    const r = secretSyncOrderingGate.check(makeCtx([external("app", "acme-app"), deployment(env("acme-app"))]));
    expect(r.status).toBe("fail");
    expect(r.found).toContain("ExternalSecret/app");
    expect(r.reason).toContain("before ESO has written");
    expect(secretSyncOrderingGate.check(makeCtx([external("acme-app", undefined), deployment(env("acme-app"))])).status).toBe("fail");
    expect(secretSyncOrderingGate.check(makeCtx([external("app", "acme-app", -1), deployment(env("acme-app"))])).status).toBe("pass");
  });

  it("passes a hook that runs after every wave, and a skipped one; a Sync hook is judged by its wave", () => {
    for (const hook of ["PostSync", "SyncFail", "PostDelete", "Skip"]) {
      expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s"), deployment(pulls("s"), 0, hook)])).status, hook).toBe("pass");
    }
    expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s"), deployment(pulls("s"), 0, "Sync")])).status).toBe("fail");
    // A hook that also runs PreSync runs before every wave, whatever its wave says.
    expect(secretSyncOrderingGate.check(makeCtx([claim("redis", "s", -5), deployment(pulls("s"), 0, "PreSync,PostSync")])).status).toBe("fail");
  });

  it("reads a wave as Argo CD's Atoi does: a sign is allowed, a space is not", () => {
    const waved = (wave: string) => ({ ...claim("redis", "s"), metadata: { name: "redis", annotations: { "argocd.argoproj.io/sync-wave": wave } } });
    expect(secretSyncOrderingGate.check(makeCtx([waved("-1"), deployment(pulls("s"), 0)])).status).toBe("pass");
    // "+1" is wave 1 for Argo CD, after the Deployment's 0.
    expect(secretSyncOrderingGate.check(makeCtx([waved("+1"), deployment(pulls("s"), 0)])).status).toBe("fail");
    // " -1" is not an integer for Argo CD, so the claim stands at 0, beside the Deployment.
    expect(secretSyncOrderingGate.check(makeCtx([waved(" -1"), deployment(pulls("s"), 0)])).status).toBe("fail");
  });

  it("passes a chart with no claim and says there was nothing to order", () => {
    const r = secretSyncOrderingGate.check(makeCtx([deployment(pulls("s"))]));
    expect(r.status).toBe("pass");
    expect(r.found).toContain("no ServiceClaim or ExternalSecret");
  });
});
