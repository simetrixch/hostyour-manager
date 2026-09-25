// In-memory ReleaseDownloads fake — scripted per exact address, and REFUSING every address nothing
// scripted. A default that answered bytes would let a suite pass while the placement fetched an
// address the installation never states, which is the one thing the two placeholders exist against.
import { DownloadFailed, type ReleaseDownloads } from "../port.ts";

export class FakeReleaseDownloads implements ReleaseDownloads {
  /** Every address this was asked for, in order — so a test can hold what was FETCHED against what
   *  the installation configured, rather than against what the placement meant to fetch. */
  readonly read: string[] = [];

  constructor(private scripted: Record<string, Buffer> = {}) {}

  set(url: string, bytes: Buffer): void {
    this.scripted = { ...this.scripted, [url]: bytes };
  }

  async get(url: string, _opts: { signal: AbortSignal }): Promise<Buffer> {
    this.read.push(url);
    const bytes = this.scripted[url];
    if (bytes === undefined) throw new DownloadFailed(url, "nothing is served there");
    return bytes;
  }
}
