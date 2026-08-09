// In-memory Activator fake for the onboarding domain tests — no network. Records every call so a
// test can assert the onboard `activate` step sent the declared method/url/header/token/body, and
// scripts the response the step surfaces (or a non-2xx it must fail loud on).
import type { Activator, ActivationRequest, ActivationResponse } from "../port.ts";

export class FakeActivator implements Activator {
  /** Every call, in order — including the token + body, so a test can assert the token flowed and
   *  the operator fields were passed (and separately that neither reached the pointer/DB/params). */
  readonly calls: ActivationRequest[] = [];

  constructor(
    private scripted: { response?: ActivationResponse; throwOn?: Error } = {},
  ) {}

  /** Script the response the next call returns (default: 201 with an activate_url). */
  setResponse(response: ActivationResponse): void {
    this.scripted = { ...this.scripted, response };
  }

  async invoke(input: ActivationRequest): Promise<ActivationResponse> {
    this.calls.push(input);
    if (this.scripted.throwOn) throw this.scripted.throwOn; // model a DNS/TLS/timeout transport error
    return (
      this.scripted.response ?? {
        status: 201,
        ok: true,
        json: { ok: true, activate_url: "https://example-auth.s1.example/activate?token=inv_test" },
        bodyText: '{"ok":true,"activate_url":"https://example-auth.s1.example/activate?token=inv_test"}',
      }
    );
  }
}
