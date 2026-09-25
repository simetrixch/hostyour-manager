import { describe, it, expect } from "vitest";
import { readServerTailnet, tailnetReading } from "./tailnet.ts";

const V0 = {
  v: 0, observedAt: 1_700_000_000_000, runId: "run_abc",
  clientVersion: "1.80.2", backendState: "Running", address: "100.71.4.9", coordinator: "https://tailnet.example.com",
};

// The reader is the point of the version field. A document that stamps `v` and has no reader
// narrowing on it is a comment: the plane document next door does exactly that, and two of its
// readers ask for fields it never declared and miss on every row without a sound. These cases are
// what stop that from repeating here.
describe("readServerTailnet narrows on the stored version", () => {
  it("parses a v0 document into its facts", () => {
    const read = readServerTailnet(V0);
    expect(read).toEqual({ kind: "v0", facts: V0 });
  });

  it("answers 'none' for no document at all — never a fabricated empty reading", () => {
    expect(readServerTailnet(null)).toEqual({ kind: "none" });
    expect(readServerTailnet(undefined)).toEqual({ kind: "none" });
  });

  it("answers 'unsupported' for a version this build does not know, WITHOUT parsing the body", () => {
    // A v1 body may carry anything at all; the reader must not judge it against the v0 schema and
    // must not silently fall back to a v0 reading of the fields that happen to match.
    const read = readServerTailnet({ v: 1, joinedTo: "somewhere", address: "100.71.4.9" });
    expect(read).toEqual({ kind: "unsupported", v: 1 });
  });

  it("answers 'unreadable' when there is no version field — an unversioned blob is not a v0 document", () => {
    const read = readServerTailnet({ observedAt: 1, runId: "run_abc", clientVersion: null, address: null });
    expect(read).toEqual({ kind: "unreadable", reason: "no version field" });
  });

  it("answers 'unreadable' with the failing path when a v0 body does not hold its schema", () => {
    const read = readServerTailnet({ ...V0, observedAt: "yesterday" });
    expect(read.kind).toBe("unreadable");
    if (read.kind === "unreadable") expect(read.reason).toContain("observedAt");
  });

  it("refuses an empty address rather than reading one that means nothing — null is the absence", () => {
    expect(readServerTailnet({ ...V0, address: "" }).kind).toBe("unreadable");
    expect(readServerTailnet({ ...V0, address: null }).kind).toBe("v0");
  });
});

// The fold from one probe to the pair the row stores. Both halves come out of one call, so a state
// can never be written without the reading that produced it.
describe("tailnetReading folds a probe into state + document", () => {
  const meta = { runId: "run_abc", observedAt: 1_700_000_000_000 };
  const probe = (over: Partial<Parameters<typeof tailnetReading>[0]> = {}): Parameters<typeof tailnetReading>[0] => ({
    installed: true, clientVersion: "1.80.2", backendState: "Running",
    address: "100.71.4.9", coordinator: "https://tailnet.example.com", ...over,
  });

  it("no client on the host → 'no-client', and nothing about a client is invented", () => {
    const { state, doc } = tailnetReading(probe({ installed: false }), meta);
    expect(state).toBe("no-client");
    expect(doc.clientVersion).toBeNull();
    expect(doc.backendState).toBeNull();
  });

  it("a client that would not answer → 'client-unreadable', NEVER 'not-joined'", () => {
    // The whole point of the literal: an unreachable client prints no address either, so reading
    // the missing address as "this host is on no network" would state as measured fact exactly the
    // thing the run failed to measure.
    const { state } = tailnetReading(probe({ backendState: null, address: null }), meta);
    expect(state).toBe("client-unreadable");
  });

  it("a client that answers with any state but Running → 'not-joined', and the state is kept", () => {
    const { state, doc } = tailnetReading(probe({ backendState: "NeedsLogin", address: null }), meta);
    expect(state).toBe("not-joined");
    expect(doc.backendState).toBe("NeedsLogin");
  });

  it("client installed but its version could not be read → still a client, state still decides", () => {
    const { state, doc } = tailnetReading(probe({ clientVersion: null }), meta);
    expect(state).toBe("joined");
    expect(doc.clientVersion).toBeNull();
  });

  it("Running → 'joined', and the document carries the provenance the card renders", () => {
    const { state, doc } = tailnetReading(probe(), meta);
    expect(state).toBe("joined");
    expect(doc).toEqual({ ...V0, observedAt: meta.observedAt, runId: meta.runId });
  });

  it("the coordinator is recorded, so a host on somebody else's network is not silently ours", () => {
    const { doc } = tailnetReading(probe({ coordinator: "https://controlplane.tailscale.com" }), meta);
    expect(doc.coordinator).toBe("https://controlplane.tailscale.com");
  });

  it("everything it produces survives its own reader — the writer and the reader agree", () => {
    const { doc } = tailnetReading(probe(), meta);
    expect(readServerTailnet(doc)).toEqual({ kind: "v0", facts: doc });
  });
});
