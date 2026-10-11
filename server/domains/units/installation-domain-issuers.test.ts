import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { DbHandle } from "../../db/client.ts";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import { makeInstallationDomainDef, makeInstallationDomainRollbackDef } from "../runs/defs/installation-domain.ts";
import { tenantMemberUrl } from "#unit/shared/unit-host.ts";
import {
  FROM, TO, OLD_HOST, GUID, SENDER_DOMAIN,
  makeIssuerTestHarness,
} from "./installation-domain.fixture.ts";

describe("installation domain issuer rebind", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    while (handles.length > 0) handles.pop()!.sqlite.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("a move of a tenant stage with a sender domain: the new issuer is added BEFORE the registrations change, the old one removed only after the members render the new zone; post's list ends as [issuerAfter]", async () => {
    const h = await makeIssuerTestHarness({}, handles, dirs);
    const def = makeInstallationDomainDef(h.actions);
    const planResult = await def.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planResult.outcome !== "planned") throw new Error("expected planned");
    const snapshot = planResult.params.snapshot!;
    const tenant = snapshot.tenants[0]!;
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerBefore]);

    const stepCtx = (name: string): StepCtx => h.makeCtx("run_move", name).ctx;
    const steps = def.steps(planResult.params);

    await steps.find((s) => s.name === "attest-target")!.run(stepCtx("attest-target"));
    await steps.find((s) => s.name === "bind-new-issuers")!.run(stepCtx("bind-new-issuers"));
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerBefore, tenant.issuerAfter]);
    expect(h.cloud.commits.filter((c) => c.message?.includes("move unit apex"))).toHaveLength(0);

    await steps.find((s) => s.name === "move-unit-domains")!.run(stepCtx("move-unit-domains"));
    expect(h.cloud.commits.filter((c) => c.message?.includes("move unit apex"))).toHaveLength(1);

    h.setRenderedZone(tenant.zoneAfter!, tenant.ownDomainAfter);
    await steps.find((s) => s.name === "watch-tenant-zones")!.run(stepCtx("watch-tenant-zones"));
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerBefore, tenant.issuerAfter]);

    const unbind = h.makeCtx("run_move", "unbind-previous-issuers");
    await steps.find((s) => s.name === "unbind-previous-issuers")!.run(unbind.ctx);
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerAfter]);

    // Each call goes to the post host of the apex that serves at that moment: the bind before the move
    // through the old apex, the unbind after it through the new one, where the old host only redirects.
    expect(h.post.calls.map((c) => `${c.method} ${new URL(c.url).host}`)).toEqual([`PUT post.${FROM}`, `DELETE post.${TO}`]);

    // The unbind arms the rebind; an abort runs it before the move's restore, through the new apex.
    expect(unbind.cleanups.map((c) => c.name)).toEqual([`installation-issuer-rebind:${GUID}:prod`]);
    await unbind.cleanups[0]!.run(h.makeCtx("run_move", "installation-issuer-rebind").ctx);
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerAfter, tenant.issuerBefore]);
    expect(h.post.calls.at(-1)).toMatchObject({ method: "PUT" });
    expect(new URL(h.post.calls.at(-1)!.url).host).toBe(`post.${TO}`);
  });

  it("the members never render the new zone: watch-tenant-zones fails naming the tenant; the old issuer is still bound; Abort (cleanup) takes back the new issuer (the installation-issuer-unbind:… compensation) and the existing restore runs", async () => {
    const h = await makeIssuerTestHarness({}, handles, dirs);
    const def = makeInstallationDomainDef(h.actions);
    const planResult = await def.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planResult.outcome !== "planned") throw new Error("expected planned");
    const snapshot = planResult.params.snapshot!;
    const tenant = snapshot.tenants[0]!;

    const runCleanups: Cleanup[] = [];
    const bindCtx = h.makeCtx("run_move", "bind-new-issuers");
    const moveCtx = h.makeCtx("run_move", "move-unit-domains");

    await def.steps(planResult.params).find((s) => s.name === "bind-new-issuers")!.run(bindCtx.ctx);
    runCleanups.push(...bindCtx.cleanups);
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerBefore, tenant.issuerAfter]);

    await def.steps(planResult.params).find((s) => s.name === "move-unit-domains")!.run(moveCtx.ctx);
    runCleanups.push(...moveCtx.cleanups);

    h.setRenderedZone("unrendered-zone.example");
    const watchStep = def.steps(planResult.params).find((s) => s.name === "watch-tenant-zones")!;
    await expect(watchStep.run(h.makeCtx("run_move", "watch-tenant-zones").ctx)).rejects.toThrow(new RegExp(`tenant ${GUID}`));
    expect(h.lists[SENDER_DOMAIN]).toContain(tenant.issuerBefore);

    for (const c of [...runCleanups].reverse()) {
      await c.run(h.makeCtx("run_move", c.name).ctx);
    }

    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerBefore]);
    expect(h.dns.record(`post.${TO}`, "CNAME")).toBeUndefined();
    expect(h.dns.record(`post.${FROM}`, "CNAME")).toBe(OLD_HOST);
  });

  it("a new issuer post lists already arms no compensation, so an abort leaves it bound", async () => {
    const before = tenantMemberUrl("/auth", "prod", "shop", FROM, "");
    const after = tenantMemberUrl("/auth", "prod", "shop", TO, "");
    const h = await makeIssuerTestHarness({ lists: { [SENDER_DOMAIN]: [before, after] } }, handles, dirs);
    const def = makeInstallationDomainDef(h.actions);
    const planned = await def.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planned.outcome !== "planned") throw new Error("expected planned");
    const bind = h.makeCtx("run_move", "bind-new-issuers");
    await def.steps(planned.params).find((s) => s.name === "bind-new-issuers")!.run(bind.ctx);
    expect(bind.cleanups).toEqual([]);
    expect(h.lists[SENDER_DOMAIN]).toEqual([before, after]);
  });

  it("a tenant without a sender domain: no call to post at all", async () => {
    const h = await makeIssuerTestHarness({ senderDomain: "" }, handles, dirs);
    const def = makeInstallationDomainDef(h.actions);
    const planResult = await def.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planResult.outcome !== "planned") throw new Error("expected planned");
    const snapshot = planResult.params.snapshot!;
    const tenant = snapshot.tenants[0]!;
    h.setRenderedZone(tenant.zoneAfter!, tenant.ownDomainAfter);

    for (const step of def.steps(planResult.params)) {
      await step.run(h.makeCtx("run_move", step.name).ctx);
    }
    expect(h.post.calls).toHaveLength(0);
  });

  it("the product declares no senderDomainIssuers: no call, no blocker", async () => {
    const h = await makeIssuerTestHarness({ hasIssuersRoute: false }, handles, dirs);
    const snapshot = await h.actions.read(h.db.db, FROM, TO);
    expect(snapshot.blockers).toEqual([]);

    const def = makeInstallationDomainDef(h.actions);
    const planResult = await def.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planResult.outcome !== "planned") throw new Error("expected planned");
    const tenant = planResult.params.snapshot!.tenants[0]!;
    h.setRenderedZone(tenant.zoneAfter!, tenant.ownDomainAfter);

    for (const step of def.steps(planResult.params)) {
      await step.run(h.makeCtx("run_move", step.name).ctx);
    }
    expect(h.post.calls).toHaveLength(0);
  });

  it("a stage with a sender domain whose key is not kept: the plan carries the blocker", async () => {
    const h = await makeIssuerTestHarness({ keepKey: false }, handles, dirs);
    const snapshot = await h.actions.read(h.db.db, FROM, TO);
    const blocker = snapshot.blockers.find((b) => b.includes(GUID));
    expect(blocker).toBeDefined();
    expect(blocker).toContain(`tenant ${GUID}/prod: the Manager keeps no key for post (prod)`);
    expect(blocker).toContain("mint the key its manifest declares as generate: manager-key");

    const def = makeInstallationDomainDef(h.actions);
    await expect(def.assertApprovable!({ fromDomain: FROM, toDomain: TO, dryRun: false, snapshot }, {} as never)).rejects.toThrow(/cutover blockers/);
  });

  it("the rollback: binds issuerBefore first, restores, watches the old zone, removes issuerAfter; post's list ends as [issuerBefore]", async () => {
    const h = await makeIssuerTestHarness({}, handles, dirs);
    const moveDef = makeInstallationDomainDef(h.actions);
    const movePlan = await moveDef.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (movePlan.outcome !== "planned") throw new Error("expected planned");
    const snapshot = movePlan.params.snapshot!;
    const tenant = snapshot.tenants[0]!;

    h.setRenderedZone(tenant.zoneAfter!, tenant.ownDomainAfter);
    for (const step of moveDef.steps(movePlan.params)) {
      await step.run(h.makeCtx("run_source", step.name).ctx);
    }
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerAfter]);

    h.db.sqlite.prepare(
      "INSERT INTO runs(id,kind,target_kind,target_id,params_json,plan_json,status,owner,modified_by) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("run_source", "installation-domain-move", "installation", h.cloud.booksBranch, JSON.stringify(movePlan.params), JSON.stringify(movePlan.plan), "failed", "op_system", "op_system");

    const rollbackDef = makeInstallationDomainRollbackDef(h.actions);
    const rollbackPlan = await rollbackDef.planStream!({ sourceRunId: "run_source", dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (rollbackPlan.outcome !== "planned") throw new Error("expected planned");

    const rollbackSteps = rollbackDef.steps(rollbackPlan.params);
    const stepCtx = (name: string): StepCtx => h.makeCtx("run_rollback", name).ctx;

    await rollbackSteps.find((s) => s.name === "attest-target")!.run(stepCtx("attest-target"));
    await rollbackSteps.find((s) => s.name === "bind-previous-issuers")!.run(stepCtx("bind-previous-issuers"));
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerAfter, tenant.issuerBefore]);

    await rollbackSteps.find((s) => s.name === "move-unit-domains")!.run(stepCtx("move-unit-domains"));
    h.setRenderedZone(tenant.zoneBefore!, tenant.ownDomainBefore);

    await rollbackSteps.find((s) => s.name === "watch-tenant-zones")!.run(stepCtx("watch-tenant-zones"));
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerAfter, tenant.issuerBefore]);

    await rollbackSteps.find((s) => s.name === "unbind-new-issuers")!.run(stepCtx("unbind-new-issuers"));
    expect(h.lists[SENDER_DOMAIN]).toEqual([tenant.issuerBefore]);
  });

  it("a snapshot without the new fields: the issuer steps log the no-op line and call nothing", async () => {
    const h = await makeIssuerTestHarness({}, handles, dirs);
    const forwardDef = makeInstallationDomainDef(h.actions);
    const planResult = await forwardDef.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planResult.outcome !== "planned") throw new Error("expected planned");
    const rawSnapshot = structuredClone(planResult.params.snapshot!);
    for (const t of rawSnapshot.tenants) {
      delete t.senderDomain;
      delete t.zoneBefore;
      delete t.zoneAfter;
    }

    const initialCalls = h.post.calls.length;
    const bindCtx = h.makeCtx("run_legacy", "bind-new-issuers");
    await forwardDef.steps({ ...planResult.params, snapshot: rawSnapshot }).find((s) => s.name === "bind-new-issuers")!.run(bindCtx.ctx);
    expect(bindCtx.logs.some((l) => l.text.includes("this plan was frozen before issuers were rebound — nothing to rebind"))).toBe(true);

    const watchCtx = h.makeCtx("run_legacy", "watch-tenant-zones");
    await forwardDef.steps({ ...planResult.params, snapshot: rawSnapshot }).find((s) => s.name === "watch-tenant-zones")!.run(watchCtx.ctx);
    expect(watchCtx.logs.some((l) => l.text.includes("this plan was frozen before issuers were rebound — nothing to rebind"))).toBe(true);

    const unbindCtx = h.makeCtx("run_legacy", "unbind-previous-issuers");
    await forwardDef.steps({ ...planResult.params, snapshot: rawSnapshot }).find((s) => s.name === "unbind-previous-issuers")!.run(unbindCtx.ctx);
    expect(unbindCtx.logs.some((l) => l.text.includes("this plan was frozen before issuers were rebound — nothing to rebind"))).toBe(true);

    expect(h.post.calls.length).toBe(initialCalls);
  });

  it("every name a step can register resolves in cleanups(params)", async () => {
    const h = await makeIssuerTestHarness({}, handles, dirs);
    const forwardDef = makeInstallationDomainDef(h.actions);
    const planResult = await forwardDef.planStream!({ fromDomain: FROM, toDomain: TO, dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (planResult.outcome !== "planned") throw new Error("expected planned");

    const forwardCleanups = forwardDef.cleanups!(planResult.params);
    const forwardCleanupNames = forwardCleanups.map((c) => c.name);
    expect(forwardCleanupNames).toContain("restore-unit-domains");
    expect(forwardCleanupNames).toContain(`installation-issuer-unbind:${GUID}:prod`);
    expect(forwardCleanupNames).toContain(`installation-issuer-rebind:${GUID}:prod`);

    const bindCtx = h.makeCtx("run_fwd", "bind-new-issuers");
    await forwardDef.steps(planResult.params).find((s) => s.name === "bind-new-issuers")!.run(bindCtx.ctx);
    for (const c of bindCtx.cleanups) {
      expect(forwardCleanupNames).toContain(c.name);
    }

    const unbindCtx = h.makeCtx("run_fwd", "unbind-previous-issuers");
    await forwardDef.steps(planResult.params).find((s) => s.name === "unbind-previous-issuers")!.run(unbindCtx.ctx);
    for (const c of unbindCtx.cleanups) {
      expect(forwardCleanupNames).toContain(c.name);
    }

    h.db.sqlite.prepare(
      "INSERT INTO runs(id,kind,target_kind,target_id,params_json,plan_json,status,owner,modified_by) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("run_source", "installation-domain-move", "installation", h.cloud.booksBranch, JSON.stringify(planResult.params), JSON.stringify(planResult.plan), "failed", "op_system", "op_system");

    const rollbackDef = makeInstallationDomainRollbackDef(h.actions);
    const rollbackPlan = await rollbackDef.planStream!({ sourceRunId: "run_source", dryRun: false }, { db: h.db.db, log: () => undefined, signal: new AbortController().signal });
    if (rollbackPlan.outcome !== "planned") throw new Error("expected planned");

    // A rollback arms no issuer compensation: its own restore arms none, and the issuer it binds is the one it returns to.
    expect(rollbackDef.cleanups).toBeUndefined();
    const rollbackBindCtx = h.makeCtx("run_rb", "bind-previous-issuers");
    await rollbackDef.steps(rollbackPlan.params).find((s) => s.name === "bind-previous-issuers")!.run(rollbackBindCtx.ctx);
    expect(rollbackBindCtx.cleanups).toEqual([]);
  });
});
