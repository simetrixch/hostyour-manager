import { defineConfig } from "vitest/config";

/** THE ONE SUITE THAT STARTS A REAL SERVER, and why it is not run beside the others.
 *
 *  `redeploy.ansiwise.test.ts` starts a real `ansiwise-rest serve` and drives real runs through it,
 *  waiting on what that server writes to disk. Every other file here is in-process. Run together,
 *  the real one competes for CPU with two hundred others and the waits it was given — generous when
 *  it runs alone — stop being generous. It went red twice in one evening on wall-clock budgets and
 *  passed 24/24 by itself immediately after each time.
 *
 *  A GATE THAT GOES RED AT RANDOM IS A GATE PEOPLE STOP READING, and the next real defect it catches
 *  is read as "the flaky one again". So it is given the isolation it actually needs rather than a
 *  retry, a longer timeout or a skip — each of which closes the ticket without answering it.
 *
 *  `groupOrder` is how vitest 3 says this: projects in a lower group run first and finish before the
 *  next group starts, and projects sharing a group run together. Everything in-process runs as one
 *  group, then the real server runs alone in the next — no worker of the first group is still
 *  holding a core while it waits. It costs the wall-clock of that one file, and nothing else slows
 *  down: the other files keep running in parallel exactly as before. */
export default defineConfig({
  test: {
    reporters: "default",
    projects: [
      {
        test: {
          name: "in-process",
          include: ["server/**/*.test.ts", "shared/**/*.test.ts", "gate-runner/**/*.test.ts", "web/**/*.test.ts"],
          exclude: ["**/*.ansiwise.test.ts", "**/node_modules/**"],
          environment: "node",
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "real-serve",
          include: ["server/**/*.ansiwise.test.ts"],
          environment: "node",
          // ALONE, AND ONE FILE AT A TIME. There is one such file today; a second would start a
          // second serve fixture, and the engine's run root is per-drive — a fixture's close()
          // removes the whole of it, so two running together would delete each other's records.
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
