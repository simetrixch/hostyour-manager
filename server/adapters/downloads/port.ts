// Reading a released executable's bytes, as a port the placement can be tested against.
//
// WHY THE MANAGER FETCHES AND NOT THE MACHINE. The bootstrap puts both ansiwise executables on a
// machine that carries nothing at all — no `curl`, no certificate store, and in the general case no
// route out of its own network. Having the machine fetch them would mean composing a download
// command and shipping it there, which is the mutation site place-ansiwise.ts exists to remove. So
// the bytes are read HERE, over the manager's own network, and reach the machine as a file transfer.
//
// A PORT AND NOT A `fetch` CALL IN THE STEP: the boundary law keeps IO libraries inside adapters/
// (.dependency-cruiser.cjs `adapters-own-io-libs`), and a placement that opened a socket itself
// could not be driven by a suite that opens none.

/** The bytes behind an address, and nothing about what they are. */
export interface ReleaseDownloads {
  /** Read everything served at `url`.
   *
   *  Throws — never answers an empty buffer for a failure — because the caller writes what comes
   *  back onto a machine as an executable, and a refusal that looked like a zero-length release
   *  would be placed and only then found out about. The message names the address and what answered
   *  instead, since the ordinary faults here are an installation's address pointing at a release
   *  that carries no asset under that name and a network that has no route to it. */
  get(url: string, opts: { signal: AbortSignal }): Promise<Buffer>;
}

/** Nothing served the address, or what did was not a release asset. Its own type so a step can tell
 *  "the installation's address is wrong" apart from "the machine refused the file". */
export class DownloadFailed extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`could not read ${url}: ${reason}`);
    this.name = "DownloadFailed";
  }
}
