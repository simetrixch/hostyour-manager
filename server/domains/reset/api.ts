import { z } from "zod";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Db } from "../../db/client.ts";
import type { Config } from "../../kernel/config.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { GitHubPlatform } from "../../adapters/github-platform/github-platform-http.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ResetResult, ResetBranchOutcome, ResetPointerOutcome } from "../../../shared/api-types.ts";
import { AppError, errValidation, errNotConfigured, errIllegalTransition, errUpstream } from "../../kernel/errors.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { wipeManagerDb, rehearseManagerDbWipe, countLiveRuns, backupManagerDb } from "../../db/reset.ts";
import { booksBranch } from "../inventory/read.ts";
import { CLUSTER_MAP_DIR } from "../../../shared/cluster-values.ts";

export interface ResetApiDeps {
  config: Config;
  db: Db; // for writeAudit (the sanctioned audit path)
  sqlite: Database.Database; // for the raw-SQL wipe transaction (db/reset.ts)
  store: CredentialStore;
  logger: Logger;
  /** Injected by wire IFF config.github is set (composition root builds the adapter). */
  github: GitHubPlatform | undefined;
  /** wire: stops the master-reconcile timer, then seedMaster (idempotent) — keeps the RUNNING
   *  pod coherent after the wipe (role=master row + self-SSH key re-materialized). */
  reseedMaster: () => Promise<void>;
}

const ResetInput = z.object({
  confirm: z.string(),
  wipeDb: z.boolean(),
  deleteBranches: z.array(z.string().min(1).max(253)).max(50),
  includeMaster: z.boolean(),
});

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// clusters/active/<fqdn>.yaml on master — the cluster map. Its file name IS the cluster's FQDN, which
// IS its install branch, so a map names the branch it belongs to with no recomposition.
const MARKING_RE = new RegExp(`^${CLUSTER_MAP_DIR}/([a-z0-9-]+(?:\\.[a-z0-9-]+)+)\\.yaml$`);

/** Serializes resets in-process (module-level on purpose; one Manager pod). */
let resetInFlight = false;

/**
 * THE destructive reset (Reset wizard backend). Removes the selected clusters' maps from master,
 * deletes their install branches on GitHub, then wipes the cluster state out of the manager DB in
 * one transaction. Deliberately NOT a Run — the executor persists runs in the very tables the wipe
 * clears, so a reset-run would erase its own log; a direct route + audit entry instead.
 *
 * THE ORDER IS THE SAFETY. Deleting a branch is the one act here that cannot be taken back: the sha
 * is captured and reported, but GitHub reaps objects no ref points at, so a sha is a chance and not
 * a promise. Everything else can be put back — the map removal is a commit on master and stays in
 * its history, and the wipe is one transaction with a file backup taken in front of it. So every
 * step that can still refuse runs BEFORE the first branch delete:
 *   1. list the branches — no sha, no delete, because a delete with no captured sha has no way back;
 *   2. REHEARSE the wipe in a rolled-back transaction, which is where a table missing from
 *      WIPE_ORDER now stops the reset instead of throwing after the branches are already gone;
 *   3. remove the cluster maps, and refuse if that fails — a branch deleted while its map stands
 *      leaves the master's slaves-appset generating a <name>-apps Application for a dead branch.
 * Each of those three refuses the whole request with nothing removed. Then the branches go, and the
 * database half runs last — where nothing may throw: an error response after the branches are gone
 * would carry neither what went nor the shas to restore it with. So a failing wipe is REPORTED
 * (db.error, ok false) beside the branch outcomes, and the two steps behind it — the audit entry and
 * the re-seed — log their own failure instead.
 *
 * The BACKUP belongs to that last step and not to the rehearsal, even though both are database work
 * that could run early. A snapshot is only a way back if it holds what the wipe destroys, and every
 * step between yields the event loop to writers this route does not serialize.
 *
 * What the remaining window leaves. The rehearsal cannot see a failure that arrives after it — the
 * database turning unwritable, or a row landing in a table WIPE_ORDER does not name. Then the maps
 * and branches are gone and the database is exactly the one the reset started with, because the wipe
 * is a single transaction that rolls back whole. The operator is told (db.error and the same audit
 * entry), and everything still to do is local: a second reset with only wipeDb selected RETRIES it.
 * That retry finishes the job only where the cause has passed. Where it is a straggler row, the retry
 * meets the rehearsal above and refuses again with the same message — and what clears it then is the
 * table added to WIPE_ORDER, not another attempt.
 */
export function registerResetRoutes(app: Hono<AppEnv>, deps: ResetApiDeps): void {
  app.post("/api/reset", async (c) => {
    const log = deps.logger.child({ route: "reset" });
    const operator = c.get("operator");

    // Every refusal leaves an audit trace (log-everything) BEFORE it throws.
    const refuse = (err: AppError): never => {
      writeAudit(deps.db, {
        actor: operator.sub, action: "manager.reset.refused",
        detail: { reason: err.message, via: operator.via },
      });
      throw err;
    };

    // ---- validate (all destructive action refused up-front) --------------------------------
    // Break-glass sessions are for local recovery, never remote destruction; typed "RESET" is
    // not an auth factor and a stale cookie's groups stay valid for up to 12h.
    //
    // This holds for the programmatic caller too, and holds harder: a session taken off the
    // admin.sock rests on the same non-IdP authority, and nobody typed the confirmation at all. So
    // the refusal is on `via` — the authority — and not on which door the caller arrived through,
    // which is why the audit row records the door and this line does not read it.
    if (operator.via === "emergency") {
      refuse(new AppError("NOT_A_MEMBER", "break-glass sessions cannot reset — sign in via OIDC"));
    }
    const parsed = ResetInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) refuse(errValidation(parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ")));
    const input = parsed.data!; // narrowed: refuse() returns never
    if (input.confirm !== "RESET") refuse(errValidation('confirmation failed — type "RESET" (exactly) to confirm'));
    const branches = [...new Set(input.deleteBranches)];
    if (!input.wipeDb && branches.length === 0) refuse(errValidation("nothing to reset: wipeDb is false and no branches are selected"));

    // A reset NEVER runs beside live runs — branch deletes race a deploy-slave's pushes, a wipe
    // races the executor's in-memory state (not only when wipeDb is set).
    const live = countLiveRuns(deps.sqlite);
    if (live > 0) refuse(errIllegalTransition(`cannot reset: ${live} run(s) in flight (planning/approved/running) — cancel or let them finish`));

    let gh: GitHubPlatform | undefined;
    let masterBranch: string | undefined;
    let base: string | undefined;
    if (branches.length > 0 || deps.github) {
      // The master's install branch is TWO things at once here, which is why one derivation serves
      // both: it is the shape every deletable install branch is measured against, and it is the
      // branch this installation keeps its books on — so it is also where the cluster maps stand
      // that step 3 reconciles, even on a wipeDb-only reset.
      masterBranch = booksBranch(deps.db, deps.config.master?.fqdn);
    }
    if (branches.length > 0) {
      if (!deps.github) refuse(errNotConfigured("GitHub is not configured (set GITHUB_REPO + GITHUB_WRITE_PAT) — branch deletion is unavailable"));
      if (!masterBranch) refuse(errValidation("no master FQDN derivable (no role=master row, MASTER_FQDN unset) — refusing branch deletion"));
      if (!masterBranch!.includes(".")) refuse(errValidation(`master FQDN "${masterBranch}" has no base domain — refusing branch deletion (no derivable install-branch shape)`));
      gh = deps.github;
      base = masterBranch!.slice(masterBranch!.indexOf(".") + 1);
      const installShape = new RegExp(`^[a-z0-9-]+\\.${base.replaceAll(".", "\\.")}$`);
      for (const b of branches) {
        if (b === "master") refuse(errValidation('refusing: "master" is never deletable'));
        if (!installShape.test(b)) refuse(errValidation(`refusing "${b}": not an install branch (<name>.${base})`));
        if (b === masterBranch && !input.includeMaster) refuse(errValidation(`refusing "${b}": deleting the master's own install branch requires the explicit opt-in`));
      }
    }

    if (resetInFlight) refuse(new AppError("RESOURCE_BUSY", "another reset is already running"));
    resetInFlight = true;
    try {
      const outcomes: ResetBranchOutcome[] = [];
      let pointers: ResetPointerOutcome | null = null;
      const deletingMaster = masterBranch !== undefined && branches.includes(masterBranch);
      const slaveBranches = branches.filter((b) => b !== masterBranch);

      // ---- 1. one listBranches: sha capture (the undo anchor) + orphan-map detection ------------
      const shaByName = new Map<string, string>();
      if (deps.github && masterBranch) {
        try {
          for (const r of await deps.github.listBranches()) shaByName.set(r.name, r.sha);
        } catch (err) {
          // The sha is the only thing a deleted branch can be pushed back from, so the listing is a
          // PRECONDITION of a delete, not an enrichment of it. Without it a wipeDb-only reset still
          // runs; it just cannot tell which maps are orphans.
          if (branches.length > 0) {
            refuse(errUpstream(`could not list the branches (${msg(err)}) — refusing to delete a branch whose sha was not captured first`));
          }
          log.error({ err: msg(err) }, "reset: listBranches failed — cluster maps will not be reconciled");
        }
      }

      // The same listing decides which maps are ORPHANS — a map whose install branch is gone. A
      // listing of the wrong repo would make every map an orphan and remove them all, so orphan
      // reconciliation runs only with the master's own install branch present in the listing: that
      // branch is the proof that these branches belong to the repo this manager was installed
      // from. Maps SELECTED for deletion need no such proof — the operator named them.
      const reconcileOrphans = masterBranch !== undefined && shaByName.has(masterBranch);

      // ---- 2. the DB half REHEARSED, still with nothing removed --------------------------------
      // True exactly when a wipe was asked for AND its rehearsal passed — the gate on step 6. The
      // rehearsal is the only DB work that belongs this early; the BACKUP does not, and taking it
      // here would make it a snapshot of the wrong moment (see step 6).
      let wipeRehearsed = false;
      if (input.wipeDb) {
        try {
          rehearseManagerDbWipe(deps.sqlite);
          wipeRehearsed = true;
        } catch (err) {
          refuse(new AppError("INTERNAL", `the database wipe would fail (${msg(err)}) — refused before anything was deleted; no branch and no cluster map was touched`));
        }
      }

      // ---- 3. cluster maps, ahead of the branches they describe: a branch removed while its map
      // stands leaves a phantom <name>-apps syncing a dead branch. Reconciles ORPHANS too, so a
      // previously half-failed reset or a wipeDb-only reset heals them. The maps stand on the books
      // branch — the master's own install branch — so this runs whichever install branches go, and a
      // reset that also deletes THAT branch (the explicit includeMaster opt-in) takes the maps with
      // it wholesale, which is the same outcome by a shorter road.
      if (deps.github && masterBranch && (branches.length > 0 || reconcileOrphans)) {
        try {
          const blobs = await deps.github.listBlobs(masterBranch);
          const selected = new Set(branches);
          const candidates = blobs.filter((p) => {
            const m = MARKING_RE.exec(p);
            if (!m) return false;
            const fqdn = m[1] as string;
            return selected.has(fqdn) || (reconcileOrphans && !shaByName.has(fqdn));
          });
          if (candidates.length > 0) {
            const res = await deps.github.deletePaths(masterBranch, candidates,
              `reset: remove cluster maps (${candidates.map((p) => MARKING_RE.exec(p)?.[1]).join(", ")})`);
            pointers = { branch: masterBranch, removed: res.removed, commit: res.commitSha };
            log.info({ branch: masterBranch, removed: res.removed, commit: res.commitSha }, "reset: removed cluster maps");
          } else {
            pointers = { branch: masterBranch, removed: [], commit: null };
          }
        } catch (err) {
          // The last refusal. deletePaths builds the tree and the commit before it moves the ref, and
          // both are unreferenced until it does, so a throw leaves master either untouched or already
          // committed — and either way the branches still stand and the database is whole.
          log.error({ branch: masterBranch, err: msg(err) }, "reset: cluster-map cleanup FAILED — refusing, nothing else was touched");
          refuse(errUpstream(`cluster-map cleanup on ${masterBranch} failed (${msg(err)}) — refusing: no branch was deleted and the database was not wiped, so this reset can simply be run again`));
        }
      }

      // ---- 4. slave branches — from here the work is IRREVERSIBLE ------------------------------
      for (const b of slaveBranches) {
        const sha = shaByName.get(b);
        try {
          await (gh as GitHubPlatform).deleteBranch(b);
          outcomes.push({ branch: b, ok: true, ...(sha ? { sha } : {}) });
          log.info({ branch: b, sha, actor: operator.sub }, "reset: deleted install branch");
        } catch (err) {
          outcomes.push({ branch: b, ok: false, ...(sha ? { sha } : {}), error: msg(err) });
          log.error({ branch: b, err: msg(err) }, "reset: install branch NOT deleted");
        }
      }

      // ---- 5. master install branch LAST among remote ops (opt-in gated above) ---------------------------
      if (deletingMaster && masterBranch) {
        const sha = shaByName.get(masterBranch);
        try {
          await (gh as GitHubPlatform).deleteBranch(masterBranch);
          outcomes.push({ branch: masterBranch, ok: true, ...(sha ? { sha } : {}) });
          log.warn({ branch: masterBranch, sha, actor: operator.sub }, "reset: deleted the MASTER's own install branch (explicit opt-in)");
        } catch (err) {
          outcomes.push({ branch: masterBranch, ok: false, ...(sha ? { sha } : {}), error: msg(err) });
          log.error({ branch: masterBranch, err: msg(err) }, "reset: master install branch NOT deleted");
        }
      }

      // ---- 6. DB LAST: backup → wipe (one immediate tx, rehearsed in step 2) → vault cleanup ----
      let dbResult: ResetResult["db"] = { wiped: false };
      if (wipeRehearsed) {
        try {
          // The backup, collectVaultRefs and the wipe are ADJACENT with no await between them, so
          // nothing can write to the database across them. Every step above yields the event loop —
          // and the master-reconcile timer (boot/seed-master.ts) seals keys into the credential store
          // on its own schedule, which on a fresh install is exactly when a reset gets run. A backup
          // taken before those awaits would miss a row that collectVaultRefs then finds and
          // deleteVaultValues destroys: the value gone, and the snapshot unable to restore the row.
          const backupFile = backupManagerDb(deps.sqlite, deps.config.dataDir);
          const vaultRefs = deps.store.collectVaultRefs();
          const rows = wipeManagerDb(deps.sqlite);
          const vaultOrphans = await deps.store.deleteVaultValues(vaultRefs);
          dbResult = { wiped: true, rows, backupFile, vaultOrphans };
          log.warn({ rows, backupFile, vaultOrphans, actor: operator.sub },
            "reset: manager DB wiped (cluster state; operators/meta kept)");
        } catch (err) {
          // Reported, never thrown: the branches above are already deleted, and a bare error response
          // would leave the operator without the list of what went or the shas to push it back.
          dbResult = { wiped: false, error: msg(err) };
          log.error({ err: msg(err), actor: operator.sub },
            "reset: manager DB NOT wiped — the transaction rolled back whole, the branches above ARE deleted");
        }
      }

      // ---- 7. audit BEFORE the reseed — the true first entry of the new epoch -----------------
      // An INSERT into the table the wipe just emptied, so it can still fail on the storage the wipe
      // did not need (a full disk). It may not throw here for the same reason the wipe may not: the
      // branch shas in `outcomes` reach durable storage nowhere else, and a 500 would drop them along
      // with the reseed behind it. Logged at error level instead, with the whole detail, so the record
      // survives even when the row does not.
      const detail = { via: operator.via, wipeDb: input.wipeDb, includeMaster: input.includeMaster, branches: outcomes, pointers, db: dbResult };
      try {
        writeAudit(deps.db, { actor: operator.sub, action: "manager.reset", detail });
      } catch (err) {
        log.error({ err: msg(err), actor: operator.sub, detail }, "reset: the audit entry could NOT be written — this log line is the only record of what the reset did");
      }

      // Only after a wipe that COMMITTED: the reseed re-materializes what the wipe removed, and its
      // first act is to stop the master-reconcile timer — a database that lost nothing must keep both.
      // It seals a fresh self-SSH key, so it reaches the keystore and can fail on it; like the wipe it
      // may not throw here, and unlike the wipe it needs no recovery step — the next boot seeds again.
      let reseeded = false;
      if (dbResult.wiped) {
        try {
          await deps.reseedMaster(); // stopMasterReconcile() first, then seedMaster (idempotent)
          reseeded = deps.config.master !== undefined;
        } catch (err) {
          log.error({ err: msg(err) }, "reset: the master re-seed failed — the next boot seeds the role=master row again");
        }
      }

      const wipeFailed = !dbResult.wiped && dbResult.error !== undefined;
      const ok = outcomes.every((o) => o.ok) && !wipeFailed;
      return c.json({ ok, branches: outcomes, pointers, db: dbResult, reseeded } satisfies ResetResult);
    } finally {
      resetInFlight = false;
    }
  });
}
