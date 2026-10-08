import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "#core/server/db/client.ts";
import { recordDnsWrite } from "#core/server/db/dns-writes.ts";
import { providerRemoval, removalSentence, type RemovableRecordRow } from "./dns-record.kit.ts";

// providerRemoval is the one rule for what taking a record back deletes at the provider; the plan
// states its answer and the remove step carries it out. What it must never do is delete content no
// run here wrote: a booked record whose content stands nowhere, and an unbooked mail record the
// measurement judged somebody else's, both delete nothing.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const HAND_DMARC = "v=DMARC1; p=reject; rua=mailto:somebody@example.org";
const DMARC_ROW: RemovableRecordRow = {
  owner: { kind: "mail", name: "example.com" },
  name: "_dmarc.example.com", type: "TXT", record: "dmarc", expected: "one v=DMARC1 record", found: "v=DMARC1; p=none", verdict: "standing", removable: true,
};

describe("providerRemoval", () => {
  it("planted: an unbooked TXT the mail measurement judged `other` is not picked by its tag — a hand wrote it", () => {
    const row = { ...DMARC_ROW, found: HAND_DMARC, verdict: "other" as const };
    const removal = providerRemoval(db.db, row, [HAND_DMARC]);
    expect(removal).toEqual({ content: null, booked: false });
    expect(removalSentence(row, [HAND_DMARC], removal)).toBe(
      `the TXT record _dmarc.example.com (the mail "example.com"): NOTHING is deleted at the provider — what stands there (${HAND_DMARC}) is content no run here wrote, and it stays`,
    );
  });

  it("planted innocent: an unbooked TXT the measurement judged this platform's goes by its tag, and the name's other TXT stays", () => {
    const removal = providerRemoval(db.db, DMARC_ROW, ["somebody-else=verification", "v=DMARC1; p=none"]);
    expect(removal).toEqual({ content: "v=DMARC1; p=none", booked: false });
  });

  it("a booked record goes by its booked content where it stands, and by nothing where it stands nowhere", () => {
    recordDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_test" });
    expect(providerRemoval(db.db, DMARC_ROW, ["v=DMARC1; p=none", HAND_DMARC])).toEqual({ content: "v=DMARC1; p=none", booked: true });
    expect(providerRemoval(db.db, DMARC_ROW, [HAND_DMARC])).toEqual({ content: null, booked: true });
  });
});
