// The onboard `activate` step. Split out of onboard.run.ts (like
// secret-mint.ts) so that file stays lean and the activation concern is a single, testable unit.
//
// It runs LAST, only when the consumer's manifest declares an `activation:` block, and calls the
// declared endpoint over the consumer's OWN public ingress with the seed-minted bootstrap token
// (`runtime.bootstrapToken`, kept in-run memory by seed-secrets — never persisted) plus the operator's
// approve-time inputs.
//
// IT WAITS FOR THE HOST FIRST. The unit's DNS record and its certificate are minutes old when this
// runs, and a call sent before both stand fails with nothing reached (`fetch failed`, measured on the
// first digita-auth onboarding of master.digitacloud.app). So the step asks the host until it answers
// over HTTPS, inside a budget, and only then makes the one call.
//
// A RETRY MINTS A NEW TOKEN. The token of the first attempt lived in that attempt's memory only, and
// a retry rebuilds the steps without it. The step's checkpoint records that THIS run minted one — the
// fact, never the value — so a retry mints a new token, merges it into the unit's Vault entry, has the
// operator's store write the Secret again and rolls the workloads (the three acts of set-secrets.run.ts),
// waits for the rollout, and activates with it. A re-onboard over an entry that stood before the run
// minted nothing, carries no such checkpoint, and keeps the one-time skip. The token rides ONLY the declared header; the returned activate_url is surfaced
// in ONE line on the live-only ephemeral stream — the only place it is ever shown — and stored nowhere.
import type { Step, StepCtx } from "../../executor/types.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { sleep } from "./onboard-release-cycle.ts";
import { mintSecretValue } from "#unit/server/secret-mint.ts";
import { errValidation } from "../../kernel/errors.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import { EPHEMERAL_STREAM } from "../../../shared/enums.ts";
// The activate_url / mail readers + the mail line live in activation-result.ts, shared with the
// tenant's create-tenant-activate.ts so both invite steps parse + surface the response identically.
import { extractActivateUrl, extractMail, mailLine } from "#unit/server/activation-result.ts";
import { consumerUnitHost } from "#unit/server/unit-dns.ts";

type Wait = { budgetMs: number; intervalMs: number };
const DEFAULT_WAIT: Wait = { budgetMs: 10 * 60_000, intervalMs: 10_000 };

/** The step's checkpoint: that THIS run minted the bootstrap token for its activation. The fact only. */
interface ActivateCheckpoint { minted: true }

/** Ask [ready] until it answers true, inside the budget; refused by [refusal] when it never does. */
async function waitFor(ready: () => Promise<boolean>, wait: Wait, signal: AbortSignal, refusal: string): Promise<void> {
  const deadline = Date.now() + wait.budgetMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline || signal.aborted) throw errValidation(refusal);
    await sleep(wait.intervalMs, signal);
  }
}

/** A new bootstrap token for a retry whose first attempt took the minted one with it: minted the way
 *  the manifest declares it, merged into the unit's Vault entry, written into the Secret again by the
 *  operator's store, read by rolled workloads — and returned once the rollout is done, because an old
 *  pod still answers with the old token until then. */
async function rotateBootstrapToken(ports: OnboardPorts, p: DeployableOnboardParams, key: string, wait: Wait, ctx: StepCtx): Promise<string> {
  const kind = p.secretSpecs?.find((s) => s.key === key)?.generate;
  if (kind !== "hex32" && kind !== "hex16" && kind !== "uuid") {
    throw errValidation(`${key} is minted as ${kind ?? "nothing"} by the manifest, not as hex32, hex16 or uuid — a retry cannot mint it again`);
  }
  const token = mintSecretValue(kind);
  await ports.seeder.patchApp({ stage: p.stage, consumerName: p.consumerName, data: { [key]: token } });
  const { clusterReader } = await ports.resolver.resolve(p.clusterId);
  const targets = [...new Set((await clusterReader.listExternalSecrets(p.namespace)).map((r) => r.targetSecret || r.name))];
  for (const name of targets) await clusterReader.deleteSecret(p.namespace, name);
  const rolled = await clusterReader.restartWorkloads(p.namespace, new Date().toISOString());
  ctx.log(
    "meta",
    `the bootstrap token this run minted went with its first attempt — a new ${key} is merged into ${p.stage}/consumer/${p.consumerName}/app ` +
      `(value withheld), ${targets.length} rendered Secret(s) deleted for the operator's store to write again, ${rolled} workload(s) rolled`,
  );
  await waitFor(() => clusterReader.workloadsRolledOut(p.namespace), wait, ctx.signal, `the workloads of ${p.consumerName} did not finish rolling out within ${wait.budgetMs / 1000}s — the new ${key} is in Vault, and a pod still serving the old one would refuse it`);
  return token;
}

/** Build the `activate` step. Closes over `runtime` (the seed-minted token) so it reads a value that
 *  was never persisted; onboardSteps appends it only when `p.activation` is set. */
export function activateStep(ports: OnboardPorts, p: DeployableOnboardParams, runtime: { bootstrapToken?: string | undefined }): Step {
  return {
    name: "activate",
    title: "Run the manifest-declared post-onboard activation",
    run: async (ctx) => {
      const act = p.activation!; // present — this step is appended only when p.activation is set
      let token = runtime.bootstrapToken;
      const minted = ctx.readCheckpoint<ActivateCheckpoint>()?.minted === true;
      if (token === undefined && !minted) {
        // No token in memory and no record that this run minted one ⇒ seed-secrets did NOT create the
        // entry in THIS run: the consumer's secrets stood before it (a re-onboard), and the first-admin
        // bootstrap is a ONE-TIME action (the endpoint is single-shot). Skip loudly rather than rotate
        // the token of a unit that may long have its administrator. Idempotent: a re-onboard stays green.
        ctx.log(
          "meta",
          `activation "${act.method} ${act.path}" skipped — the consumer's secrets stood before this run, so it minted no ` +
            `bootstrap token; first-admin activation is a one-time action.`,
        );
        return;
      }
      // The operator-supplied dynamic args (NOT secrets): collected in the clear at approve and carried
      // in the run-secrets channel under `activation-input:<field>` (never sealed, never in params).
      const body: Record<string, string> = {};
      for (const pr of act.prompt) {
        const v = ctx.secrets.get(`activation-input:${pr.field}`)?.toString("utf8");
        if (!v) throw errValidation(`activation requires operator input "${pr.field}" (${pr.label}) — it was not supplied at approve`);
        body[pr.field] = v;
      }
      if (!ports.activator) throw errValidation(`consumer "${p.consumerName}" declares an activation but no activator is wired on this manager — refusing to skip a declared activation silently`);
      const activator = ports.activator;
      const wait = ports.activationWait ?? DEFAULT_WAIT;
      if (token !== undefined) ctx.checkpoint({ minted: true } satisfies ActivateCheckpoint);
      else token = await rotateBootstrapToken(ports, p, act.tokenSecret, wait, ctx);
      // The call goes to the consumer's OWN public ingress — the unit's one host
      // <label>.<stage apex>, the same composition the admission policy pins and provision-dns
      // resolved. The token rides ONLY the declared header — never the URL/body/log.
      const url = `https://${consumerUnitHost(p.host, p.stage, p.unitApex)}${act.path}`;
      if (!(await activator.reaches(url, ctx.signal))) {
        ctx.log("meta", `waiting for ${new URL(url).origin} to answer over HTTPS — its DNS record and certificate are new`);
        await waitFor(() => activator.reaches(url, ctx.signal), wait, ctx.signal, `${new URL(url).origin} did not answer over HTTPS within ${wait.budgetMs / 1000}s — no name or no certificate yet, so the activation was not sent; retry the step once it answers`);
      }
      ctx.log("meta", `activating: ${act.method} ${url} with header ${act.tokenHeader} (token withheld)${act.prompt.length ? ` + fields ${act.prompt.map((x) => x.field).join(", ")}` : ""}`);
      const res = await activator.invoke({ url, method: act.method, tokenHeader: act.tokenHeader, token, body, signal: ctx.signal });
      // Drop the in-run token as soon as the call has consumed it (hygiene; it is GC'd with the closure
      // at run end regardless, and was never registered/persisted anywhere).
      delete runtime.bootstrapToken;
      if (!res.ok) {
        // Fail LOUD: the deployment is live + recorded, but the operator must see the activation failed
        // and why (status + body — e.g. 409 admin_exists, 404 disabled endpoint), never a quiet success.
        throw errValidation(`activation call ${act.method} ${url} failed — HTTP ${res.status}: ${res.bodyText.slice(0, 500)}`);
      }
      // Surface the result. The activate_url is a root-admin credential: it rides ONE line on the
      // EPHEMERAL stream — published to the live SSE watcher, never written to the append-only
      // events table — so it exists NOWHERE persisted: not the pointer, the inventory row, the
      // checkpoint, params, or the run log. Marked so the run screen can lift it into a copyable,
      // "shown once, not stored" callout; the persisted log keeps only the credential-free outcome.
      ctx.log("meta", `✓ activation succeeded (HTTP ${res.status})`);
      const activateUrl = extractActivateUrl(res.json);
      if (activateUrl) {
        ctx.log(EPHEMERAL_STREAM, `${ACTIVATION_RESULT_MARKER} ${activateUrl}`);
      }
      // Surface the OPTIONAL invite-mail outcome the endpoint may report alongside the
      // activate_url, so the operator sees whether the invite mail was actually delivered right next to
      // the link. Absent field ⇒ no line at all (fully backward-compatible with a response that carries
      // no mail object, or a consumer/older build that never sends one).
      const mail = extractMail(res.json);
      if (mail) ctx.log("meta", mailLine(mail));
    },
  };
}
