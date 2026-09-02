import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getRun } from "../../executor/read.ts";
import type { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import { runRoot, type ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { MASTER_ID } from "./deploy-slave.fixture.ts";
import {
  uniqueEmail, approveSecrets, composedAnswers, liveMaster, settled,
  startedRuns, expectProven, observerStart, observerEnded,
} from "./ansiwise-serve.fixture.ts";

// AN END THE MACHINE WROTE THAT NEVER BECAME ITS RECORD, and what every surface that meets it says.
//
// The engine writes a run's closing header beside the real one and renames over it (ansiwise-core
// RunRecorder.save). On this platform that rename fails while another process has run.json open and
// it carries no retry, so the exit code is left standing in run.json.writing while run.json keeps
// the header the run began with. Two surfaces meet that state — the WAIT that follows a machine run
// and the ASSERTION that judges it afterwards — and neither may answer without naming it. A wait
// that does spends the caller's whole budget and vitest reports a bare timeout pointing at the it()
// line; an assertion that does compares an absent exit_code against 0 and prints
// `expected undefined to be +0`. Neither says which file the answer is in.
//
// IT IS NOT A TEST FILE OF ITS OWN, for the reason redeploy.ansiwise.test.ts states for itself: the
// engine's run root is per-DRIVE and a serve fixture's close() removes the whole of it, so a second
// file starting a second fixture would delete the first file's records mid-run. This registers into
// the ONE file that starts the fixture, which is also why `serve` and `observer` arrive as
// accessors — that file binds them in beforeAll, after this module's describe is registered.

export function orphanedEndSuite(serve: () => ServeFixture, observer: () => AnsiwiseClient): void {
  describe("a machine run whose end was written and never installed", () => {
    it("is refused at once by the wait, not waited out", { timeout: 60_000 }, async () => {
      await liveMaster(serve());
      const run = await observerStart(serve(), { program: "deploy-cluster", mode: "dry", answers: composedAnswers(uniqueEmail()) });
      await observerEnded(observer(), serve(), run.run, AbortSignal.timeout(30_000)); // the innocent case: it ends, and the wait returns
      const dir = join(runRoot(serve().dir), run.run);

      // The state the engine leaves behind when its rename does not land, built here by hand: the
      // closing header standing under the pending name, and a record that carries no end.
      const ended = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dir, "run.json.writing"), JSON.stringify(ended));
      writeFileSync(join(dir, "run.json"), JSON.stringify({ ...ended, exit_code: null }));

      const began = Date.now();
      // The refusal has to be the one about THIS state and not any refusal at all — a bare toThrow()
      // would also pass on a surface that answered 500, and that is the mechanism-free failure again.
      await expect(observerEnded(observer(), serve(), run.run, AbortSignal.timeout(30_000))).rejects.toThrow(/run\.json\.writing/);
      expect(Date.now() - began, "the wait spent the budget instead of reading what was on the disk").toBeLessThan(10_000);
    });

    it("is told apart from a run that has simply not ended yet, which is still waited out to the caller's own budget", { timeout: 60_000 }, async () => {
      await liveMaster(serve());
      const run = await observerStart(serve(), { program: "deploy-cluster", mode: "dry", answers: composedAnswers(uniqueEmail()) });
      await observerEnded(observer(), serve(), run.run, AbortSignal.timeout(30_000));
      const dir = join(runRoot(serve().dir), run.run);

      // The counter-probe of the test above. Same record with its end taken away, but NO pending
      // header beside it — a run still going looks exactly like this, and giving up on one of those
      // would turn a slow machine into a failure.
      const ended = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as Record<string, unknown>;
      rmSync(join(dir, "run.json.writing"), { force: true });
      writeFileSync(join(dir, "run.json"), JSON.stringify({ ...ended, exit_code: null }));

      const began = Date.now();
      // And it gives up saying it STOPPED WATCHING, never that the end will not arrive: nothing on
      // the disk says so here, and the run may still end a moment later.
      await expect(observerEnded(observer(), serve(), run.run, AbortSignal.timeout(4_000))).rejects.toThrow(/stopped watching/);
      expect(Date.now() - began, "the wait gave up on a run that had not ended, with nothing on the disk saying it had").toBeGreaterThanOrEqual(3_500);
    });

    // 180 seconds and not 120: this drives a WHOLE cluster-redeploy, whose master arm carries the
    // placement and deploy-host as well — machine runs, each proven dry before it is run. Under the
    // whole file it goes over 120 while passing alone, which is a budget that does not fit the run
    // rather than a race.
    it("makes the ASSERTION say which file the end is standing in, instead of comparing an absence to zero", { timeout: 180_000 }, async () => {
      const h = await liveMaster(serve());
      const runId = await settled(h, "cluster-redeploy", { serverId: MASTER_ID }, approveSecrets(uniqueEmail()));
      expect(getRun(h.db.db, runId)?.status).toBe("succeeded");

      // THE INNOCENT CASE, on the same run and before anything is touched: with both records whole
      // the assertion passes, so a red answer below is the plant and not the assertion itself.
      expectProven(serve(), h.db, runId, await observer().runs(), ["deploy-cluster"]);

      // THE PLANT. run.json keeps the header the run BEGAN with — which carries no exit_code key at
      // all, not a null one — and the closing header stands beside it under the pending name.
      const live = startedRuns(h.db, runId).find((r) => r.program === "deploy-cluster" && r.mode === "run");
      const dir = join(runRoot(serve().dir), live?.id ?? "");
      const closing = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as Record<string, unknown>;
      const opening = { ...closing };
      delete opening.exit_code;
      writeFileSync(join(dir, "run.json.writing"), JSON.stringify(closing));
      writeFileSync(join(dir, "run.json"), JSON.stringify(opening));

      const orphaned = await observer().runs();
      expect(() => expectProven(serve(), h.db, runId, orphaned, ["deploy-cluster"])).toThrow(/run\.json\.writing/);

      // Put the record back, so the machine's own store carries no run this test broke: every later
      // test reads the same directory.
      writeFileSync(join(dir, "run.json"), JSON.stringify(closing));
      rmSync(join(dir, "run.json.writing"), { force: true });
    });
  });
}
