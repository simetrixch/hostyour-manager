import type { DbHandle } from "../db/client.ts";
import type { Config } from "../kernel/config.ts";
import type { CredentialStore, KeystoreMode } from "../security/store.ts";
import { registerSecret, unregisterScope, redact } from "../security/redact.ts";
import type { RunEventBus } from "../executor/bus.ts";
import type { Registry } from "../domains/runs/registry.ts";
import { assertGuardsArmed } from "../executor/guards.ts";
import { RUN_FAMILY, RUN_KIND, type RunFamily, type RunKind } from "../../shared/enums.ts";
import { reconcileLocks } from "../executor/locks.ts";
import { renderForbidden } from "../domains/access/forbidden.ts";
import { SessionCodec } from "../domains/access/session.ts";
import { spaBytes } from "../http/spa.ts";

export interface CheckResult {
  name: string;
  kind: "blocking" | "degrading";
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

function checkGuardsArmed(registry: Registry): void {
  assertGuardsArmed(registry);
}

/**
 * The verb list is TOTAL over the run families (shared/enums.ts RUN_FAMILY): every RUN_KIND literal
 * belongs to exactly one family, and every family this boot registered it registered WHOLE. Blocking,
 * because half a family is a verb the UI offers, the plan route accepts and nothing can execute — the
 * operator finds it, asks for it, and only then learns the plan route answers "unknown run kind".
 *
 * A WHOLLY absent family is a configuration, not a fault: buildOnboarding returns no defs for a family
 * whose adapters are unset (wire-onboarding.ts), and its routes answer 501 NOT_CONFIGURED, so the boot
 * is honest about what it does not offer. Asserting a definition for every literal instead would abort
 * a controller running with onboarding off.
 *
 * The grouping is NOT a list of kinds that may be missing: a verb added to a family with no definition
 * behind it leaves that family half-registered and fails this check, and a verb in no family fails it
 * outright. What may vary per boot is which families are wired, never which verbs a family has.
 */
function checkRegistryTotal(registry: Registry): void {
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
    const missing = kinds.filter((kind) => !registry.has(kind));
    if (missing.length > 0 && missing.length < kinds.length) {
      throw new Error(`run family ${family} is half-registered, missing: ${missing.join(", ")}`);
    }
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
  registry: Registry;
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
  blocking("guards.armed", () => checkGuardsArmed(deps.registry));
  blocking("registry.total", () => checkRegistryTotal(deps.registry));
  blocking("forbidden.bytes", () => checkForbiddenBytes(deps.config));
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

/** Async blocking checks (jose is Promise-based). Run after runSelfChecks; results concat. */
export async function runAsyncSelfChecks(deps: { db: DbHandle; config: Config }): Promise<CheckResult[]> {
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
  return results;
}

export function assertBlockingChecksPass(results: CheckResult[]): void {
  const failed = results.filter((r) => r.kind === "blocking" && !r.ok);
  if (failed.length > 0) {
    throw new Error(`blocking self-checks failed: ${failed.map((f) => `${f.name} (${String(f.detail)})`).join("; ")}`);
  }
}
