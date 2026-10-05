import { describe, it, expect } from "vitest";
import { gateT5Fit } from "./tenant-fit.ts";
import { UNIT_SIZE_SEED } from "#unit/shared/unit-size.ts";
import type { MemberDocs } from "./tenant-gates.ts";

const XS = UNIT_SIZE_SEED.member.xsmall;

interface Shape { requests?: Record<string, string>; limits?: Record<string, string> }
const container = (name: string, s: Shape) => ({ name, resources: { ...(s.requests ? { requests: s.requests } : {}), ...(s.limits ? { limits: s.limits } : {}) } });
const workload = (kind: string, name: string, spec: Record<string, unknown>, containers: unknown[], initContainers: unknown[] = []) =>
  ({ apiVersion: "apps/v1", kind, name, namespace: "ns", raw: { kind, metadata: { name }, spec: { ...spec, template: { spec: { containers, initContainers } } } } });
const member = (docs: MemberDocs["docs"]): MemberDocs => ({ member: "website", namespace: "ns", guid: "g", docs });

// The website member as digita renders it today: an engine and a web, one replica each, fixed shapes
// that add up to 2 CPU and 1.5Gi at the limit.
const today = member([
  workload("Deployment", "digita-engine", { replicas: 1 }, [container("engine", { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "1Gi" } })], [container("app-fetch", {})]),
  workload("Deployment", "digita-web", { replicas: 1 }, [container("web", { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } })]),
]);
// The same member at shapes chosen for XS: twice its pods fit 100m/576Mi requested and 2/2Gi at the limit.
// Its init container declares its shape too: at the LimitRange default its 50m request alone, twice,
// would be the whole XS request.
const atXs = member([
  workload("Deployment", "digita-engine", { replicas: 1 }, [container("engine", { requests: { cpu: "25m", memory: "160Mi" }, limits: { cpu: "500m", memory: "640Mi" } })], [container("app-fetch", { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "100m", memory: "128Mi" } })]),
  workload("Deployment", "digita-web", { replicas: 1 }, [container("web", { requests: { cpu: "25m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } })]),
]);

describe("T5 size fit (hard)", () => {
  it("REFUSES today's website shapes at XS: two rollouts' worth is 4 CPU and 3Gi at the limit, the quota 2 and 2Gi", () => {
    const g = gateT5Fit([today], XS);
    expect(g.status).toBe("fail");
    expect(g.severity).toBe("hard");
    expect(g.reason).toContain(`member "website" needs requests 400m/768Mi, limits 4/3Gi, 4 pod(s)`);
    expect(g.reason).toContain("limits cpu, limits memory");
    expect(g.reason).toContain("requests 110m/640Mi, limits 2100m/2112Mi, 9 pod(s)");
  });

  it("REFUSES the XS shapes while the init container declares nothing, naming the workload and the container", () => {
    const undeclaredInit = member(atXs.docs.map((d) => (d.name === "digita-engine" ? workload("Deployment", "digita-engine", { replicas: 1 }, [container("engine", { requests: { cpu: "25m", memory: "160Mi" }, limits: { cpu: "500m", memory: "640Mi" } })], [container("app-fetch", {})]) : d)));
    const g = gateT5Fit([undeclaredInit], XS);
    expect(g.status).toBe("fail");
    expect(g.reason).toContain(`member "website": Deployment digita-engine init container app-fetch declares no requestsCpu, requestsMemory, limitsCpu, limitsMemory`);
    expect(g.reason).not.toContain("needs requests");
  });

  it("passes the same member at its XS shapes", () => {
    const g = gateT5Fit([atXs], XS);
    expect(g.status).toBe("pass");
    expect(g.found).toContain("website: requests 100m/576Mi, limits 2/1792Mi, 4 pod(s)");
  });

  it("REFUSES a member that fits twice but leaves no room for cert-manager's solver pod", () => {
    // The XS row before the solver's room: the member alone fits it exactly.
    const g = gateT5Fit([atXs], { requestsCpu: "100m", requestsMemory: "576Mi", limitsCpu: "2", limitsMemory: "2Gi", pods: 8, persistentVolumeClaims: 1 });
    expect(g.status).toBe("fail");
    expect(g.reason).toContain("and one cert-manager solver pod (requests 10m/64Mi, limits 100m/64Mi, 1 pod(s)), above the quota in requests cpu, requests memory");
  });

  it("REFUSES a main container that declares no requests, naming it", () => {
    const bare = member([workload("Deployment", "digita-web", { replicas: 1 }, [container("web", { limits: { cpu: "100m", memory: "128Mi" } })])]);
    const g = gateT5Fit([bare], XS);
    expect(g.status).toBe("fail");
    expect(g.reason).toContain(`member "website": Deployment digita-web container web declares no requestsCpu, requestsMemory`);
  });

  it("REFUSES an undeclared init container at any size, as it refuses a main one: the LimitRange default is no size anyone chose", () => {
    const g = gateT5Fit([today], UNIT_SIZE_SEED.member.xxlarge);
    expect(g.status).toBe("fail");
    expect(g.reason).toContain(`member "website": Deployment digita-engine init container app-fetch declares no requestsCpu, requestsMemory, limitsCpu, limitsMemory`);
    expect(g.found).not.toContain("LimitRange default");
  });

  it("REFUSES an init container that declares only part of its shape, naming what it leaves out", () => {
    const partial = member([workload("Deployment", "digita-web", { replicas: 1 }, [container("web", { requests: { cpu: "25m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } })], [container("translations-fetch", { requests: { cpu: "10m", memory: "32Mi" } })])]);
    expect(gateT5Fit([partial], XS).reason).toContain("Deployment digita-web init container translations-fetch declares no limitsCpu, limitsMemory");
  });

  it("takes the larger of the main containers' sum and the largest init container, per figure", () => {
    const heavyInit = member([workload("Deployment", "d", { replicas: 1, strategy: { type: "Recreate" } }, [container("c", { requests: { cpu: "10m", memory: "10Mi" }, limits: { cpu: "100m", memory: "100Mi" } })], [container("i", { requests: { cpu: "50m", memory: "5Mi" }, limits: { cpu: "50m", memory: "500Mi" } })])]);
    expect(gateT5Fit([heavyInit], XS).found).toContain("website: requests 50m/10Mi, limits 100m/500Mi, 1 pod(s)");
  });

  it("surges a Deployment by maxSurge (25% by default, rounded up), a Recreate one and a StatefulSet by none", () => {
    const shape = [container("c", { requests: { cpu: "10m", memory: "1Mi" }, limits: { cpu: "10m", memory: "1Mi" } })];
    const pods = (kind: string, spec: Record<string, unknown>) => gateT5Fit([member([workload(kind, "w", spec, shape)])], UNIT_SIZE_SEED.member.xxlarge).found.match(/(\d+) pod\(s\)/)?.[1];
    expect(pods("Deployment", { replicas: 4 })).toBe("5");
    expect(pods("Deployment", { replicas: 1 })).toBe("2");
    expect(pods("Deployment", { replicas: 2, strategy: { rollingUpdate: { maxSurge: 0 } } })).toBe("2");
    expect(pods("Deployment", { replicas: 3, strategy: { type: "Recreate" } })).toBe("3");
    expect(pods("StatefulSet", { replicas: 3 })).toBe("3");
  });

  it("REFUSES a member whose pods outnumber the quota's pod count", () => {
    const shape = [container("c", { requests: { cpu: "1m", memory: "1Mi" }, limits: { cpu: "1m", memory: "1Mi" } })];
    const g = gateT5Fit([member([workload("StatefulSet", "s", { replicas: 9 }, shape)])], XS);
    expect(g.status).toBe("fail");
    expect(g.reason).toContain("above the quota in pods");
  });
});
