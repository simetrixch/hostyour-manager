import { describe, it, expect } from "vitest";
import { RUN_KIND, RUN_FAMILY, RUN_STATUS, SERVER_ROLE, MASTER_ROLES, isMasterRole, LOCK_RESOURCE, PLANE_STATE, SERVER_TAILNET_STATE, APP_PROVENANCE } from "./enums.ts";

describe("enums (single source of truth)", () => {
  it("RUN_KIND keeps the permanent resume-proof noop fixture", () => {
    expect(RUN_KIND).toContain("noop");
  });

  it("RUN_KIND names the three distinguishable cluster verbs beside deploy-slave", () => {
    // adopt takes a bare machine into service, deploy-slave turns an adopted server into a live slave,
    // redeploy rebuilds a live cluster's machine layer, release raises the platform version it stands
    // on. Four separate literals, because each answers a different question — a boolean on another
    // verb hides that, and hiding it is how "redeploy" once lived inside deploy-slave's params.
    for (const kind of ["adopt", "deploy-slave", "redeploy", "release"] as const) expect(RUN_KIND).toContain(kind);
  });

  it("RUN_KIND names the three tailnet repair verbs, and the cluster family owns all three", () => {
    // Three acts, not one with a switch: a disconnect leaves the private network, a reconnect
    // re-establishes with the credential the host still holds, and a rejoin is for a host that
    // holds none — only the coordinator can mint one, so that verb needs the master too. A family
    // is registered whole or not at all (selfchecks registry.total), so all three belong to one.
    for (const kind of ["tailnet-disconnect", "tailnet-reconnect", "tailnet-rejoin"] as const) {
      expect(RUN_KIND).toContain(kind);
      expect(RUN_FAMILY.cluster as readonly string[]).toContain(kind);
    }
  });

  it("RUN_STATUS includes planning for async validation", () => {
    expect(RUN_STATUS).toContain("planning");
  });

  it("SERVER_ROLE is exactly master|slave|master+slave", () => {
    expect([...SERVER_ROLE]).toEqual(["master", "slave", "master+slave"]);
  });

  it("MASTER_ROLES / isMasterRole cover both members carrying the master part", () => {
    expect([...MASTER_ROLES]).toEqual(["master", "master+slave"]);
    expect(isMasterRole("master")).toBe(true);
    expect(isMasterRole("master+slave")).toBe(true);
    expect(isMasterRole("slave")).toBe(false);
  });

  it("LOCK_RESOURCE carries the two global locks", () => {
    expect(LOCK_RESOURCE).toContain("controller");
    expect(LOCK_RESOURCE).toContain("all");
  });

  it("PLANE_STATE is the four states a step actually writes", () => {
    // Was five. "removing" was declared and never written by anything, so every reader that
    // handled it handled a state the platform could not reach.
    expect([...PLANE_STATE]).toEqual(["absent", "creating", "verifying", "ready"]);
  });

  it("APP_PROVENANCE is the two words a writer actually writes, and both unit kinds share them", () => {
    // Was three. "imported" was the consumer onboard's name for the act the tenant writer already
    // called "controller", so the one fact had two words and a query for either answered about one
    // unit kind only. Both record-inventory steps now write this list's first member; the second is
    // the adopt-consumer row, which states the opposite (never gate-validated).
    expect([...APP_PROVENANCE]).toEqual(["controller", "adopted"]);
  });

  it("SERVER_TAILNET_STATE is the five readings, one of which is the never-measured default", () => {
    // "client-unreadable" earns its place by being written: a client that will not answer is a
    // different measurement from one that answered "I am on no network", and the run can tell them
    // apart (server/domains/runs/tailnet-probe.ts).
    expect([...SERVER_TAILNET_STATE]).toEqual(["unknown", "no-client", "client-unreadable", "not-joined", "joined"]);
  });
});
