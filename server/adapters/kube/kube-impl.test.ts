// Unit tests for the PURE mapping layer of the concrete kube adapter (kube-map.ts) — raw API
// objects in, port types out. The IO shells in kube.ts need a live cluster and are
// integration-tested on the live clusters, never here.
import { describe, it, expect } from "vitest";
import {
  mapArgoStatus,
  mapApplicationSet,
  MISSING_APP_STATUS,
  mapDeployment,
  mapStatefulSet,
  mapDaemonSet,
  externalSecretsAllReady,
  mapDeployState,
  assertWritableProjectName,
  isControllerOwned,
} from "./kube-map.ts";
import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL, RESERVED_PROJECT_NAMES, syncedRevisionFor, singleSourceRevision, targetedRevisionFor } from "./port.ts";
import type { ArgoAppStatus } from "./port.ts";
import { AppError } from "../../kernel/errors.ts";

const sha = "a".repeat(40);

describe("mapArgoStatus", () => {
  it("maps a synced healthy Application (no message key when there is nothing to say)", () => {
    const s = mapArgoStatus({
      status: { sync: { status: "Synced", revision: sha }, health: { status: "Healthy" } },
    });
    expect(s).toEqual({ syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy" });
    expect(s).not.toHaveProperty("message"); // exactOptionalPropertyTypes: omitted, not undefined
  });

  it("maps a fresh CR without .status to Unknown/Unknown with a null revision", () => {
    expect(mapArgoStatus({ metadata: { name: "acme-prod" } })).toEqual({
      syncRevision: null,
      targetRevision: null,
      sync: "Unknown",
      health: "Unknown",
    });
  });

  it("normalizes out-of-vocabulary enum values to Unknown (server text is untrusted)", () => {
    const s = mapArgoStatus({ status: { sync: { status: "Weird" }, health: { status: "Sparkling" } } });
    expect(s.sync).toBe("Unknown");
    expect(s.health).toBe("Unknown");
  });

  it("prefers the operationState message over conditions", () => {
    const s = mapArgoStatus({
      status: {
        sync: { status: "OutOfSync" },
        health: { status: "Degraded" },
        operationState: { message: "one or more objects failed to apply" },
        conditions: [{ type: "ComparisonError", message: "rpc error: repo not found" }],
      },
    });
    expect(s.message).toBe("one or more objects failed to apply");
  });

  it("falls back to the first non-empty condition message", () => {
    const s = mapArgoStatus({
      status: {
        sync: { status: "Unknown" },
        health: { status: "Missing" },
        conditions: [{ type: "OrphanedResourceWarning" }, { type: "ComparisonError", message: "repo not found" }],
      },
    });
    expect(s.message).toBe("repo not found");
  });

  it("extracts operationState.phase into opPhase, omitting it when the app has never synced", () => {
    // A sync IN FLIGHT — blocked on the image-guard PreSync hook that JIT-builds the images. opPhase
    // "Running" is what tells watch-sync this is a slow build to WAIT through, not a failure.
    const running = mapArgoStatus({
      status: {
        sync: { status: "OutOfSync" },
        health: { status: "Progressing" },
        operationState: { phase: "Running", message: "waiting for completion of hook batch/Job/acme-prod-image-guard" },
      },
    });
    expect(running.opPhase).toBe("Running");
    expect(running.message).toContain("image-guard");
    // A terminally FAILED sync operation — watch-sync fails fast on this rather than waiting the budget.
    const failed = mapArgoStatus({ status: { sync: { status: "OutOfSync" }, health: { status: "Degraded" }, operationState: { phase: "Failed" } } });
    expect(failed.opPhase).toBe("Failed");
    // Never synced ⇒ opPhase OMITTED (exactOptionalPropertyTypes), never set to undefined.
    const fresh = mapArgoStatus({ status: { sync: { status: "Synced", revision: sha }, health: { status: "Healthy" } } });
    expect(fresh).not.toHaveProperty("opPhase");
    // An empty phase string is treated as absent, not as a phase.
    const empty = mapArgoStatus({ status: { sync: { status: "Unknown" }, health: { status: "Unknown" }, operationState: { phase: "" } } });
    expect(empty).not.toHaveProperty("opPhase");
  });

  it("maps a MULTI-SOURCE app's revisions[] paired with comparedTo.sources[] (index-aligned)", () => {
    // The generated consumer Application: $values + consumer chart + image-guard. Multi-source
    // apps leave sync.revision empty — the per-source truth lives in revisions[].
    const s = mapArgoStatus({
      status: {
        sync: {
          status: "Synced",
          revisions: ["c".repeat(40), sha, "c".repeat(40)],
          comparedTo: {
            sources: [
              { repoURL: "https://github.com/x/hostyour-cloud.git" },
              { repoURL: "https://github.com/x/acme.git" },
              { repoURL: "https://github.com/x/hostyour-cloud.git" },
            ],
          },
        },
        health: { status: "Healthy" },
      },
    });
    expect(s.syncRevision).toBeNull();
    expect(s.syncSources).toEqual([
      { repoURL: "https://github.com/x/hostyour-cloud.git", revision: "c".repeat(40) },
      { repoURL: "https://github.com/x/acme.git", revision: sha },
      { repoURL: "https://github.com/x/hostyour-cloud.git", revision: "c".repeat(40) },
    ]);
    // The port helper resolves the CONSUMER repo's entry — never another source's revision.
    expect(syncedRevisionFor(s, "https://github.com/x/acme.git")).toBe(sha);
    expect(syncedRevisionFor(s, "https://github.com/x/unrelated.git")).toBeNull();
  });

  it("keeps syncSources absent on a single-source app; syncedRevisionFor falls back to syncRevision", () => {
    const s = mapArgoStatus({ status: { sync: { status: "Synced", revision: sha }, health: { status: "Healthy" } } });
    expect(s).not.toHaveProperty("syncSources"); // exactOptionalPropertyTypes: omitted, not undefined
    expect(syncedRevisionFor(s, "https://github.com/x/acme.git")).toBe(sha);
  });

  it("maps a malformed revisions[]/comparedTo pairing to nulls, never fabricated strings", () => {
    const s = mapArgoStatus({
      status: {
        sync: { status: "Synced", revisions: [42, sha], comparedTo: { sources: [{ repoURL: "" }] } },
        health: { status: "Healthy" },
      },
    });
    expect(s.syncSources).toEqual([
      { repoURL: null, revision: null }, // non-string revision, empty repoURL
      { repoURL: null, revision: sha }, // no comparedTo source at this index
    ]);
  });

  it("maps the DESIRED side of .spec.sources[] to targetSources, each repo with its OWN target", () => {
    // The generated consumer Application's three sources: the GitOps repo targets the INSTALL BRANCH
    // (sources 0 and 2), the consumer's own chart targets the validated SHA (source 1). Nothing
    // positional may be read off this — hence one entry per source, repo and target together.
    const s = mapArgoStatus({
      spec: {
        sources: [
          { repoURL: "https://github.com/x/hostyour-cloud.git", targetRevision: "m1.example.com", ref: "values" },
          { repoURL: "https://github.com/x/acme.git", targetRevision: sha },
          { repoURL: "https://github.com/x/hostyour-cloud.git", targetRevision: "m1.example.com" },
        ],
      },
    });
    expect(s.targetRevision).toBeNull(); // the SINGULAR .spec.source is absent on such an app
    expect(s.targetSources).toEqual([
      { repoURL: "https://github.com/x/hostyour-cloud.git", targetRevision: "m1.example.com" },
      { repoURL: "https://github.com/x/acme.git", targetRevision: sha },
      { repoURL: "https://github.com/x/hostyour-cloud.git", targetRevision: "m1.example.com" },
    ]);
  });

  it("keeps targetSources absent on a singular .spec.source app, mapping its targetRevision instead", () => {
    const s = mapArgoStatus({ spec: { source: { targetRevision: sha } }, status: { sync: { status: "Synced", revision: sha }, health: { status: "Healthy" } } });
    expect(s).not.toHaveProperty("targetSources"); // exactOptionalPropertyTypes: omitted, not undefined
    expect(s.targetRevision).toBe(sha);
  });

  it("maps malformed .spec.sources entries to nulls, never fabricated strings", () => {
    const s = mapArgoStatus({ spec: { sources: [{ repoURL: 42, targetRevision: "" }] } });
    expect(s.targetSources).toEqual([{ repoURL: null, targetRevision: null }]);
  });
});

describe("targetedRevisionFor (the pin an Application declares FOR a given repo)", () => {
  // The measured live shape: source 0 is the GitOps repo on the install BRANCH, source 1 the consumer's
  // own chart at the pin. Reading position 0 is what made the Consumers card compare a branch NAME
  // against a SHA and report a converged consumer as drifted.
  const consumerApp: ArgoAppStatus = {
    syncRevision: null,
    targetRevision: null,
    targetSources: [
      { repoURL: "https://github.com/x/hostyour-cloud.git", targetRevision: "m1.example.com" },
      { repoURL: "https://github.com/x/acme.git", targetRevision: sha },
      { repoURL: "https://github.com/x/hostyour-cloud.git", targetRevision: "m1.example.com" },
    ],
    sync: "Synced",
    health: "Healthy",
  };

  it("resolves the ASKED repo's target, never another source's", () => {
    expect(targetedRevisionFor(consumerApp, "https://github.com/x/acme.git")).toBe(sha);
    expect(targetedRevisionFor(consumerApp, "https://github.com/x/hostyour-cloud.git")).toBe("m1.example.com");
  });

  it("is null when the repo is not among the app's sources — no answer beats the WRONG answer", () => {
    expect(targetedRevisionFor(consumerApp, "https://github.com/x/unrelated.git")).toBeNull();
  });

  it("falls back to the singular targetRevision when the app declares no sources[] (regardless of repo)", () => {
    const single: ArgoAppStatus = { syncRevision: sha, targetRevision: sha, sync: "Synced", health: "Healthy" };
    expect(targetedRevisionFor(single, "https://github.com/x/anything.git")).toBe(sha);
  });

  it("is null on a Missing app, which has no spec at all", () => {
    expect(targetedRevisionFor(MISSING_APP_STATUS, "https://github.com/x/acme.git")).toBeNull();
  });
});

describe("singleSourceRevision (the deployed revision of an app tracking ONE repo)", () => {
  it("prefers the singular syncRevision when present (a bare single-source app)", () => {
    const s: ArgoAppStatus = { syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy" };
    expect(singleSourceRevision(s)).toBe(sha);
  });

  it("falls back to the sole syncSources[0].revision when the singular is empty (a one-element .spec.sources app, e.g. the tenant base)", () => {
    // The base Application expresses its one source inside `.spec.sources`, so ArgoCD reports the
    // revision in `status.sync.revisions[]` (mapped to syncSources) and leaves the singular empty.
    const s: ArgoAppStatus = {
      syncRevision: null,
      targetRevision: null,
      syncSources: [{ repoURL: "https://github.com/x/catalog.git", revision: sha }],
      sync: "Synced",
      health: "Healthy",
    };
    expect(singleSourceRevision(s)).toBe(sha);
  });

  it("is null when neither a singular revision nor any source is present (a fresh/Missing app)", () => {
    expect(singleSourceRevision({ syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" })).toBeNull();
  });
});

describe("mapApplicationSet (the tenant fan-out set-watch mapping)", () => {
  const app = (name: string, sync: string, health: string, revision: string): unknown => ({
    metadata: { name },
    status: { sync: { status: sync, revision }, health: { status: health } },
  });

  it("keys each present Application by metadata.name via the pure mapArgoStatus", () => {
    const byName = mapApplicationSet(
      [app("g-base-prod", "Synced", "Healthy", sha), app("g-auth-prod", "OutOfSync", "Progressing", sha)],
      ["g-base-prod", "g-auth-prod"],
    );
    expect(byName.get("g-base-prod")).toEqual({ syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy" });
    expect(byName.get("g-auth-prod")).toEqual({ syncRevision: sha, targetRevision: null, sync: "OutOfSync", health: "Progressing" });
  });

  it("fills every EXPECTED name absent from the list with Missing (the completeness gate)", () => {
    const byName = mapApplicationSet([app("g-base-prod", "Synced", "Healthy", sha)], ["g-base-prod", "g-jobs-prod"]);
    expect(byName.get("g-jobs-prod")).toEqual({ syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" });
    expect(byName.get("g-jobs-prod")).toBe(MISSING_APP_STATUS); // the shared frozen singleton
  });

  it("is keyed EXACTLY by expected — a present-but-unexpected Application is ignored", () => {
    const byName = mapApplicationSet(
      [app("g-base-prod", "Synced", "Healthy", sha), app("other-tenant-app", "Synced", "Healthy", sha)],
      ["g-base-prod"],
    );
    expect([...byName.keys()]).toEqual(["g-base-prod"]);
  });

  it("an empty list makes every expected name Missing", () => {
    const byName = mapApplicationSet([], ["g-base-prod", "g-auth-prod"]);
    expect(byName.size).toBe(2);
    expect([...byName.values()].every((s) => s.health === "Missing")).toBe(true);
  });

  it("ignores a list item without a metadata.name (fills its slot from expected instead)", () => {
    const byName = mapApplicationSet([{ status: { sync: { status: "Synced" } } }], ["g-base-prod"]);
    expect(byName.get("g-base-prod")).toBe(MISSING_APP_STATUS);
  });
});

describe("workload mappers", () => {
  it("marks a Deployment available when availableReplicas covers spec.replicas, carrying desired/ready", () => {
    const w = mapDeployment({
      metadata: { name: "acme-web" },
      spec: { replicas: 2 },
      status: { availableReplicas: 2 },
    });
    expect(w).toEqual({ kind: "Deployment", name: "acme-web", available: true, desired: 2, ready: 2 });
  });

  it("a Deployment with spec.replicas 0 and no available replicas reads available — 0 of 0 desired", () => {
    // A workload switched OFF by a suspend: the desired/ready counts are the only thing that tells
    // this apart from spec.replicas simply defaulting away, since "available" alone reads the same.
    const w = mapDeployment({ metadata: { name: "acme-web" }, spec: { replicas: 0 }, status: {} });
    expect(w).toEqual({ kind: "Deployment", name: "acme-web", available: true, desired: 0, ready: 0 });
  });

  it("defaults absent spec.replicas to 1 (the API server's own default)", () => {
    const w = mapDeployment({ metadata: { name: "acme-web" }, status: {} });
    expect(w.available).toBe(false);
    expect(w.desired).toBe(1);
    expect(w.ready).toBe(0);
    expect(w.message).toBe("0/1 replicas available");
  });

  it("surfaces the False condition's message on an unavailable Deployment", () => {
    const w = mapDeployment({
      metadata: { name: "acme-web" },
      spec: { replicas: 3 },
      status: {
        availableReplicas: 1,
        conditions: [
          { type: "Available", status: "True" },
          { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "acme-web-abc" has timed out progressing.' },
        ],
      },
    });
    expect(w.desired).toBe(3);
    expect(w.ready).toBe(1);
    expect(w.message).toBe('ReplicaSet "acme-web-abc" has timed out progressing.');
  });

  it("falls back to the condition reason, then to the replica count", () => {
    const conditionOnlyReason = mapDeployment({
      metadata: { name: "a" },
      spec: { replicas: 1 },
      status: { availableReplicas: 0, conditions: [{ type: "Available", status: "False", reason: "MinimumReplicasUnavailable" }] },
    });
    expect(conditionOnlyReason.message).toBe("MinimumReplicasUnavailable");
    const noConditions = mapStatefulSet({ metadata: { name: "db" }, spec: { replicas: 3 }, status: { readyReplicas: 1 } });
    expect(noConditions.desired).toBe(3);
    expect(noConditions.ready).toBe(1);
    expect(noConditions.message).toBe("1/3 replicas available");
  });

  it("maps a StatefulSet on readyReplicas vs spec.replicas, carrying desired/ready", () => {
    const w = mapStatefulSet({ metadata: { name: "db" }, spec: { replicas: 3 }, status: { readyReplicas: 3 } });
    expect(w).toEqual({ kind: "StatefulSet", name: "db", available: true, desired: 3, ready: 3 });
  });

  it("maps a DaemonSet on numberAvailable vs desiredNumberScheduled — 0 desired is available", () => {
    const zero = mapDaemonSet({ metadata: { name: "ds" }, status: { desiredNumberScheduled: 0 } });
    expect(zero).toEqual({ kind: "DaemonSet", name: "ds", available: true, desired: 0, ready: 0 });
    const w = mapDaemonSet({ metadata: { name: "ds" }, status: { desiredNumberScheduled: 2, numberAvailable: 1 } });
    expect(w.available).toBe(false);
    expect(w.desired).toBe(2);
    expect(w.ready).toBe(1);
    expect(w.message).toBe("1/2 replicas available");
  });
});

describe("externalSecretsAllReady", () => {
  const ready = { status: { conditions: [{ type: "Ready", status: "True", reason: "SecretSynced" }] } };
  const notReady = { status: { conditions: [{ type: "Ready", status: "False", reason: "SecretSyncedError" }] } };

  it("zero ExternalSecrets is ready", () => {
    expect(externalSecretsAllReady([])).toBe(true);
  });

  it("all Ready=True is ready; one unready item flips it", () => {
    expect(externalSecretsAllReady([ready, ready])).toBe(true);
    expect(externalSecretsAllReady([ready, notReady])).toBe(false);
  });

  it("an item without status/conditions counts as not ready (fail closed)", () => {
    expect(externalSecretsAllReady([{}])).toBe(false);
  });
});

describe("mapDeployState", () => {
  const data = { domain: "s1.example", stage: "prod", writtenAt: "2026-07-13T00:00:00Z", generation: "3" };

  it("maps the ConfigMap data, parsing generation as an integer", () => {
    expect(mapDeployState(data)).toEqual({
      domain: "s1.example",
      stage: "prod",
      writtenAt: "2026-07-13T00:00:00Z",
      generation: 3,
    });
  });

  it("carries NO role — the cluster role is not a fact an app may see", () => {
    expect(mapDeployState({ ...data, role: "slave" })).not.toHaveProperty("role");
  });

  it("throws VALIDATION on a missing key (fail closed, with the key named)", () => {
    const { stage: _stage, ...withoutStage } = data;
    const boom = (): unknown => mapDeployState(withoutStage);
    expect(boom).toThrow(AppError);
    expect(boom).toThrow(/missing "stage"/);
    try {
      boom();
    } catch (e) {
      expect((e as AppError).code).toBe("VALIDATION");
    }
  });

  it("throws VALIDATION on empty data and on a non-integer generation", () => {
    expect(() => mapDeployState(undefined)).toThrow(/ConfigMap is missing/);
    expect(() => mapDeployState({ ...data, generation: "3abc" })).toThrow(/generation is not an integer/);
  });
});

describe("AppProject writer guards", () => {
  it("assertWritableProjectName throws VALIDATION on each reserved platform project", () => {
    for (const reserved of RESERVED_PROJECT_NAMES) {
      const boom = (): void => assertWritableProjectName(reserved);
      expect(boom).toThrow(AppError);
      expect(boom).toThrow(/reserved platform project/);
      try {
        boom();
      } catch (e) {
        expect((e as AppError).code).toBe("VALIDATION");
      }
    }
  });

  it("assertWritableProjectName passes a normal consumer name", () => {
    expect(() => assertWritableProjectName("acme")).not.toThrow();
  });

  it("isControllerOwned accepts EITHER the consumer or the tenant ownership label (exact match)", () => {
    expect(isControllerOwned({ metadata: { labels: { [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value } } })).toBe(true);
    expect(isControllerOwned({ metadata: { labels: { [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value } } })).toBe(true);
    expect(isControllerOwned({ metadata: { labels: { [CONSUMER_PROJECT_LABEL.key]: "false" } } })).toBe(false);
    expect(isControllerOwned({ metadata: { labels: { [TENANT_PROJECT_LABEL.key]: "false" } } })).toBe(false);
    expect(isControllerOwned({ metadata: { labels: { other: "true" } } })).toBe(false);
    expect(isControllerOwned({ metadata: {} })).toBe(false);
    expect(isControllerOwned({})).toBe(false);
    expect(isControllerOwned(null)).toBe(false);
  });
});
