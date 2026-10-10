// The Vault seeder create-tenant's tests hand the run: it seeds the tenant's crypto entry and its
// apps' Password field keys, and every consumer-side method refuses.
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";

/** A VaultSeeder for the tenant runs: create-tenant seeds the crypto entry through it, and nothing
 *  else here touches Vault. `created: true` models the normal first run; the consumer-side methods
 *  throw, because a tenant run reaching one of them would be a wiring mistake, not a pass. */
export function fakeTenantSeeder(): VaultSeeder {
  return {
    seed: () => Promise.reject(new Error("a tenant run never seeds a consumer entry")),
    patchApp: async () => undefined,
    seedPostgres: () => Promise.reject(new Error("a tenant run never seeds postgres")),
    seedMongodb: () => Promise.reject(new Error("a tenant run never seeds mongodb")),
    seedRedis: () => Promise.reject(new Error("a tenant run never seeds redis")),
    seedMariadb: () => Promise.reject(new Error("a tenant run never seeds mariadb")),
    seedBuildRepoPat: () => Promise.reject(new Error("a tenant run never seeds a repo pat")),
    refreshBuildRepoPat: () => Promise.reject(new Error("a tenant run never refreshes a repo pat")),
    deleteBuildRepoPat: async () => {},
    deleteApp: async () => {},
    deletePostgres: async () => {}, deleteMongodb: async () => {}, deleteRedis: async () => {}, deleteMariadb: async () => {},
    seedTenantCrypto: async () => ({ created: true }),
    seedTenantAppKey: async () => ({ created: true }),
    listTenantAppKeys: async () => [],
    replaceGoogleTranslation: async () => {}, seedTenantGoogleTranslation: async () => ({ created: true }), deleteTenantGoogleTranslation: async () => {},
    deleteTenantAppKeys: async () => ({ deleted: [] }),
    deleteTenantCrypto: async () => {},
    replaceTenantE2ePassword: async () => {}, seedTenantE2ePassword: async () => ({ created: true }),
    deleteTenantE2ePassword: async () => {},
  };
}
