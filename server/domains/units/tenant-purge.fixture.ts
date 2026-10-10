import type { VaultSeeder, VaultSeedOutcome, TenantCryptoDeleteInput } from "#unit/server/adapters/vault/seeder-port.ts";

/** Records the crypto deletes a purge issues. The purge never SEEDS, so those throw: a purge that
 *  wrote a tenant's identity instead of destroying it would be the exact inverse of the run kind. */
export class FakePurgeSeeder implements VaultSeeder {
  readonly deletedCrypto: TenantCryptoDeleteInput[] = [];
  async seed(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds"); }
  async patchApp(): Promise<void> {}
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds mongodb"); }
  async seedRedis(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds redis"); }
  async seedMariadb(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds mariadb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds a repo pat"); }
  async refreshBuildRepoPat(): Promise<void> { throw new Error("purge never refreshes a repo pat"); }
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds tenant crypto"); }
  async seedTenantAppKey(): Promise<{ created: boolean }> { return { created: true }; }
  async listTenantAppKeys(): Promise<string[]> { return []; }
  async replaceGoogleTranslation(): Promise<void> {}
  async seedTenantGoogleTranslation(): Promise<VaultSeedOutcome> { return { created: true }; }
  readonly deletedGoogle: TenantCryptoDeleteInput[] = []; async deleteTenantGoogleTranslation(i: TenantCryptoDeleteInput): Promise<void> { this.deletedGoogle.push(i); }
  async deleteTenantAppKeys(i: TenantCryptoDeleteInput): Promise<{ deleted: string[] }> { this.deletedAppKeys.push(i); return { deleted: ["password-field-key/erp"] }; }
  readonly deletedAppKeys: TenantCryptoDeleteInput[] = [];
  async deleteTenantCrypto(i: TenantCryptoDeleteInput): Promise<void> { this.deletedCrypto.push(i); }
  async replaceTenantE2ePassword(): Promise<void> { throw new Error("purge never writes an end-to-end password"); }
  readonly deletedE2e: TenantCryptoDeleteInput[] = []; async deleteTenantE2ePassword(i: TenantCryptoDeleteInput): Promise<void> { this.deletedE2e.push(i); }
  async deleteBuildRepoPat(): Promise<void> {}
  async deleteApp(): Promise<void> {}
  async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
  async deleteRedis(): Promise<void> {}
  async deleteMariadb(): Promise<void> {}
}
