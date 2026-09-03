import { describe, it, expect } from "vitest";
import type { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import type { ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { appearedRecord, RECORD_APPEARS_POLL_MS } from "./defs/ansiwise-run.kit.ts";
import {
  uniqueEmail, composedAnswers, liveMaster, observerStart,
} from "./ansiwise-serve.fixture.ts";

// A RUN THAT HAS BEEN ACCEPTED AND HAS NOT WRITTEN ITS RECORD YET, and what this manager may say
// about it.
//
// A 202 says the run is GOING, not that its record exists: the child is detached, and everything it
// does before its first header — parsing the catalogue, MEASURING the program's answer conditions
// against the machine over real shell and HTTP calls, spawning `git rev-parse`, listing the run root
// for the gate — happens after the door has answered. Nothing serialises two runs, and on a master
// there is always a second one, because hostyour-vault-unseal.timer asks the secret store whether it
// is sealed every minute.
//
// SO THE WAIT CAN EXPIRE ON A RUN THAT IS PERFECTLY ALIVE. Measured on apps6: a deploy-slave-branch
// run accepted at 15:53:06 wrote its header at 15:53:17 and finished green at 15:53:25, having cut
// and pushed the slave's branch — while the manager, on a ten-second bound, had already failed the
// step and stopped its own run at 12 of 28. What it said was that the run "started and died before
// its first step", which it had no way of knowing: the machine answers the SAME 404 for a run id it
// never issued and for one whose child is still starting.
//
// These two cases are the ones no run kind can be driven into, which is why they speak to
// appearedRecord directly. An id the machine never issued IS the shape the failing case has from the
// client's side — 404, for as long as anyone asks — so it needs nothing planted on the disk.
//
// It registers into the ONE file that starts the serve fixture, for the reason
// orphaned-end.ansiwise.suite.ts states: the engine's run root is per-drive and a second fixture
// would delete the first file's records mid-run.

export function recordAppearsSuite(serve: () => ServeFixture, observer: () => AnsiwiseClient): void {
  describe("a run whose record has not appeared", () => {
    it("gives up saying what it cannot know is which — never that the run died", async () => {
      // Short, because the bound is a parameter for exactly this: the real one is minutes, and a
      // test spending them proves the same thing more slowly.
      const budget = 4 * RECORD_APPEARS_POLL_MS;
      const began = Date.now();
      const waiting = appearedRecord(
        observer(),
        "20260101T000000Z-1-neverissued",
        "deploy-cluster",
        AbortSignal.timeout(30_000),
        budget,
      );

      // Each assertion is a claim the old sentence broke. Naming them one by one and not as one
      // regex is what makes a failure say WHICH of them stopped holding.
      await expect(waiting).rejects.toThrow(/20260101T000000Z-1-neverissued/); // the id, so the operator can go and look
      await expect(waiting).rejects.toThrow(/still starting or is gone/);      // it says it cannot tell
      await expect(waiting).rejects.toThrow(/RE-ATTACHES/);                    // and what retrying does
      await expect(waiting).rejects.not.toThrow(/died/);                       // and never asserts a death it did not see

      // The bound is a duration and not a count of tries: a wait that returned at once would pass
      // every assertion above while having asked the machine nothing.
      expect(Date.now() - began, "the wait gave up without spending its bound").toBeGreaterThanOrEqual(budget);
    });

    it("returns for a run the machine really did accept, and does not wait its bound out", async () => {
      // The counter-probe. Without it the case above would also pass on a wait that refused
      // everything, which would fail every step this manager has instead of the one it means to.
      await liveMaster(serve());
      const run = await observerStart(serve(), {
        program: "deploy-cluster",
        mode: "dry",
        answers: composedAnswers(uniqueEmail()),
      });
      const began = Date.now();
      await appearedRecord(observer(), run.run, "deploy-cluster", AbortSignal.timeout(30_000), 30_000);
      expect(Date.now() - began, "an accepted run's record took longer to appear than the whole failing case").toBeLessThan(20_000);
    });
  });
}
