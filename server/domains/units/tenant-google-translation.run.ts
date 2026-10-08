import { and, eq, notInArray } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { tenantApps } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { GOOGLE_TRANSLATION_SECRET_PREFIX } from "../../../shared/approve.ts";
import { errValidation } from "../../kernel/errors.ts";
import { listSecretWrites, recordSecretWrites, tenantAppSecretEntry } from "../../db/secret-writes.ts";
import { GOOGLE_TRANSLATION_PROPERTIES, type GoogleTranslationProperty, type VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { sleep } from "#unit/server/release-cycle.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { RemoveAppParams, tenantLocks } from "./tenant-lifecycle.run.ts";
import type { Db } from "../../db/client.ts";

// `tenant-set-google-translation` — write the Google translation settings an operator types for one
// app of a tenant, and bring them into the app's engine.
//
// THE VALUES ARE TYPED AT APPROVE. The plan asks for the four properties as run secrets, so the run
// page's approve form is the form: the values travel once, are held in memory for the run, are masked
// in every log line and are zeroed when the run ends. Nothing of them is stored outside Vault.
//
// WHY EVERY PROPERTY IS WRITTEN. The app's ExternalSecret names all four, and ESO fails the whole sync
// when one is missing, which stops Argo CD before the engine's wave. A blank location or glossary is
// written as the empty text, which the plugin reads as not set.
//
// WHY THE WAIT COMES BEFORE THE RESTART. The ExternalSecret refreshes only when asked
// (`refreshInterval: "0"`), and an engine reads its env once, at start. A restart before ESO has
// written the Secret again starts the engine on the old values, so the restart waits for the
// ExternalSecret's `refreshTime` to move.

export const GOOGLE_TRANSLATION_EXTERNAL_SECRET = "hostyour-google-translation";

export const TenantSetGoogleTranslationParams = RemoveAppParams;
export type TenantSetGoogleTranslationParams = RemoveAppParams;

export interface TenantSetGoogleTranslationPorts extends TenantLifecyclePorts {
  seeder: VaultSeeder;
  /** How long the refresh waits for ESO to write the Secret again. */
  refreshWaitMs?: number;
  refreshPollMs?: number;
}

const secretKey = (property: GoogleTranslationProperty): string => `${GOOGLE_TRANSLATION_SECRET_PREFIX}${property}`;
const REQUIRED: readonly GoogleTranslationProperty[] = ["project", "service-account"];
const OPTIONAL: readonly GoogleTranslationProperty[] = ["location", "glossary"];
// The project, the location and the glossary are path segments of every Translation API call.
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The four typed values, checked the way the plugin reads them. Every refusal names the property and
 *  never the value. */
export function readGoogleTranslationSettings(typed: (key: string) => string | undefined): Record<GoogleTranslationProperty, string> {
  const data = Object.fromEntries(GOOGLE_TRANSLATION_PROPERTIES.map((p) => [p, (typed(secretKey(p)) ?? "").trim()])) as Record<GoogleTranslationProperty, string>;
  for (const p of REQUIRED) if (data[p] === "") throw errValidation(`no ${p} was typed — the plugin translates with none of the settings without it`);
  for (const p of ["project", ...OPTIONAL] as const) {
    if (data[p] !== "" && !PATH_SEGMENT.test(data[p])) throw errValidation(`the ${p} holds a character other than a letter, a digit, "-" or "_", which no Google ${p} name has`);
  }
  let account: unknown;
  try {
    account = JSON.parse(data["service-account"]);
  } catch {
    // The parser's own message quotes the text around the fault, which is the key.
    throw errValidation("the service account is not JSON — paste the whole key file Google Cloud gave for it");
  }
  const { client_email: email, private_key: key } = (account ?? {}) as { client_email?: unknown; private_key?: unknown };
  if (typeof email !== "string" || email === "" || typeof key !== "string" || key === "") {
    throw errValidation("the service account holds no client_email and private_key — paste the key file of a service account, not another Google file");
  }
  return data;
}

/** The app's entry, from the tenant's standing app of that name, or a refusal. */
function standingApp(db: Db, tenantId: string, app: string): TenantCluster {
  const tc = loadTenantCluster(db, tenantId);
  const row = db.select({ name: tenantApps.name }).from(tenantApps)
    .where(and(eq(tenantApps.tenantId, tenantId), eq(tenantApps.name, app), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS]))).get();
  if (!row) throw errValidation(`tenant ${tc.guid} has no standing app "${app}" — only a standing app's engine reads Google translation settings`);
  return tc;
}

const entryOf = (tc: TenantCluster, app: string): string => tenantAppSecretEntry(tc.stage, tc.guid, `google-translation/${app}`);

function tenantSetGoogleTranslationSteps(ports: TenantSetGoogleTranslationPorts, p: TenantSetGoogleTranslationParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-settings",
      title: "Write the typed Google translation settings into the app's Vault entry",
      run: async (ctx) => {
        const tc = standingApp(ctx.db, p.tenantId, p.app);
        const data = readGoogleTranslationSettings((key) => ctx.secrets.get(key)?.toString("utf8"));
        await ports.seeder.replaceGoogleTranslation({ stage: tc.stage, guid: tc.guid, app: p.app, data });
        const entry = entryOf(tc, p.app);
        recordSecretWrites(ctx.db, { entry, keys: [...GOOGLE_TRANSLATION_PROPERTIES], act: "set", runId: ctx.runId });
        const blank = OPTIONAL.filter((o) => data[o] === "");
        ctx.log("meta", `${entry} written with ${GOOGLE_TRANSLATION_PROPERTIES.join(", ")}${blank.length > 0 ? ` (${blank.join(" and ")} left blank, so not set)` : ""}`);
      },
    },
    {
      name: "refresh-settings",
      title: "Ask ESO to write the app's Google translation Secret again, and wait until it has",
      run: async (ctx) => {
        const tc = standingApp(ctx.db, p.tenantId, p.app);
        const namespace = memberNamespace(tc.guid, p.app, tc.stage);
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        const read = async () => (await clusterReader.listExternalSecrets(namespace)).find((r) => r.name === GOOGLE_TRANSLATION_EXTERNAL_SECRET);
        const before = await read();
        if (!before) throw errValidation(`${namespace} holds no ExternalSecret ${GOOGLE_TRANSLATION_EXTERNAL_SECRET} — the app's chart does not render the settings yet, so they reach no engine. The entry stands in Vault and is read once the chart renders it.`);
        await clusterReader.refreshExternalSecret(namespace, GOOGLE_TRANSLATION_EXTERNAL_SECRET);
        const budgetMs = ports.refreshWaitMs ?? 2 * 60_000;
        const deadline = Date.now() + budgetMs;
        for (;;) {
          const now = await read();
          // ESO wrote the Secret again once refreshTime moved past the one read before the request.
          if (now?.ready && now.refreshTime !== "" && now.refreshTime !== before.refreshTime) break;
          if (Date.now() >= deadline || ctx.signal.aborted) {
            throw errValidation(`${GOOGLE_TRANSLATION_EXTERNAL_SECRET} in ${namespace} was not written again within ${Math.round(budgetMs / 1000)}s of the refresh request (${now?.ready ? "Ready" : `not Ready: ${now?.reason || "no reason given"}`}), so the engine was not restarted: it would start on the settings it read before. Read the ExternalSecret in ${namespace} for what ESO says, then retry this step.`);
          }
          await sleep(ports.refreshPollMs ?? 2_000, ctx.signal);
        }
        ctx.log("meta", `${GOOGLE_TRANSLATION_EXTERNAL_SECRET} written again in ${namespace} from the entry`);
      },
    },
    {
      name: "restart-workloads",
      title: "Roll the app's workloads so its engine reads the new settings",
      run: async (ctx) => {
        const tc = standingApp(ctx.db, p.tenantId, p.app);
        const namespace = memberNamespace(tc.guid, p.app, tc.stage);
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        const stampedAt = new Date().toISOString();
        const rolled = await clusterReader.restartWorkloads(namespace, stampedAt);
        ctx.checkpoint({ rolled, stampedAt });
        ctx.log("meta", rolled > 0
          ? `${rolled} workload(s) rolled in ${namespace} (${stampedAt}) — the new pods read the settings as they stand now`
          : `${namespace} has no workload to roll — a suspended tenant renders none, and its engine reads the settings when it resumes`);
      },
    },
  ];
}

export function makeTenantSetGoogleTranslationDef(ports: TenantSetGoogleTranslationPorts): RunDefinition<TenantSetGoogleTranslationParams> {
  return {
    kind: "tenant-set-google-translation",
    paramsSchema: TenantSetGoogleTranslationParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = standingApp(db, params.tenantId, params.app);
      const entry = entryOf(tc, params.app);
      const typed = listSecretWrites(db, entry).filter((w) => w.act === "set").sort((a, b) => b.writtenAt.getTime() - a.writtenAt.getTime())[0];
      const steps = tenantSetGoogleTranslationSteps(ports, params);
      return {
        kind: "tenant-set-google-translation",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `Set the Google translation settings of app "${params.app}" of tenant ${tc.guid} (${tc.domain}, ${tc.stage}): ` +
          `what you type replaces all four properties of ${entry}, ESO writes the app's Secret again, and the app's workloads are rolled so its engine translates with them. ` +
          (typed ? `Settings typed by run ${typed.runId} at ${typed.writtenAt.toISOString()} stand there now and are replaced. ` : "No settings were typed for this app yet, so its engine translates with none. ") +
          "A blank location means global, and a blank glossary means none.",
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: REQUIRED.map(secretKey),
        optionalSecrets: OPTIONAL.map(secretKey),
        secretHints: {
          [secretKey("project")]: "The ID of the Google Cloud project the Translation API is enabled in.",
          [secretKey("service-account")]: "The whole JSON key file of a service account that may call the Translation API in that project.",
          [secretKey("location")]: "The region translations run in. Blank means global. With a glossary, the plugin uses us-central1.",
          [secretKey("glossary")]: "The ID of a glossary in that project. Blank means none.",
        },
      };
    },
    steps: (params) => tenantSetGoogleTranslationSteps(ports, params),
  };
}
