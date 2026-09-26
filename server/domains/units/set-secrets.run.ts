import { z } from "zod";
import type { RunDefinition, Step, Plan, PlanStreamCtx, PlanStreamResult } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { consumerNamespace } from "../../../shared/consumer.ts";
import { ConsumerSecretSpecSchema, type ConsumerSecretSpec } from "../../../shared/consumer.ts";
import { loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import type { GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import { judgeRepoIdentity, resolveRepoIdentity, type OwnerIdentityReader, type RepoIdentityApp } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { buildConsumerSecretData } from "#unit/server/secret-mint.ts";
import { ConsumerManifestSchema, CONSUMER_MANIFEST_PATH } from "../../../shared/consumer.ts";
import type { ConsumerSecretOfferView } from "../../../shared/api-types-onboard.ts";

// "consumer-set-secrets" — change a declared secret of a STANDING consumer (hostyour-manager#245).
//
// THE GAP IT CLOSES. A consumer's secrets are written once, by the onboarding, create-only (cas=0,
// onboard-steps.ts seed-secrets): a second onboarding of something already running must never rotate
// the keys a pod read at container start. So nothing changed a value afterwards, and a key a manifest
// gained later reached a standing consumer not at all — the operator edited Vault by hand, deleted
// the rendered Secret and ran consumer-restart-workloads, two of those three acts outside the
// product.
//
// THE THREE STEPS ARE THE THREE ACTS, in the one order that works. Writing Vault alone changes
// nothing a pod can see: every ExternalSecret of this platform carries refreshPolicy OnChange and
// refreshInterval "0" (hostyour-cloud charts/external-secret/templates/externalsecret.yaml), so ESO
// fetches again only when its target Secret is gone; and a pod reads its env vars once, at start, so
// the Secret changing under it moves nothing until the workload rolls.
//
// THE MANAGER NEVER READS WHAT IT DOES NOT CHANGE. The write is a KV v2 merge-patch (seeder
// patchApp): the keys the operator filled travel, Vault merges them into the stored entry
// server-side, and the values not named stay as they are — unseen. That is why the manager policy
// carries `patch` on this one leaf and no `read` (hostyour-deploy deploy-platform-services.yaml).
//
// WHICH KEYS ARE OFFERED comes from the MANIFEST, read at plan time from the consumer's repository —
// not from the frozen onboard params and not from Vault. That is what makes a key ADDED since the
// onboarding reachable at all, which is the case this run kind exists for; and it is the only place
// that says what each value is (its `description`, rendered as the field's hint, #244).
//
// EVERY KEY IS OPTIONAL at approve: a blank one is not sent, so it keeps its stored value. A run
// that sends nothing is refused at the write rather than patching an empty document.
//
// A `generate` KEY IS MINTED ONLY WHERE IT IS NAMED (#285). The Manager cannot ask Vault which keys
// the entry holds, so it cannot tell a key the manifest gained from one the onboarding minted; minting
// every generate key would rotate the ones something already reads. The request names the keys to
// mint (the Secrets dialog's ticks, none by default), the plan warns that each one rotates a value
// the entry may hold, and the onboarding's own mint (secret-mint.ts) writes them in the same patch.
//
// mutating: true ⇒ attest-target is step 0 (guards.assertGuardsArmed).

export const SetSecretsParams = z.object({
  appId: z.string().startsWith("app_"),
  /** The declared keys the operator answers, frozen from the manifest read at plan time. */
  keys: z.array(ConsumerSecretSpecSchema.shape.key),
  /** The generate keys the request named, each frozen with its declared kind: what the plan showed
   *  is what is minted, whatever the manifest says by the time the run is approved. */
  mint: z.array(ConsumerSecretSpecSchema).default([]),
});
export type SetSecretsParams = z.infer<typeof SetSecretsParams>;

/** The prefix every offered key rides under through approve — the same one the onboarding uses, so
 *  the approve form labels and hints them identically (approveFields.ts, #244). */
export const CONSUMER_SECRET_PREFIX = "consumer-secret:";

export interface SetSecretsPorts extends LifecyclePorts {
  /** The merge write into `<stage>/consumer/<name>/app`. */
  seeder: VaultSeeder;
  /** The repository read the plan makes: the consumer's manifest, through the owner's identity. */
  github: Pick<GitHubConsumer, "readFile">;
  /** The sealed credentials the owner's identity is opened from (repo-identity.ts); which identity
   *  reads this repository is resolved per read, the App riding the lifecycle ports. */
  store: Pick<CredentialStore, "open" | "list">;
}

/** What reads a consumer's manifest: the GitHub client and the owner's identity it reads with. */
export type ManifestReadPorts = Pick<SetSecretsPorts, "github" | "store" | "githubApp">;

/** WHAT THE REPOSITORY DECLARES NOW — the manifest at the default branch's head, read through the
 *  owner's identity, never the params frozen at onboarding: a key added since then is exactly what
 *  this run kind exists to carry. Refuses in the owner's words where no identity reads the
 *  repository or the manifest does not parse. */
async function readDeclaredSecrets(ports: ManifestReadPorts, owners: OwnerIdentityReader, repoURL: string, signal?: AbortSignal): Promise<{ outcome: "read"; secrets: ConsumerSecretSpec[]; dkimKey?: string } | { outcome: "refused"; why: string }> {
  const { owner, repo } = parseGitHubOwnerRepo(repoURL);
  const judged = await judgeRepoIdentity({ repoURL, ...(ports.githubApp ? { githubApp: ports.githubApp as RepoIdentityApp } : {}), owners, ...(signal ? { signal } : {}) });
  if ("refused" in judged) return { outcome: "refused", why: judged.refused };
  const identity = await resolveRepoIdentity({ repoURL, ...(ports.githubApp ? { githubApp: ports.githubApp as RepoIdentityApp } : {}), owners, store: ports.store, ...(signal ? { signal } : {}) });
  const text = await ports.github.readFile({ owner, repo, path: CONSUMER_MANIFEST_PATH, token: identity.token, ...(signal ? { signal } : {}) });
  if (text === null) return { outcome: "refused", why: `${repoURL} carries no ${CONSUMER_MANIFEST_PATH}` };
  const parsed = ConsumerManifestSchema.safeParse(parseYaml(text));
  if (!parsed.success) return { outcome: "refused", why: `${CONSUMER_MANIFEST_PATH} of ${repoURL} failed its schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const dkimKey = parsed.data.smtpEntry?.dkimKey;
  return { outcome: "read", secrets: parsed.data.secrets, ...(dkimKey ? { dkimKey } : {}) };
}

/** The repository the consumer was onboarded from — the row's own field, the one this run reads the
 *  manifest of. A build-only unit has none and never reaches this run kind (it holds no namespace). */
function repoUrlOf(db: Db, appId: string): string {
  const row = db.select({ repoUrl: apps.repoUrl }).from(apps).where(eq(apps.id, appId)).get();
  if (!row?.repoUrl) throw errValidation(`app ${appId} records no repository URL — nothing says which manifest declares its secrets`);
  return row.repoUrl;
}

/** What the Secrets dialog offers for one consumer, read off its manifest as the plan reads it. */
export async function readSecretOffer(ports: ManifestReadPorts, db: Db, appId: string, signal?: AbortSignal): Promise<ConsumerSecretOfferView> {
  const read = await readDeclaredSecrets(ports, (org) => readOwnerIdentity(db, org), repoUrlOf(db, appId), signal);
  if (read.outcome === "refused") throw errValidation(read.why);
  return {
    operatorKeys: operatorKeys(read.secrets).map((s) => ({ key: s.key, ...(s.description ? { description: s.description } : {}) })),
    generateKeys: read.secrets.flatMap((s) => (s.generate ? [{ key: s.key, kind: s.generate }] : [])),
  };
}

/** Why the generate keys a request names cannot be minted by this run, or null where they can: a
 *  name the manifest declares as no generate key, a key derived from the repository PAT (this run
 *  holds none), half of a keypair, whose other half would then no longer match it, and the SMTP
 *  entry's DKIM key, whose public half the Manager publishes in DNS from the row the onboarding wrote:
 *  a new private key would sign mail the published record no longer verifies. */
function refuseMint(names: readonly string[], declared: readonly ConsumerSecretSpec[], dkimKey?: string): string | null {
  const generate = declared.filter((s) => s.generate);
  const unknown = names.filter((n) => !generate.some((s) => s.key === n));
  if (unknown.length > 0) return `it declares no generate key ${unknown.join(", ")} — the keys it mints are ${generate.map((s) => s.key).join(", ") || "none"}`;
  const derived = generate.filter((s) => names.includes(s.key) && s.generate === "deploy-git-credentials");
  if (derived.length > 0) return `${derived.map((s) => s.key).join(", ")} is derived from the repository PAT the onboarding sealed, and this run derives nothing`;
  if (dkimKey !== undefined && names.includes(dkimKey)) return `${dkimKey} is the DKIM key of its SMTP entry, and its public half stands in DNS as the onboarding published it — minting it again would sign mail that record no longer verifies`;
  for (const pub of generate.filter((s) => s.generate === "rsa2048-public")) {
    if (pub.pairWith && names.includes(pub.key) !== names.includes(pub.pairWith)) return `${pub.pairWith} and ${pub.key} are one keypair: mint both or neither`;
  }
  return null;
}

function setSecretsSteps(ports: SetSecretsPorts, p: SetSecretsParams): Step[] {
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, p.appId);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        const state = await clusterReader.readDeployState();
        if (!state) throw errValidation(`cluster ${ac.domain} carries no deploy-state — it is not a cluster this manager deployed, or the mark was removed`);
        ctx.log("meta", `cluster ${ac.domain} attested for ${ac.name} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "write-secrets",
      title: "Merge the supplied values into the consumer's Vault entry",
      run: async (ctx) => {
        // Only what the operator actually filled: an empty box is not an answer, it is "leave this
        // one as it is". The values are read out of the run's in-memory secrets and never logged.
        const data: Record<string, string> = {};
        for (const key of p.keys) {
          const value = ctx.secrets.get(`${CONSUMER_SECRET_PREFIX}${key}`)?.toString("utf8");
          if (value !== undefined && value !== "") data[key] = value;
        }
        // The named generate keys, minted and verified by the onboarding's own mint, ride the same
        // patch. Their names are logged below; their values never are.
        const minted = p.mint.length > 0 ? buildConsumerSecretData(p.mint, () => undefined).data : {};
        Object.assign(data, minted);
        const keys = Object.keys(data);
        if (keys.length === 0) throw errValidation("no value was supplied — every box was left empty and no key is minted, so there is nothing to change");
        const ac = loadAppCluster(ctx.db, p.appId);
        await ports.seeder.patchApp({ stage: ac.stage, consumerName: ac.name, data });
        ctx.checkpoint({ keys });
        ctx.log("meta", `${keys.length} secret(s) of ${ac.name} merged into ${ac.stage}/consumer/${ac.name}/app: ${keys.join(", ")}${p.mint.length > 0 ? ` (minted new: ${Object.keys(minted).join(", ")})` : ""} — every other value of the entry is untouched and was not read`);
      },
    },
    {
      name: "refetch-secrets",
      title: "Delete the rendered Secrets so the operator's store fetches them again",
      run: async (ctx) => {
        // ESO fetches on change of the ExternalSecret and when its target Secret is missing — never
        // on a timer (refreshInterval "0"). The targets are read off the namespace's own
        // ExternalSecrets rather than guessed: a consumer's chart names its Secret, not the platform.
        const ac = loadAppCluster(ctx.db, p.appId);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        const namespace = consumerNamespace(ac.name, ac.stage);
        const rows = await clusterReader.listExternalSecrets(namespace);
        const targets = [...new Set(rows.map((r) => r.targetSecret || r.name))];
        for (const name of targets) await clusterReader.deleteSecret(namespace, name);
        ctx.checkpoint({ targets });
        ctx.log(
          "meta",
          targets.length > 0
            ? `${targets.length} Secret(s) deleted in ${namespace} (${targets.join(", ")}) — the operator's store writes each one again from Vault`
            : `${namespace} holds no ExternalSecret — nothing renders the entry into a Secret, and the new values reach no pod`,
        );
      },
    },
    {
      name: "restart-workloads",
      title: "Roll the consumer's workloads so their pods read the new values",
      run: async (ctx) => {
        // The third act: an env var is materialized once, at container start (restart-workloads.run.ts).
        const ac = loadAppCluster(ctx.db, p.appId);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        const stampedAt = new Date().toISOString();
        const rolled = await clusterReader.restartWorkloads(consumerNamespace(ac.name, ac.stage), stampedAt);
        ctx.checkpoint({ rolled, stampedAt });
        ctx.log(
          "meta",
          rolled > 0
            ? `${rolled} workload(s) of ${ac.name} rolled on ${ac.domain} (${stampedAt}) — the new pods read the values as they stand now`
            : `${ac.name} has no workload on ${ac.domain} to roll — a suspended consumer renders none, and the new values are read when it resumes`,
        );
      },
    },
  ];
}

/** The keys a plan offers: every declared key the OPERATOR answers — a `generate` key is the
 *  Manager's to mint and is never asked for, at onboarding or here. */
export function operatorKeys(specs: readonly ConsumerSecretSpec[]): ConsumerSecretSpec[] {
  return specs.filter((s) => !s.generate);
}

export function makeSetSecretsDef(ports: SetSecretsPorts): RunDefinition<SetSecretsParams> {
  return {
    kind: "consumer-set-secrets",
    paramsSchema: SetSecretsParams,
    mutating: true,
    plan: () => {
      throw new Error("consumer-set-secrets is planned via planStream (the manifest is read first), not plan()");
    },
    // Streaming planner: the manifest of the STANDING consumer is read first, because which keys
    // exist is its answer and may have grown since the onboarding.
    planStream: async (rawParams, ctx: PlanStreamCtx): Promise<PlanStreamResult<SetSecretsParams>> => {
      const req = z.object({ appId: z.string().startsWith("app_"), mint: z.array(z.string()).default([]) }).parse(rawParams);
      const ac = loadAppCluster(ctx.db, req.appId);
      const repoURL = repoUrlOf(ctx.db, req.appId);
      const read = await readDeclaredSecrets(ports, (org) => readOwnerIdentity(ctx.db, org), repoURL, ctx.signal);
      if (read.outcome === "refused") {
        return { outcome: "rejected", summary: `The secrets of "${ac.name}" cannot be changed — ${read.why}`, planJson: { consumerName: ac.name } };
      }
      const refused = refuseMint(req.mint, read.secrets, read.dkimKey);
      if (refused) {
        return { outcome: "rejected", summary: `"${ac.name}" cannot mint what this request names — ${refused}`, planJson: { consumerName: ac.name } };
      }
      const offered = operatorKeys(read.secrets);
      const mint = read.secrets.filter((s) => s.generate && req.mint.includes(s.key));
      if (offered.length === 0 && mint.length === 0) {
        return { outcome: "rejected", summary: `"${ac.name}" declares no secret its operator supplies, and this request mints none — there is nothing to change`, planJson: { consumerName: ac.name } };
      }
      const params: SetSecretsParams = { appId: req.appId, keys: offered.map((s) => s.key), mint };
      const entry = `${ac.stage}/consumer/${ac.name}/app`;
      const stepDefs = setSecretsSteps(ports, params);
      const plan: Plan = {
        kind: "consumer-set-secrets",
        targetKind: "app",
        targetId: req.appId,
        summary:
          `Change the secrets of consumer "${ac.name}" on ${ac.domain} (${ac.stage}): every value you fill is merged into ${entry}, ` +
          `the rendered Secrets are deleted so they are written again from Vault, and the workloads are rolled so their pods read the new values. ` +
          `A box left empty keeps its stored value, and every value you do not name stays unread. ${offered.length} declared key(s): ${offered.map((s) => s.key).join(", ") || "none"}.` +
          (mint.length > 0 ? ` Minted new and merged in the same write: ${mint.map((s) => `${s.key} (${s.generate})`).join(", ")}.` : ""),
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "master-kube", key: "m" }],
        // The Manager cannot ask Vault whether the entry already holds a key, so every mint is named
        // as the rotation it may be.
        warnings: mint.map((s) =>
          `${s.key} (${s.generate}) is minted new. Where ${entry} already holds ${s.key}, this rotates it, and whatever reads the old value breaks until it is updated — another consumer that holds it, or a DNS record that carries its public half.`),
        requiredSecrets: [],
        // Every key is OPTIONAL: filling one is changing it, leaving it is keeping it.
        optionalSecrets: offered.map((s) => `${CONSUMER_SECRET_PREFIX}${s.key}`),
        secretHints: Object.fromEntries(offered.filter((s) => s.description).map((s) => [`${CONSUMER_SECRET_PREFIX}${s.key}`, s.description as string])),
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => setSecretsSteps(ports, params),
  };
}
