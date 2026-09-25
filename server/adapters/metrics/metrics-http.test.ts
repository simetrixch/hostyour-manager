import { describe, it, expect } from "vitest";
import { answerOf } from "./metrics-http.ts";

// THE VERDICT, WITHOUT A SOCKET. What the caller decides on is a body, and the three ways a body can
// fail to answer the question are three different things an operator has to be able to tell apart —
// nothing listening, something answering that is not this API, and this API refusing the query in
// its own words. Each is reproducible here, and none of them needs a server.
//
// WHAT IS NOT MEASURED HERE, named rather than counted: the request itself. Whether the address is
// composed into `<base>/api/v1/query?query=<encoded>` and whether a transport failure comes back as
// an answer instead of a throw are properties of `instant`, which opens a socket — they are held by
// the port's contract and by the step that reads what comes back, not by this file.

describe("the query API's answer", () => {
  it("counts the series a successful vector carries", () => {
    const body = JSON.stringify({
      status: "success",
      data: { resultType: "vector", result: [{ metric: { cluster: "s1.example.com" }, value: [1, "1"] }] },
    });
    expect(answerOf(200, body)).toEqual({ kind: "answered", series: 1 });
  });

  it("answers ZERO series rather than a failure for an empty vector — a machine not pushing YET", () => {
    // The distinction the whole check turns on: the API answered, and the answer is that there is
    // nothing there. Reporting this as a failure would send an operator to look at Prometheus when
    // what is quiet is the machine.
    const body = JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } });
    expect(answerOf(200, body)).toEqual({ kind: "answered", series: 0 });
  });

  it("carries the API's OWN words when it refuses the query", () => {
    const body = JSON.stringify({ status: "error", errorType: "bad_data", error: "invalid parameter \"query\"" });
    const answer = answerOf(400, body);
    expect(answer.kind).toBe("unanswered");
    expect(answer.kind === "unanswered" && answer.detail).toContain("bad_data");
    expect(answer.kind === "unanswered" && answer.detail).toContain("invalid parameter");
  });

  it("refuses a body that is not JSON, and says how much of it there was", () => {
    // What an ingress in front of the wrong Service answers: an HTML error page with a 200 on it.
    const answer = answerOf(200, "<html><body>404 page not found</body></html>");
    expect(answer.kind).toBe("unanswered");
    expect(answer.kind === "unanswered" && answer.detail).toContain("not JSON");
  });

  it("refuses JSON that is not a query answer at all", () => {
    // Something is listening on that address and it is not this API. Reading `data.result` off it
    // would answer zero series, which is the same word a healthy Prometheus uses for a machine that
    // is not pushing yet — the one confusion this check exists to prevent.
    const answer = answerOf(200, JSON.stringify({ hello: "world" }));
    expect(answer.kind).toBe("unanswered");
    expect(answer.kind === "unanswered" && answer.detail).toContain("not a query answer");
  });

  it("refuses a success that carries no data block", () => {
    const answer = answerOf(200, JSON.stringify({ status: "success" }));
    expect(answer.kind).toBe("unanswered");
  });
});
