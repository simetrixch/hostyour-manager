import { describe, it, expect } from "vitest";
import { startFakeSshServer } from "./fake-server.ts";

describe("startFakeSshServer", () => {
  // The fixture must not draw its host key straight from ssh2's generateKeyPairSync. Roughly 1 draw
  // in 256 of that generator is a pair ssh2's own parser rejects, and `new Server` parses hostKeys
  // in its constructor, so a bad draw throws out of the fixture before it can return a port. One
  // start cannot see that. STARTS is picked so a fixture back on the raw generator fails here with
  // probability 1 - (255/256)^STARTS, which is above 99.9%, and that is what keeps the guarded
  // generator from being swapped back out. A start costs well under a millisecond.
  it("returns a listening server on every host key it draws", async () => {
    const STARTS = 2000;
    const failures: string[] = [];
    for (let i = 0; i < STARTS; i += 1) {
      try {
        const server = await startFakeSshServer({});
        if (server.port <= 0) failures.push(`start ${i}: no port`);
        await server.close();
      } catch (err) {
        failures.push(`start ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(failures, `${failures.length} of ${STARTS} starts: ${failures.slice(0, 3).join("; ")}`).toEqual([]);
  }, 60000);
});
