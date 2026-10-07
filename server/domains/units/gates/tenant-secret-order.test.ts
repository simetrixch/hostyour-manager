import { describe, it, expect } from "vitest";
import { gateT6SecretOrder } from "./tenant-secret-order.ts";
import type { MemberDocs } from "./tenant-gates.ts";

type Doc = MemberDocs["docs"][number];
const wave = (n: number | undefined) => (n === undefined ? {} : { annotations: { "argocd.argoproj.io/sync-wave": String(n) } });
const claim = (name: string, service: string, w?: number): Doc =>
  ({ apiVersion: "platform.hostyour.cloud/v1", kind: "ServiceClaim", name, namespace: "ns", raw: { kind: "ServiceClaim", metadata: { name, ...wave(w) }, spec: { service } } });
const deployment = (name: string, secret: string, w?: number): Doc =>
  ({ apiVersion: "apps/v1", kind: "Deployment", name, namespace: "ns", raw: { kind: "Deployment", metadata: { name, ...wave(w) }, spec: { template: { spec: { containers: [{ name, envFrom: [{ secretRef: { name: secret } }] }] } } } } });
const member = (name: string, docs: Doc[]): MemberDocs => ({ member: name, namespace: `ns-${name}`, guid: "g", docs });

describe("T6 — the secret sync order of every member", () => {
  it("PLANTED: a member chart with a claim beside its Deployment is refused, naming the member, the workload, the writer and the wave", () => {
    const r = gateT6SecretOrder([member("auth", [claim("digita-auth", "mongodb", 0)]), member("engine", [claim("digita-engine", "mongodb"), deployment("digita-engine", "digita-engine-mongodb")])]);
    expect(r).toMatchObject({ id: "T6", title: "secret sync ordering", severity: "hard", status: "fail" });
    expect(r.found).toBe('member "engine": Deployment/digita-engine (wave 0) uses Secret "digita-engine-mongodb" of ServiceClaim/digita-engine (wave 0).');
    expect(r.reason).toContain("before the service-provisioner has written");
    expect(r.evidence).toEqual([{ source: "rendered", kind: "Deployment", name: "digita-engine", fieldPath: "containers[0].envFrom[0].secretRef.name", value: "digita-engine-mongodb" }]);
  });

  it("PLANTED innocent: the same chart with the claim a wave earlier passes", () => {
    const r = gateT6SecretOrder([member("engine", [claim("digita-engine", "mongodb", -1), deployment("digita-engine", "digita-engine-mongodb")])]);
    expect(r.status).toBe("pass");
    expect(r.found).toBe("1 written Secret(s) across 1 member(s); 1 use(s) by workloads, each in a later wave than the object that writes it.");
  });

  it("reads each member on its own: a claim in one member orders nothing in another, which is its own Application", () => {
    const r = gateT6SecretOrder([member("auth", [claim("shared", "redis", -1)]), member("jobs", [deployment("jobs", "shared-redis")])]);
    expect(r.status).toBe("pass");
    expect(r.found).toContain("1 written Secret(s) across 2 member(s); 0 use(s)");
  });

  it("passes members that render no claim and says there was nothing to order", () => {
    const r = gateT6SecretOrder([member("website", [deployment("web", "own-secret")])]);
    expect(r.status).toBe("pass");
    expect(r.found).toContain("no member renders a ServiceClaim or an ExternalSecret");
  });
});
