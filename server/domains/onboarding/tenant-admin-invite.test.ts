import { describe, it, expect } from "vitest";
import type { Activator, ActivationRequest, ActivationResponse } from "../../adapters/activation/port.ts";
import { inviteOrResendTenantAdmin } from "./tenant-admin-invite.ts";

// A two-endpoint Activator fake: the real orchestration calls invite-admin then (on 409) resend-admin-
// invite, so the fake scripts a DISTINCT response per URL suffix and records every call — letting the
// tests assert the token rode the header and the resend was body-less.
class TwoEndpointActivator implements Activator {
  readonly calls: ActivationRequest[] = [];
  constructor(private readonly byPath: { invite: ActivationResponse; resend?: ActivationResponse }) {}
  async invoke(input: ActivationRequest): Promise<ActivationResponse> {
    this.calls.push(input);
    if (input.url.endsWith("/resend-admin-invite")) {
      if (!this.byPath.resend) throw new Error("test: resend was called but not scripted");
      return this.byPath.resend;
    }
    return this.byPath.invite;
  }
}

const created = (json: unknown): ActivationResponse => ({ status: 201, ok: true, json, bodyText: JSON.stringify(json) });
const ok = (json: unknown): ActivationResponse => ({ status: 200, ok: true, json, bodyText: JSON.stringify(json) });
const conflict = (error: string): ActivationResponse => ({ status: 409, ok: false, json: { error }, bodyText: JSON.stringify({ error }) });
const notFound = (): ActivationResponse => ({ status: 404, ok: false, json: { error: "not_found" }, bodyText: '{"error":"not_found"}' });

const INVITE_SUFFIX = "/api/v1/bootstrap/invite-admin";
const RESEND_SUFFIX = "/api/v1/bootstrap/resend-admin-invite";
const args = (activator: Activator) => ({ activator, token: "tok", authFqdn: "auth.acme.s1.example", email: "admin@acme.test" });

describe("inviteOrResendTenantAdmin", () => {
  it("A0 (no admin): invite-admin 201 → invited, with the activate_url + mail; only invite is called", async () => {
    const a = new TwoEndpointActivator({
      invite: created({ ok: true, activate_url: "https://auth.acme.s1.example/activate?token=inv1", mail: { status: "sent", transport: "example-post" } }),
    });
    const r = await inviteOrResendTenantAdmin(args(a));
    expect(r.outcome).toBe("invited");
    expect(r.activateUrl).toBe("https://auth.acme.s1.example/activate?token=inv1");
    expect(r.mail).toEqual({ status: "sent", transport: "example-post" });
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]?.url.endsWith(INVITE_SUFFIX)).toBe(true);
    expect(a.calls[0]?.tokenHeader).toBe("X-Bootstrap-Token");
    expect(a.calls[0]?.token).toBe("tok");
    expect(a.calls[0]?.body).toEqual({ email: "admin@acme.test" });
  });

  it("A1 (pending admin): invite 409 → resend 200 → resent; the resend is body-less but token-gated", async () => {
    const a = new TwoEndpointActivator({
      invite: conflict("admin_exists"),
      resend: ok({ ok: true, activate_url: "https://auth.acme.s1.example/activate?token=re1", mail: { status: "failed", transport: "example-post", detail: "boom" } }),
    });
    const r = await inviteOrResendTenantAdmin(args(a));
    expect(r.outcome).toBe("resent");
    expect(r.activateUrl).toBe("https://auth.acme.s1.example/activate?token=re1");
    expect(r.mail).toEqual({ status: "failed", transport: "example-post", detail: "boom" });
    expect(a.calls).toHaveLength(2);
    expect(a.calls[1]?.url.endsWith(RESEND_SUFFIX)).toBe(true);
    expect(a.calls[1]?.body).toEqual({});
    expect(a.calls[1]?.token).toBe("tok");
    expect(a.calls[1]?.tokenHeader).toBe("X-Bootstrap-Token");
  });

  it("A2 (activated admin): invite 409 → resend 409 admin_active → already-activated, no link", async () => {
    const a = new TwoEndpointActivator({ invite: conflict("admin_exists"), resend: conflict("admin_active") });
    const r = await inviteOrResendTenantAdmin(args(a));
    expect(r.outcome).toBe("already-activated");
    expect(r.activateUrl).toBeNull();
    expect(r.mail).toBeNull();
  });

  it("race: invite 409 but resend 409 no_admin (admin vanished) → throws inconsistent-state", async () => {
    const a = new TwoEndpointActivator({ invite: conflict("admin_exists"), resend: conflict("no_admin") });
    await expect(inviteOrResendTenantAdmin(args(a))).rejects.toThrow(/inconsistent state/);
  });

  it("invite 404 (token drift / endpoint disabled) → throws loud with the status, never calls resend", async () => {
    const a = new TwoEndpointActivator({ invite: notFound() });
    await expect(inviteOrResendTenantAdmin(args(a))).rejects.toThrow(/HTTP 404/);
    expect(a.calls).toHaveLength(1);
  });

  it("resend 404 (token drift) → throws loud with the status", async () => {
    const a = new TwoEndpointActivator({ invite: conflict("admin_exists"), resend: notFound() });
    await expect(inviteOrResendTenantAdmin(args(a))).rejects.toThrow(/HTTP 404/);
  });

  it("a 5xx invite throws with the status (no credential — a non-2xx body is an { error } shape)", async () => {
    const a = new TwoEndpointActivator({ invite: { status: 502, ok: false, json: { error: "bad_gateway" }, bodyText: '{"error":"bad_gateway"}' } });
    await expect(inviteOrResendTenantAdmin(args(a))).rejects.toThrow(/HTTP 502/);
  });
});
