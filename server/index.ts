import { writeSync } from "node:fs";
import { boot } from "./boot/boot.ts";

// WHY writeSync AND NOT process.stderr.write. In a container stderr is a PIPE, and Node writes to a
// pipe asynchronously: process.exit() below leaves the buffered bytes unwritten, so the one sentence
// saying why this process is leaving is the only thing that never arrives. What an operator sees
// instead is a bare exit code — and, because better-sqlite3 finalizes its statements after the
// environment is torn down, its own teardown assertion as the sole output, which describes the exit
// and not the failure. Every blocking self-check, every unreadable config and every boot fault has
// been reported this way. writeSync goes to the descriptor and returns once the bytes are there.
boot().catch((err: unknown) => {
  writeSync(2, `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
