import type { PublicDns } from "../public-dns.ts";

/** The public DNS as a test scripts it: seed what receivers would find, name by name. An unseeded
 *  name answers the empty list — an absent record, exactly as the real resolver reports one. */
export class FakePublicDns implements PublicDns {
  private readonly txts = new Map<string, string[]>();
  private readonly as = new Map<string, string[]>();
  private readonly ptrs = new Map<string, string[]>();
  /** Every name asked, in order — a test can assert the check looked where it said it would. */
  readonly asked: string[] = [];

  seedTxt(name: string, ...records: string[]): void { this.txts.set(name, records); }
  seedA(name: string, ...addresses: string[]): void { this.as.set(name, addresses); }
  seedPtr(address: string, ...names: string[]): void { this.ptrs.set(address, names); }

  async txt(name: string): Promise<string[]> { this.asked.push(`TXT ${name}`); return this.txts.get(name) ?? []; }
  async a(name: string): Promise<string[]> { this.asked.push(`A ${name}`); return this.as.get(name) ?? []; }
  async ptr(address: string): Promise<string[]> { this.asked.push(`PTR ${address}`); return this.ptrs.get(address) ?? []; }
}
