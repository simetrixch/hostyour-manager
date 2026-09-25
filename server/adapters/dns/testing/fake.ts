// In-memory DnsProvider fake for the onboarding domain tests — no network. A flat (name, type) →
// contents record store: seed what stands under a name before a run, then assert the exact records
// the run created and removed. A name holds a LIST because a real zone does — the sender domain's
// apex carries other services' TXT beside the SPF — and an upsert leaves exactly one, the way the
// Cloudflare adapter does. A CNAME stands alone under its name: an upsert that would put one beside
// another record, or another record beside one, is refused the way Cloudflare refuses it.
import { DnsZoneUnknownError, type DnsProvider, type DnsRecordType } from "../port.ts";

export class FakeDnsProvider implements DnsProvider {
  private readonly records = new Map<string, string[]>();
  /** Every upsert, in order — a test asserts the one record per unit and its content. */
  readonly upserts: Array<{ name: string; type: DnsRecordType; content: string; created: boolean }> = [];
  /** Every delete call, in order, with the content it was narrowed to and how many records it removed. */
  readonly deletes: Array<{ name: string; type: DnsRecordType; content?: string; deleted: number }> = [];
  /** When set, every call throws it — the API-failure path (an unreachable/refusing provider). */
  failWith: Error | null = null;
  /** Zones this fake's token does not cover: every call on a name at or below one of them throws
   *  DnsZoneUnknownError, as the provider does for a domain it holds no zone for. */
  unmanaged: string[] = [];

  private key(name: string, type: DnsRecordType): string {
    return `${type} ${name}`;
  }

  private zoneOf(name: string): void {
    const bare = name.replace(/^\*\./, "");
    const outside = this.unmanaged.find((zone) => bare === zone || bare.endsWith(`.${zone}`));
    if (outside !== undefined) throw new DnsZoneUnknownError(`fake: no zone found for any suffix of "${bare}"`);
  }

  /** Seed the records that pre-exist the run under one name. Several contents seed several records
   *  of that name and type. */
  seed(name: string, type: DnsRecordType, ...contents: string[]): void {
    this.records.set(this.key(name, type), contents);
  }

  /** The first record's content right now, or undefined — the shape a test asserts against. */
  record(name: string, type: DnsRecordType): string | undefined {
    return this.records.get(this.key(name, type))?.[0];
  }

  async upsertRecord(input: { name: string; type: DnsRecordType; content: string }): Promise<{ created: boolean }> {
    if (this.failWith) throw this.failWith;
    this.zoneOf(input.name);
    const own = this.key(input.name, input.type);
    const beside = [...this.records.keys()].some((key) => key !== own && key.endsWith(` ${input.name}`) && (input.type === "CNAME" || key.startsWith("CNAME ")));
    if (beside) throw new Error(`a CNAME stands alone under its name, and ${input.name} already carries another record`);
    const created = !this.records.has(own);
    this.records.set(own, [input.content]);
    this.upserts.push({ name: input.name, type: input.type, content: input.content, created });
    return { created };
  }

  async deleteRecord(input: { name: string; type: DnsRecordType; content?: string }): Promise<{ deleted: number }> {
    if (this.failWith) throw this.failWith;
    this.zoneOf(input.name);
    const key = this.key(input.name, input.type);
    const standing = this.records.get(key) ?? [];
    const kept = input.content === undefined ? [] : standing.filter((c) => c !== input.content);
    const deleted = standing.length - kept.length;
    if (kept.length === 0) this.records.delete(key);
    else this.records.set(key, kept);
    this.deletes.push({ name: input.name, type: input.type, ...(input.content === undefined ? {} : { content: input.content }), deleted });
    return { deleted };
  }

  async readRecordContent(input: { name: string; type: DnsRecordType }): Promise<string | null> {
    return (await this.listRecordContents(input))[0] ?? null;
  }

  async listRecordContents(input: { name: string; type: DnsRecordType }): Promise<string[]> {
    if (this.failWith) throw this.failWith;
    this.zoneOf(input.name);
    return this.records.get(this.key(input.name, input.type)) ?? [];
  }
}
