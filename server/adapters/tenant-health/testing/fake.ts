// The in-memory tenant-health reader, so a check is tested without a tenant.
//
// Scripted by URL, because that is what the step composes per tenant and therefore the one thing a
// test can assert it got right. An unlisted URL answers "unreachable", which is the honest default:
// a tenant nobody scripted is a tenant that did not answer.
import type { TenantHealth, TenantHealthReader, TenantHealthRequest } from "../port.ts";

export class FakeTenantHealthReader implements TenantHealthReader {
  constructor(
    /** What each URL answers. An absent entry answers unreachable. */
    private readonly answers: Readonly<Record<string, TenantHealth>> = {},
  ) {}

  /** Every call made, in order — so a test can assert WHICH tenants were asked, and that the token
   *  travelled as a header rather than in the URL. */
  readonly calls: TenantHealthRequest[] = [];

  async read(input: TenantHealthRequest): Promise<TenantHealth> {
    this.calls.push(input);
    return this.answers[input.url] ?? { reached: false, because: "nothing answered" };
  }
}
