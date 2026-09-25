// EVERY STEP MAY PROBE BEFORE THE APPROVE (hostyour-manager#207): a read-only twin of its run()
// that measures what the step will meet — a DNS zone and its token, a repository's hooks, a
// registry's identities, a Vault path's capabilities — and answers findings in the shape the slave
// preflight already reports (shared/preflight.ts PreflightCheck). The planner runs every probe of
// the definition's steps in order, logs each finding, freezes them into the plan and REFUSES the
// plan where a hard finding failed, naming it. What a probe cannot measure it leaves to the run:
// the build is proven by building, the sync by syncing.
//
// A probe gets no session, no secrets and no checkpoint: it runs before a person has handed
// anything over, against the world as the inventory and the credential store describe it, and it
// writes nothing. A probe that throws is a finding too — hard, under the step's name — because a
// measurement that could not be taken is not a measurement that passed.
import type { Db } from "../db/client.ts";
import type { CredentialStore } from "../security/store.ts";
import type { PreflightCheck } from "../../shared/preflight.ts";
import { errValidation } from "../kernel/errors.ts";
import type { Step } from "./types.ts";

export interface ProbeCtx {
  readonly db: Db;
  readonly creds: Pick<CredentialStore, "open" | "list">;
  readonly params: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  /** One line to the plan's log, the way the streaming validation reports its gates. */
  log: (line: string) => void;
}

const mark = (c: PreflightCheck): string => (c.status === "pass" ? "✓" : c.status === "warn" ? "△" : c.severity === "hard" ? "✗" : "△");

/** Run every probe the steps declare, in step order. Returns the findings; throws a validation
 *  error naming every HARD failure where one stands, after every probe has run, so the log and the
 *  frozen report carry the whole picture and not the first refusal. */
export async function runProbes(impls: readonly Step[], ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const findings: PreflightCheck[] = [];
  for (const step of impls) {
    if (!step.probe) continue;
    let found: PreflightCheck[];
    try {
      found = await step.probe(ctx);
    } catch (err) {
      found = [{ id: `${step.name}.probe`, title: step.title, severity: "hard", status: "fail", detail: err instanceof Error ? err.message : String(err) }];
    }
    for (const c of found) {
      findings.push(c);
      ctx.log(`${mark(c)} ${c.title}: ${c.detail}${c.status === "fail" && c.hint ? ` — ${c.hint}` : ""}`);
    }
  }
  const hard = findings.filter((c) => c.severity === "hard" && c.status === "fail");
  if (hard.length > 0) {
    throw errValidation(`the plan is refused by ${hard.length} finding(s) measured before the approve: ${hard.map((c) => `${c.title} (${c.detail})`).join("; ")}`);
  }
  return findings;
}
