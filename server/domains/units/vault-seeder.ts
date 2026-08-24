// The VaultSeeder contract now lives with the Vault adapter (adapters/vault/seeder-port.ts) so the
// concrete impl can implement it without an adapter->domain dependency (the boundary law).
// Re-exported here so the onboarding domain keeps importing it from its own folder.
export type { VaultSeeder, VaultSeedInput, VaultSeedOutcome, PostgresSeedInput, PostgresSecretDeleteInput, MongodbSeedInput, MongodbSecretDeleteInput, BuildRepoPatSeedInput, BuildRepoPatDeleteInput, AppSecretsDeleteInput } from "../../adapters/vault/seeder-port.ts";
