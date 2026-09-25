// THE UNIT PLUGIN: what a unit is and how it is built — the base both families stand on. It carries
// the size table, the build-only chain, the relocation mechanism, the owner identities, the DNS book
// and the adapters every unit is reached through, and hands the families the ports they take from
// the set: one activation client, one Vault seeder, one GitHub client for the units' repositories,
// and the relocation surface its keys configure.
import { fileURLToPath } from "node:url";
import type { Plugin } from "#core/server/plugin.ts";
import { unitSizes } from "#core/server/db/schema/inventory.ts";
import { UnitEnv, unitConfig } from "./config.ts";
import { seedUnitSizes } from "./unit-size.ts";
import type { StorageBoxAccess } from "./relocation-jobs.ts";
import { HttpActivator } from "./adapters/activation/activation-http.ts";
import type { Activator } from "./adapters/activation/port.ts";
import { HttpPublicProbe } from "./adapters/http-probe/http-probe.ts";
import type { PublicProbe } from "./adapters/http-probe/port.ts";
import { HttpGitHubConsumer } from "./adapters/github-consumer/github-consumer-http.ts";
import type { GitHubConsumer } from "./adapters/github-consumer/port.ts";
import { VaultSelfSeeder } from "./adapters/vault/vault-self-seeder.ts";
import type { VaultSeeder } from "./adapters/vault/seeder-port.ts";

/** What the unit plugin provides the families: every port here is ONE instance for both. */
export interface UnitPorts {
  /** A plain fetch to a unit's OWN public ingress: the first-admin bootstrap of a consumer and of a
   *  tenant alike. The target host is the unit's own, so nothing configures it. */
  activator: Activator;
  /** The one Vault seeder, over the Manager's own kubernetes-auth login (config.vault): a family's
   *  seed and its removal write and destroy through the same identity. Without Vault every write
   *  fails closed inside the seeder rather than inventing an identity. */
  seeder: VaultSeeder;
  /** The per-call GitHub client of a unit's repository: its scopes, its build webhook, its release
   *  dispatch, its packages, and the owner identities measured with it. */
  github: GitHubConsumer;
  /** The relocation surface both families' backup/restore/migrate share: the public probe the
   *  quiesce is measured with, and the staging area and job image the keys configure. */
  relocation: { probe: PublicProbe; storageBox?: StorageBoxAccess; dbtoolsImage?: string };
}

export const unitPlugin: Plugin<typeof UnitEnv> = {
  name: "unit",
  env: UnitEnv,
  schema: { unitSizes },
  // The size table is EDITED data, not derived data: the boot seed would refill it with the SHIPPED
  // figures, silently replacing the ones this installation sells, and the registrations in git carry
  // resolved numbers, not the table they came from. A reset ends what the manager KNOWS; what it
  // SELLS outlives that.
  keep: ["unit_sizes"],
  migrations: fileURLToPath(new URL("./migrations", import.meta.url)),
  activate(core, env) {
    const config = unitConfig(env);
    const vault = core.config.vault;
    const provides: UnitPorts = {
      activator: new HttpActivator(),
      seeder: new VaultSelfSeeder(vault ? { self: { addr: vault.addr, k8sAuthMount: vault.k8sAuthMount, k8sRole: vault.k8sRole, saTokenPath: vault.saTokenPath } } : {}),
      github: new HttpGitHubConsumer(),
      relocation: {
        probe: new HttpPublicProbe(),
        ...(config.storageBox ? { storageBox: config.storageBox } : {}),
        ...(config.dbtoolsImage ? { dbtoolsImage: config.dbtoolsImage } : {}),
      },
    };
    return {
      definitions: [],
      // Fill in any of the sizes this database does not carry yet, and touch none that it does:
      // create-only, so an installation that edited a size keeps its figures across every restart.
      onBoot: async () => {
        const seeded = seedUnitSizes(core.db);
        if (seeded.length > 0) core.logger.info({ sizes: seeded }, "unit size table seeded");
      },
      provides,
    };
  },
};

/** The unit plugin's ports, read off what its activation provided. */
export function unitPorts(provides: unknown): UnitPorts {
  return provides as UnitPorts;
}
