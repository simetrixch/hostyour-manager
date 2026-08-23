// The concrete reader of a released executable: one GET, followed all the way to the object store a
// release host redirects to. An adapter, so `fetch` lives here and the placement depends on the port.
import { DownloadFailed, type ReleaseDownloads } from "./port.ts";

/** How long one asset may take. A release binary is tens of megabytes and the manager reads it from
 *  outside its own cluster, so this is generous — and it is a wall clock rather than an idle timer
 *  because a stalled read that never ends is what would otherwise hold a run's step open for ever. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The largest release asset this will hold in memory. The bytes are buffered whole because SFTP is
 *  handed a buffer, and a bound is what turns "the address points at something enormous" into a
 *  named refusal instead of a manager that runs out of memory. */
const MAX_ASSET_BYTES = 256 * 1024 * 1024;

export class HttpReleaseDownloads implements ReleaseDownloads {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async get(url: string, opts: { signal: AbortSignal }): Promise<Buffer> {
    const timeoutMs = this.opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`the download did not finish within ${timeoutMs}ms`)), timeoutMs);
    const onOuterAbort = (): void => timer.abort(opts.signal.reason);
    if (opts.signal.aborted) timer.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    try {
      // `redirect: "follow"` is the whole point of not writing this by hand: a release host answers
      // 302 to an object store on another domain, and a reader that stopped at the first answer
      // would place thirty bytes of redirect notice onto a machine as an executable.
      const res = await fetch(url, { method: "GET", signal: timer.signal, redirect: "follow" });
      if (!res.ok) throw new DownloadFailed(url, `it answered HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0) throw new DownloadFailed(url, "it answered no bytes at all");
      if (body.length > MAX_ASSET_BYTES) {
        throw new DownloadFailed(url, `it answered ${body.length} bytes, past the ${MAX_ASSET_BYTES} this reads`);
      }
      return body;
    } catch (e) {
      if (e instanceof DownloadFailed) throw e;
      throw new DownloadFailed(url, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(t);
      opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }
}
