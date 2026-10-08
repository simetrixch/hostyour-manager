import type { VaultSeeder, VaultSeedOutcome, BuildRepoPatDeleteInput, AppSecretsDeleteInput, PostgresSecretDeleteInput, MongodbSecretDeleteInput, RedisSecretDeleteInput, MariadbSecretDeleteInput } from "#unit/server/adapters/vault/seeder-port.ts";

/** The seeder a TEARDOWN test stands on — offboard, its scoped variant and purge alike: it records
 *  the four deletes those runs make and refuses every write, because a run that removes a unit has
 *  no business seeding, patching or refreshing anything. Declared once here rather than three times:
 *  a fourth teardown reads the same fake, and a new port method lands in one place. */
export class RecordingTeardownSeeder implements VaultSeeder {
  deleted: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  deletedPostgres: PostgresSecretDeleteInput[] = [];
  deletedMongodb: MongodbSecretDeleteInput[] = [];
  deletedRedis: RedisSecretDeleteInput[] = [];
  deletedMariadb: MariadbSecretDeleteInput[] = [];
  async seed(): Promise<VaultSeedOutcome> { throw new Error("a teardown never seeds"); }
  async patchApp(): Promise<void> { throw new Error("a teardown never patches"); }
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("a teardown never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("a teardown never seeds mongodb"); }
  async seedRedis(): Promise<VaultSeedOutcome> { throw new Error("a teardown never seeds redis"); }
  async seedMariadb(): Promise<VaultSeedOutcome> { throw new Error("a teardown never seeds mariadb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("a teardown never seeds a repo pat"); }
  async refreshBuildRepoPat(): Promise<void> { throw new Error("a teardown never refreshes a repo pat"); }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deleted.push(i); }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(i: PostgresSecretDeleteInput): Promise<void> { this.deletedPostgres.push(i); }
  async deleteMongodb(i: MongodbSecretDeleteInput): Promise<void> { this.deletedMongodb.push(i); }
  async deleteRedis(i: RedisSecretDeleteInput): Promise<void> { this.deletedRedis.push(i); }
  async deleteMariadb(i: MariadbSecretDeleteInput): Promise<void> { this.deletedMariadb.push(i); }
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedTenantAppKey(): Promise<{ created: boolean }> { return { created: true }; }
  async listTenantAppKeys(): Promise<string[]> { return []; }
  async replaceGoogleTranslation(): Promise<void> {}
  async seedTenantGoogleTranslation(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantGoogleTranslation(): Promise<void> {}
  async deleteTenantAppKeys(): Promise<{ deleted: string[] }> { return { deleted: [] }; }
  async deleteTenantCrypto(): Promise<void> {}
}
