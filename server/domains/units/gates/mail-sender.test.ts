import { describe, it, expect } from "vitest";
import { gateMailSender } from "./mail-sender.ts";

const on = { cluster: "s1.example", apiHost: "100.64.0.11" };

describe("G29 mail sender (hard) — one stage, one unit carrying an SMTP entry, on a cluster the relay reaches", () => {
  it("passes the first sender of a stage", () => {
    expect(gateMailSender({ unitName: "post", stage: "prod", senders: [], ...on })).toMatchObject({ id: "G29", severity: "hard", status: "pass", reason: null });
  });

  it("passes a re-onboard of the sender itself — its own entry is not a second sender", () => {
    expect(gateMailSender({ unitName: "post", stage: "prod", senders: [{ unit: "post", cluster: "apps1" }], ...on }).status).toBe("pass");
  });

  it("fails a second sender, naming the unit that stands, its cluster, and the way out", () => {
    const g = gateMailSender({ unitName: "shop", stage: "prod", senders: [{ unit: "post", cluster: "apps1" }], ...on });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("post (on apps1)");
    expect(g.reason).toContain("offboard post at prod first");
    expect(g.evidence).toEqual([{ source: "manager", name: "post", fieldPath: "smtpEntry", value: "apps1" }]);
  });

  it("fails a sender whose target map carries no tailnet address, naming the cluster and the two programs that write one", () => {
    const g = gateMailSender({ unitName: "post", stage: "prod", senders: [], cluster: "s1.example", apiHost: null });
    expect(g.status).toBe("fail");
    expect(g.found).toBe("the map of s1.example carries no global.apiHost");
    expect(g.reason).toContain("tailnet address of s1.example");
    expect(g.reason).toContain("deploy-slave writes it for a slave and tailnet-record-address for a master");
  });
});
