// In-memory PublicProbe fake — scripted per exact URL, defaulting to UNREACHABLE (the answer a
// correctly quiesced unit gives, so a happy-path relocation test scripts nothing). Records every
// probed URL so a test can assert verify-quiesced measured the unit's PUBLIC host.
import type { PublicProbe, ProbeResult } from "../port.ts";

export class FakePublicProbe implements PublicProbe {
  readonly probed: string[] = [];

  constructor(private scripted: Record<string, ProbeResult> = {}) {}

  set(url: string, result: ProbeResult): void {
    this.scripted = { ...this.scripted, [url]: result };
  }

  async probe(url: string, _opts: { signal?: AbortSignal }): Promise<ProbeResult> {
    this.probed.push(url);
    return this.scripted[url] ?? { reachable: false, detail: "HTTP 404" };
  }
}
