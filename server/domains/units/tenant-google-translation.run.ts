import type { RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { GOOGLE_TRANSLATION_SECRET_PREFIX } from "../../../shared/approve.ts";
import { errValidation } from "../../kernel/errors.ts";
import { listSecretWrites, recordSecretWrites, tenantGoogleTranslationEntry } from "../../db/secret-writes.ts";
import { GOOGLE_TRANSLATION_PROPERTIES, type GoogleTranslationProperty, type VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { sleep } from "#unit/server/release-cycle.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { TenantLifecycleParams, tenantLocks, tenantWatchNamespaces } from "./tenant-lifecycle.run.ts";

// `tenant-set-google-translation` — write the Google translation settings an operator types for a
// tenant, and bring them into the engine of every app and website of it.
//
// ONE ENTRY PER TENANT. Every app's ExternalSecret reads the same entry,
// <stage>/tenants/<guid>/google-translation, so one typed key serves the whole tenant. The run reaches
// the namespaces whose chart renders that ExternalSecret, and refuses while one of them still reads
// another entry, because the engine there would restart on the settings it read before.
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

export const TenantSetGoogleTranslationParams = TenantLifecycleParams;
export type TenantSetGoogleTranslationParams = TenantLifecycleParams;

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

/** The member namespaces of the tenant whose chart renders the Google translation ExternalSecret,
 *  with its row as ESO answers it now. Refuses when none does, and when one reads an entry other
 *  than the tenant's, naming each such namespace and the entry it reads. */
async function readerNamespaces(ports: TenantSetGoogleTranslationPorts, ctx: Pick<StepCtx, "db">, tenantId: string) {
  const tc = loadTenantCluster(ctx.db, tenantId);
  const entry = tenantGoogleTranslationEntry(tc.stage, tc.guid);
  const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
  const readers: { namespace: string; refreshTime: string }[] = [];
  const elsewhere: string[] = [];
  for (const namespace of tenantWatchNamespaces(ctx.db, tenantId, tc.guid, tc.stage)) {
    const row = (await clusterReader.listExternalSecrets(namespace)).find((r) => r.name === GOOGLE_TRANSLATION_EXTERNAL_SECRET);
    if (!row) continue;
    const other = row.remoteKeys.filter((k) => k !== entry);
    if (other.length > 0) elsewhere.push(`${namespace} reads ${other.join(", ")}`);
    readers.push({ namespace, refreshTime: row.refreshTime });
  }
  if (readers.length === 0) throw errValidation(`no member namespace of tenant ${tc.guid} holds the ExternalSecret ${GOOGLE_TRANSLATION_EXTERNAL_SECRET} — no app's chart renders the settings yet, so they would reach no engine`);
  if (elsewhere.length > 0) throw errValidation(`${elsewhere.join("; ")} — not the tenant's entry ${entry}, so an engine restarted there would translate with the settings it read before. The app's chart reads the tenant's entry once digita-deploy renders it so; run this again then.`);
  return { tc, entry, clusterReader, readers };
}

function tenantSetGoogleTranslationSteps(ports: TenantSetGoogleTranslationPorts, p: TenantSetGoogleTranslationParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-settings",
      title: "Write the typed Google translation settings into the tenant's Vault entry",
      run: async (ctx) => {
        const data = readGoogleTranslationSettings((key) => ctx.secrets.get(key)?.toString("utf8"));
        const { tc, entry } = await readerNamespaces(ports, ctx, p.tenantId);
        await ports.seeder.replaceGoogleTranslation({ stage: tc.stage, guid: tc.guid, data });
        recordSecretWrites(ctx.db, { entry, keys: [...GOOGLE_TRANSLATION_PROPERTIES], act: "set", runId: ctx.runId });
        const blank = OPTIONAL.filter((o) => data[o] === "");
        ctx.log("meta", `${entry} written with ${GOOGLE_TRANSLATION_PROPERTIES.join(", ")}${blank.length > 0 ? ` (${blank.join(" and ")} left blank, so not set)` : ""}`);
      },
    },
    {
      name: "refresh-settings",
      title: "Ask ESO to write every app's Google translation Secret again, and wait until it has",
      run: async (ctx) => {
        const { clusterReader, readers } = await readerNamespaces(ports, ctx, p.tenantId);
        for (const r of readers) await clusterReader.refreshExternalSecret(r.namespace, GOOGLE_TRANSLATION_EXTERNAL_SECRET);
        const budgetMs = ports.refreshWaitMs ?? 2 * 60_000;
        const deadline = Date.now() + budgetMs;
        let waiting = readers;
        for (;;) {
          const left: typeof readers = [];
          const unready: string[] = [];
          for (const r of waiting) {
            const now = (await clusterReader.listExternalSecrets(r.namespace)).find((row) => row.name === GOOGLE_TRANSLATION_EXTERNAL_SECRET);
            // ESO wrote the Secret again once refreshTime moved past the one read before the request.
            if (now?.ready && now.refreshTime !== "" && now.refreshTime !== r.refreshTime) continue;
            left.push(r);
            unready.push(`${r.namespace} (${now?.ready ? "Ready" : `not Ready: ${now?.reason || "no reason given"}`})`);
          }
          waiting = left;
          if (waiting.length === 0) break;
          if (Date.now() >= deadline || ctx.signal.aborted) {
            throw errValidation(`${GOOGLE_TRANSLATION_EXTERNAL_SECRET} was not written again within ${Math.round(budgetMs / 1000)}s of the refresh request in ${unready.join(", ")}, so no engine was restarted: it would start on the settings it read before. Read the ExternalSecret there for what ESO says, then retry this step.`);
          }
          await sleep(ports.refreshPollMs ?? 2_000, ctx.signal);
        }
        ctx.log("meta", `${GOOGLE_TRANSLATION_EXTERNAL_SECRET} written again from the entry in ${readers.map((r) => r.namespace).join(", ")}`);
      },
    },
    {
      name: "restart-workloads",
      title: "Roll the workloads of every app that reads the settings, so its engine reads them",
      run: async (ctx) => {
        const { tc, clusterReader, readers } = await readerNamespaces(ports, ctx, p.tenantId);
        // One stamp for the whole tenant, as tenant-restart-workloads stamps it.
        const stampedAt = new Date().toISOString();
        let total = 0;
        for (const { namespace } of readers) {
          const rolled = await clusterReader.restartWorkloads(namespace, stampedAt);
          total += rolled;
          ctx.log("meta", `${namespace}: ${rolled} workload(s) rolled`);
        }
        ctx.checkpoint({ rolled: total, namespaces: readers.length, stampedAt });
        ctx.log("meta", total > 0
          ? `${total} workload(s) across ${readers.length} namespace(s) of ${tc.guid} rolled (${stampedAt}) — the new pods read the settings as they stand now`
          : `no workload to roll in the ${readers.length} namespace(s) of ${tc.guid} — a suspended tenant renders none, and its engines read the settings when it resumes`);
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
      const tc = loadTenantCluster(db, params.tenantId);
      const entry = tenantGoogleTranslationEntry(tc.stage, tc.guid);
      const typed = listSecretWrites(db, entry).filter((w) => w.act === "set").sort((a, b) => b.writtenAt.getTime() - a.writtenAt.getTime())[0];
      const steps = tenantSetGoogleTranslationSteps(ports, params);
      return {
        kind: "tenant-set-google-translation",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `Set the Google translation settings of tenant ${tc.guid} (${tc.domain}, ${tc.stage}) for every app and website of it: ` +
          `what you type replaces all four properties of ${entry}, ESO writes each app's Secret again, and the workloads of every app that reads it are rolled so its engine translates with them. ` +
          (typed ? `Settings typed by run ${typed.runId} at ${typed.writtenAt.toISOString()} stand there now and are replaced. ` : "No settings were typed for this tenant yet, so its engines translate with none. ") +
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
