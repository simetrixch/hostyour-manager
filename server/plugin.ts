// A plugin is compiled into a product, and named by configuration to be active. The core knows it
// through this surface alone: what it is given (Core), what it brings (Wiring), and how it is
// declared (Plugin). A product lists the plugins it compiles in its own server/plugins.ts.
import type { Hono } from "hono";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import type { Db } from "./db/client.ts";
import type { CredentialStore } from "./security/store.ts";
import type { MasterKubeInput } from "./adapters/kube/kube.ts";
import type { ClusterKubeResolver, MasterKubeClients } from "./adapters/kube/port.ts";
import type { PlatformRepo } from "./adapters/git/port.ts";
import type { GitHubApp } from "./adapters/github-app/port.ts";
import type { AppEnv } from "./http/app-env.ts";
import type { Executor } from "./executor/executor.ts";
import type { AnyRunDefinition, StepCtx } from "./executor/types.ts";
import type { CheckResult } from "./boot/selfchecks.ts";
import type { PinHit } from "../shared/pin.ts";

/** What the core hands a plugin when it activates it. */
export interface Core {
  readonly config: Pick<Config, "dataDir" | "version" | "kubeconfigPath" | "github" | "githubApp" | "master" | "vault" | "dns">;
  readonly db: Db;
  readonly store: CredentialStore;
  readonly logger: Logger;
  /** The master-local readers, the per-cluster resolver over them, and the input every master-local
   *  writer is built from; a plugin builds its own label-guarded writers from it. */
  readonly kube: { readonly input: MasterKubeInput; readonly master: MasterKubeClients; readonly resolver: ClusterKubeResolver };
  /** The one writer of the books and the branch it writes to. */
  readonly platformRepo?: PlatformRepo;
  readonly githubApp: GitHubApp;
  /** The `provides` of every plugin this one requires, by name. */
  readonly plugins: Readonly<Record<string, unknown>>;
}

/** One check a plugin runs with the core's self-checks, answering in the core's own result shape:
 *  its `kind` says whether a failure blocks boot. */
export type SelfCheck = () => Promise<CheckResult>;

/** What an active plugin brings. */
export interface Wiring {
  readonly definitions: readonly AnyRunDefinition[];
  /** Mounted by the core under /api/<name>, after the core's routes and before the SPA. */
  routes?(app: Hono<AppEnv>, ports: { executor: Executor }): void;
  /** Once, after the core's seeds: seeds, timers, migrations of the books. */
  onBoot?(ports: { executor: Executor }): Promise<void>;
  /** Run with the core's self-checks, each blocking or not as it says. */
  selfChecks?(): readonly SelfCheck[];
  /** The image tags this plugin's deployments still pin: the reaper's floor. */
  pinHits?(signal?: AbortSignal): Promise<PinHit[]>;
  /** The Applications this plugin expects in a cluster's ArgoCD namespace (cluster-rename waits for them). */
  applicationsOn?(clusterId: string): Promise<string[]>;
  /** Points every DNS record of this plugin that names `from` at `to`; answers the names it moved. */
  repointRecords?(ctx: StepCtx, input: { clusterId: string; from: string; to: string }): Promise<string[]>;
  readonly provides?: unknown;
}

/** A plugin as a product compiles it. `activate` is called only for an active plugin, with its `env`
 *  parsed. */
export interface Plugin<E extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  /** Lower case with hyphens: the name a configuration writes in PLUGINS. */
  readonly name: string;
  readonly requires?: readonly string[];
  /** Parsed for an active plugin; a key it declares may not be set while it is inactive. */
  readonly env: E;
  /** Its tables. */
  readonly schema: Readonly<Record<string, SQLiteTable>>;
  /** The folder of its generated migrations, applied under its own ledger. */
  readonly migrations: string;
  activate(core: Core, config: z.output<E>): Wiring;
}
