import { describe, it, expect } from "vitest";
import type { DnsInventoryView, DnsRecordRow } from "#core/shared/dns.ts";
import { heldRecords } from "./held-records.ts";

// What the book's table may offer for removal: every row but the ones the inventory lists read-only.

const row = (over: Partial<DnsRecordRow>): DnsRecordRow => ({
  owner: { kind: "mail", name: "example.com" }, name: "example.com", type: "TXT", expected: "", found: null, verdict: "standing", removable: true, ...over,
});
const view = (rows: DnsRecordRow[]): DnsInventoryView => ({ rows, skipped: [], readAt: new Date().toISOString() });

describe("heldRecords", () => {
  it("PLANTED DEFECT: names the platform domain's apex SPF, kept by its own mail service, so the book cannot offer it", () => {
    const held = heldRecords(view([row({ owner: { kind: "mail-service", name: "example.com" }, removable: false }), row({ name: "mail.example.com" })]));
    expect([...held]).toEqual([["TXT example.com", 'the mail-service "example.com"']]);
  });

  it("PLANTED INNOCENT: holds nothing back before the inventory is read, and nothing that is removable", () => {
    expect(heldRecords(null).size).toBe(0);
    expect(heldRecords(view([row({ name: "mail.example.com" })])).size).toBe(0);
  });
});
