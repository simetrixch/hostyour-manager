import type { DbHandle } from "../db/client.ts";
import type { Config } from "../kernel/config.ts";
import type { CredentialStore, KeystoreMode } from "../security/store.ts";
import { registerSecret, unregisterScope, redact } from "../security/redact.ts";
import type { RunEventBus } from "../executor/bus.ts";
import type { RunDefinitions } from "../domains/runs/run-definitions.ts";
import { assertGuardsArmed } from "../executor/guards.ts";
import { RUN_FAMILY, RUN_KIND, type RunFamily, type RunKind } from "../../shared/enums.ts";
import { reconcileLocks } from "../executor/locks.ts";
import { renderForbidden } from "../domains/access/forbidden.ts";
import { SessionCodec } from "../domains/access/session.ts";
import { readReleaseTagFilter, assertMirrorsReleaseGrammar } from "../domains/inventory/release-grammar.ts";
import type { PlatformRepo } from "../adapters/git/port.ts";
import { spaBytes } from "../http/spa.ts";
import type { ReadyzView } from "../../shared/api-types.ts";

export interface CheckResult {
  name: string;
  /** `blocking` aborts boot, `degrading` is reported and boot goes on, `skipped` states that the check
   *  had nothing to measure and why. A skipped check is never a pass: `ok` stays false, and readinessOf
   *  leaves it off /readyz rather than showing a green light for a measurement that did not happen. */
  kind: "blocking" | "degrading" | "skipped";
  ok: boolean;
  detail: string | undefined;
}

const ROLLBACK = Symbol("rollback");

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function checkIntegrity(sqlite: DbHandle["sqlite"]): void {
  if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("foreign_keys is not ON");
  const integrity = sqlite.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`integrity_check: ${String(integrity)}`);
}

// Assert the append-only triggers exist AND fire (a migration must never silently drop
// them). Probe audit (no FK deps) inside a rolled-back transaction — RAISE(ABORT) aborts
// the statement, not the tx, so we can probe then throw ROLLBACK to undo the sentinel.
function checkAppendOnly(sqlite: DbHandle["sqlite"]): void {
  const wanted = ["events_no_update", "events_no_delete", "audit_no_update", "audit_no_delete"];
  const present = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((r) => r.name),
  );
  for (const t of wanted) if (!present.has(t)) throw new Error(`append-only trigger missing: ${t}`);

  const probe = sqlite.transaction(() => {
    sqlite.prepare("INSERT INTO audit (id, actor, action) VALUES ('aud__selfcheck','system','__selfcheck__')").run();
    let raised = false;
    try {
      sqlite.prepare("UPDATE audit SET action='x' WHERE id='aud__selfcheck'").run();
    } catch {
      raised = true;
    }
    if (!raised) throw new Error("audit append-only trigger did not fire");
    throw ROLLBACK;
  });
  try {
    probe();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

function checkPublicUrlDerived(config: Config): void {
  const expected = new URL("/auth/callback", config.publicUrl).toString();
  if (config.redirectUri !== expected) throw new Error(`redirectUri not derived from PUBLIC_URL: ${config.redirectUri}`);
  if (config.cookieSecure !== (new URL(config.publicUrl).protocol === "https:")) {
    throw new Error("cookieSecure not derived from PUBLIC_URL protocol");
  }
}

function checkStoreMode(store: CredentialStore): void {
  const mode: KeystoreMode = store.mode();
  if (mode !== "plaintext" && mode !== "passphrase" && mode !== "keyfile" && mode !== "vault") {
    throw new Error(`unknown keystore.mode: ${String(mode)}`);
  }
  // 'plaintext' arms the persistent UI banner + the crypto gate (surfaced on
  // ClustersView.storeMode). 'keyfile'/'vault' are secured: the credential value is encrypted at
  // rest, locally under a data key or by Vault. The check asserts the mode is set and known.
}

function checkRedactCanary(): void {
  const canary = "redact-canary-d0n0tl0g";
  registerSecret("__selfcheck_canary__", Buffer.from(canary));
  try {
    if (redact(`before ${canary} after`).includes(canary)) throw new Error("redactor did not mask the canary");
  } finally {
    unregisterScope("__selfcheck_canary__");
  }
}

function checkSseEcho(bus: RunEventBus): void {
  let received = false;
  const unsub = bus.subscribe("__selfcheck__", () => {
    received = true;
  });
  bus.publish("__selfcheck__", { seq: 0, stream: "meta", text: "echo", at: 0 });
  unsub();
  if (!received) throw new Error("bus subscribe→publish→receive failed");
}

function checkLocksRebuilt(db: DbHandle): void {
  reconcileLocks(db.db); // repairs orphaned locks; only a DB error throws
}

function checkGuardsArmed(runDefinitions: RunDefinitions): void {
  assertGuardsArmed(runDefinitions);
}

/**
 * The run kind list is TOTAL over the run families (shared/enums.ts RUN_FAMILY): every RUN_KIND literal
 * belongs to exactly one family, and every family this boot registered it registered WHOLE. Blocking,
 * because half a family is a run kind the UI offers, the plan route accepts and nothing can execute — the
 * operator finds it, asks for it, and only then learns the plan route answers "unknown run kind".
 *
 * A WHOLLY absent family is a configuration, not a fault: buildUnits returns no defs for a family
 * whose adapters are unset (wire-units.ts), and its routes answer 501 NOT_CONFIGURED, so the boot
 * is honest about what it does not offer. Asserting a definition for every literal instead would abort
 * a manager running with onboarding off.
 *
 * The grouping is NOT a list of kinds that may be missing: a run kind added to a family with no definition
 * behind it leaves that family half-registered and fails this check, and a run kind in no family fails it
 * outright. What may vary per boot is which families are wired, never which run kinds a family has.
 */
function checkRunDefinitionsTotal(runDefinitions: RunDefinitions): void {
  const claimedBy = new Map<RunKind, RunFamily>();
  for (const family of Object.keys(RUN_FAMILY) as RunFamily[]) {
    const kinds: readonly RunKind[] = RUN_FAMILY[family];
    for (const kind of kinds) {
      const owner = claimedBy.get(kind);
      if (owner !== undefined) throw new Error(`RUN_KIND literal in two run families: ${kind} (${owner}, ${family})`);
      claimedBy.set(kind, family);
    }
  }
  const unclaimed = RUN_KIND.filter((kind) => !claimedBy.has(kind));
  if (unclaimed.length > 0) throw new Error(`RUN_KIND literals in no run family: ${unclaimed.join(", ")}`);
  for (const family of Object.keys(RUN_FAMILY) as RunFamily[]) {
    const kinds: readonly RunKind[] = RUN_FAMILY[family];
    const missing = kinds.filter((kind) => !runDefinitions.has(kind));
    if (missing.length > 0 && missing.length < kinds.length) {
      throw new Error(`run family ${family} is half-registered, missing: ${missing.join(", ")}`);
    }
  }
}

/**
 * Every run kind this database STORES is one this process can name. `runs.kind` is a plain text
 * column with no CHECK (server/db/schema/runs.ts), so nothing in SQLite stops a row standing under a
 * spelling RUN_KIND has since dropped — which is exactly what a data migration over that column
 * leaves behind when it misses one. Such a row reads back on the runs list under a kind no filter,
 * no label and no definition knows, and nothing else in this process would ever say so.
 *
 * Degrading, not blocking: a row spelled the old way is a fact about history that no boot can undo,
 * and aborting over it would take away the very screens an operator would inspect it from. It is
 * named on /readyz instead, with every unknown spelling listed rather than counted.
 */
function checkStoredRunKinds(sqlite: DbHandle["sqlite"]): void {
  const members = new Set<string>(RUN_KIND);
  const stored = (sqlite.prepare("SELECT DISTINCT kind FROM runs").all() as { kind: string }[]).map((r) => r.kind);
  const unknown = stored.filter((kind) => !members.has(kind)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `runs rows stand under ${unknown.length} run kind(s) this build cannot name: ${unknown.join(", ")} — ` +
      "a migration over runs.kind did not reach them, so those runs answer to no filter, label or definition",
    );
  }
}

function checkForbiddenBytes(config: Config): void {
  const html = renderForbidden({ group: config.oidc.adminsGroup, signoutUrl: "/auth/logout" });
  if (html.length < 100 || !html.includes(config.oidc.adminsGroup)) {
    throw new Error("forbidden document is empty or missing the admins group");
  }
}

/**
 * Boot self-checks. `blocking` failures abort boot; `degrading` render on
 * /readyz and never block (LAW 0). Only the checks whose dependencies exist today are
 * registered here — the rest are added with their modules (D/F/G/I), never faked.
 */
export function runSelfChecks(deps: {
  db: DbHandle;
  config: Config;
  store: CredentialStore;
  bus: RunEventBus;
  runDefinitions: RunDefinitions;
}): CheckResult[] {
  const results: CheckResult[] = [];
  const blocking = (name: string, fn: () => void): void => {
    try {
      fn();
      results.push({ name, kind: "blocking", ok: true, detail: undefined });
    } catch (e) {
      results.push({ name, kind: "blocking", ok: false, detail: messageOf(e) });
    }
  };
  const degrading = (name: string, fn: () => void): void => {
    try {
      fn();
      results.push({ name, kind: "degrading", ok: true, detail: undefined });
    } catch (e) {
      results.push({ name, kind: "degrading", ok: false, detail: messageOf(e) });
    }
  };
  blocking("db.integrity", () => checkIntegrity(deps.db.sqlite));
  blocking("db.append_only", () => checkAppendOnly(deps.db.sqlite));
  blocking("publicUrl.derived", () => checkPublicUrlDerived(deps.config));
  blocking("store.mode_banner", () => checkStoreMode(deps.store));
  blocking("redact.canary", () => checkRedactCanary());
  blocking("sse.echo", () => checkSseEcho(deps.bus));
  blocking("locks.rebuilt", () => checkLocksRebuilt(deps.db));
  blocking("guards.armed", () => checkGuardsArmed(deps.runDefinitions));
  blocking("run-definitions.total", () => checkRunDefinitionsTotal(deps.runDefinitions));
  blocking("forbidden.bytes", () => checkForbiddenBytes(deps.config));
  degrading("runs.kinds_known", () => checkStoredRunKinds(deps.db.sqlite));
  degrading("oidc.config_present", () => {
    // Presence only — discovery stays lazy (LAW 0: a down IdP must never block boot).
    if (!deps.config.oidc.issuer || !deps.config.oidc.clientId) throw new Error("OIDC issuer/clientId not configured");
  });
  degrading("spa.bytes", () => {
    // Degrading, not blocking: dev boots without a build (the SPA route then answers 503).
    if (spaBytes() === 0) throw new Error("SPA bundle not built (run npm run build:web)");
  });
  // session.roundtrip is async → runAsyncSelfChecks (jose). (A kubeconfig-readable check was once
  // planned here; it died with the mounted-kubeconfig design — kube access is in-cluster via the
  // pod ServiceAccount now, with nothing to probe at boot.)
  return results;
}

/**
 * The release grammar the Manager enforces against the build plane's copy of it: RELEASE_TAG_RE
 * (shared/release.ts), which validates the `release:` pin of every cluster map, against
 * global.releaseTagFilter in the platform repo's platform/values-common.yaml, which the image-builder
 * Trigger fires on and the release pipeline re-verifies. Two literals in two repositories, neither
 * derived from the other — see domains/inventory/release-grammar.ts for what a byte between them costs.
 * A running Manager with the platform repo configured is the only place both sides are present, so
 * it is the only place the question can be answered, which is why the check is here and not in a test.
 *
 * DEGRADING rather than blocking, for the reason LAW 0 states at the OIDC check: this one reaches a
 * REMOTE. A git that is unreachable, slow or momentarily inconsistent would otherwise abort the boot of
 * a Manager whose only fault is that it cannot read a file right now, and a Manager image older
 * than the platform trunk would refuse to start on a grammar change instead of serving the clusters,
 * consumers and tenants that have nothing to do with release tags. What a drift costs is a class of TAG
 * the two sides disagree about — worth a red line on /readyz and a boot warning naming both literals,
 * not a Manager that is down.
 *
 * Without a platform repo there is no second side, so the check SKIPS and says so. Reporting `ok` there
 * would be a green light for a comparison that never ran — the one outcome a drift check must not have.
 */
async function checkReleaseGrammarMirror(platformRepo: PlatformRepo | undefined): Promise<CheckResult> {
  const name = "release.grammar_mirror";
  if (!platformRepo) {
    return {
      name,
      kind: "skipped",
      ok: false,
      detail: "the platform repo is not configured on this manager — the build plane's copy of the release grammar cannot be read, so nothing was compared",
    };
  }
  try {
    assertMirrorsReleaseGrammar(await readReleaseTagFilter(platformRepo));
    return { name, kind: "degrading", ok: true, detail: undefined };
  } catch (e) {
    return { name, kind: "degrading", ok: false, detail: messageOf(e) };
  }
}

/** Async checks (jose is Promise-based, the platform-repo read is a git fetch). Run after
 *  runSelfChecks; results concat. `platformRepo` is optional exactly as the wiring has it —
 *  wire-units.ts builds the port only with config.github and a books branch behind it. */
export async function runAsyncSelfChecks(deps: { db: DbHandle; config: Config; platformRepo?: PlatformRepo }): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const codec = new SessionCodec(deps.db.db, deps.config);
    const token = await codec.mint({ sub: "op_selfcheck", groups: [deps.config.oidc.adminsGroup], via: "oidc" });
    const verdict = await codec.verify(token);
    if (verdict.kind !== "ok") throw new Error("session mint→verify roundtrip failed");
    results.push({ name: "session.roundtrip", kind: "blocking", ok: true, detail: undefined });
  } catch (e) {
    results.push({ name: "session.roundtrip", kind: "blocking", ok: false, detail: messageOf(e) });
  }
  results.push(await checkReleaseGrammarMirror(deps.platformRepo));
  return results;
}

/** What /readyz answers: 503 while a BLOCKING check is red (a degrading one never takes the process
 *  out of rotation), and the name+verdict of every check that MEASURED something. A skipped check is
 *  left out — listed green it would claim a measurement that did not happen, listed red it would
 *  alarm on a configuration this platform supports. Its detail is said once, in the boot log. */
export function readinessOf(checks: CheckResult[]): ReadyzView {
  return {
    ok: checks.every((c) => c.kind !== "blocking" || c.ok),
    checks: checks.filter((c) => c.kind !== "skipped").map((c) => ({ name: c.name, ok: c.ok })),
  };
}

export function assertBlockingChecksPass(results: CheckResult[]): void {
  const failed = results.filter((r) => r.kind === "blocking" && !r.ok);
  if (failed.length > 0) {
    throw new Error(`blocking self-checks failed: ${failed.map((f) => `${f.name} (${String(f.detail)})`).join("; ")}`);
  }
}
