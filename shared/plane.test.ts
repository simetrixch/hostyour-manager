import { describe, it, expect } from "vitest";
import { ClusterPlaneV0, readClusterPlane } from "./plane.ts";

// the versioned v0 identity written to
// clusters.plane_json. These tests pin the frozen shape — a valid plane round-trips through
// JSON (that's how it is stored), `v` is always 0, the slave cluster name is its own <name>,
// and the required sub-objects are enforced.

const validPlane: ClusterPlaneV0 = {
  v: 0,
  branch: "s1.example.com",
  slaveId: 1,
  vault: {
    addr: "https://vault.m1.example.com:8200",
    kvMount: "s1",
    k8sAuthPath: "kubernetes-s1",
    policy: "s1-eso",
  },
  argo: { namespace: "s1", appName: "s1-apps" },
  kube: { server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==" },
  credentialIds: { clusterBearer: "cred_bearer1", reviewerJwt: "cred_reviewer1" },
  hostnames: { kube: "kube-s1.m1.example.com" },
};

describe("ClusterPlaneV0 ", () => {
  it("round-trips a valid plane through JSON (the plane_json storage path)", () => {
    const stored = JSON.parse(JSON.stringify(validPlane)); // as read back from the json column
    const parsed = ClusterPlaneV0.parse(stored);
    expect(parsed).toEqual(validPlane);
    expect(parsed.v).toBe(0);
    expect(parsed.argo.appName).toBe("s1-apps");
  });

  it("accepts a plane without the optional hostnames.kube (Headlamp not yet enabled)", () => {
    const { hostnames: _drop, ...rest } = validPlane;
    const parsed = ClusterPlaneV0.parse({ ...rest, hostnames: {} });
    expect(parsed.hostnames.kube).toBeUndefined();
  });

  it("rejects a wrong version literal (v must be 0)", () => {
    const bad = { ...validPlane, v: 1 };
    expect(ClusterPlaneV0.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing vault field (policy)", () => {
    const { policy: _drop, ...vaultRest } = validPlane.vault;
    const bad = { ...validPlane, vault: vaultRest };
    expect(ClusterPlaneV0.safeParse(bad).success).toBe(false);
  });

  it("accepts any slave-<name>-based argo namespace/appName (generic, no longer a literal)", () => {
    const other = { ...validPlane, argo: { namespace: "s2", appName: "s2-apps" } };
    expect(ClusterPlaneV0.safeParse(other).success).toBe(true);
  });

  it("rejects a missing/empty kube field (server + caData are required for the resolver)", () => {
    const { kube: _drop, ...rest } = validPlane;
    expect(ClusterPlaneV0.safeParse(rest).success).toBe(false);
    expect(ClusterPlaneV0.safeParse({ ...validPlane, kube: { server: "not a url", caData: "x" } }).success).toBe(false);
    expect(ClusterPlaneV0.safeParse({ ...validPlane, kube: { server: "https://100.64.0.11:16443", caData: "" } }).success).toBe(false);
  });

  it("rejects a non-URL vault.addr and a non-positive slaveId", () => {
    expect(ClusterPlaneV0.safeParse({ ...validPlane, vault: { ...validPlane.vault, addr: "not a url" } }).success).toBe(false);
    expect(ClusterPlaneV0.safeParse({ ...validPlane, slaveId: 0 }).success).toBe(false);
  });
});

describe("readClusterPlane", () => {
  it("narrows a stored v0 document and hands the parsed plane over", () => {
    const read = readClusterPlane(JSON.parse(JSON.stringify(validPlane)));
    expect(read).toEqual({ kind: "v0", plane: validPlane });
  });

  it("an empty column is 'none' — the master's own cluster row, or a slave before deploy-slave", () => {
    expect(readClusterPlane(null)).toEqual({ kind: "none" });
    expect(readClusterPlane(undefined)).toEqual({ kind: "none" });
  });

  it("a version this build does not know is NAMED, not parsed as v0", () => {
    // The whole point of narrowing first: a v1 body would fail the v0 schema on fields that are
    // perfectly valid for its own version, and "unreadable" would report a newer write as damage.
    expect(readClusterPlane({ ...validPlane, v: 1 })).toEqual({ kind: "unsupported", v: 1 });
  });

  it("create-mgmt's partial stash reads as unreadable BY ITS MISSING VERSION, not by its body", () => {
    // deploy-slave's create-mgmt writes {kube} onto the column before register writes the document,
    // so this shape is a normal state of a slave mid-deploy. It carries no `v` at all.
    const read = readClusterPlane({ kube: validPlane.kube });
    expect(read).toEqual({ kind: "unreadable", reason: "no version field" });
  });

  it("a v0 document that fails the body schema names the fields that failed", () => {
    const { credentialIds: _drop, ...rest } = validPlane;
    const read = readClusterPlane(rest);
    expect(read.kind).toBe("unreadable");
    expect(read.kind === "unreadable" && read.reason).toContain("credentialIds");
  });
});
