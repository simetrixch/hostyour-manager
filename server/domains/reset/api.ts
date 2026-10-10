import { z } from "zod";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Db } from "../../db/client.ts";
import type { Config } from "../../kernel/config.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GitHubPlatform } from "../../adapters/github-platform/port.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ResetResult, ResetBranchOutcome, ResetPointerOutcome } from "../../../shared/api-types.ts";
import { AppError, errValidation, errNotConfigured, errIllegalTransition, errUpstream, errNotAMember, errResourceBusy } from "../../kernel/errors.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { countLiveRuns } from "../../db/reset.ts";
import { booksBranch } from "../inventory/read.ts";
import { CLUSTER_MAP_DIR } from "../../../shared/cluster-values.ts";

export interface ResetApiDeps {
  config: Config;
  db: Db; // for writeAudit (the sanctioned audit path)
  sqlite: Database.Database; // for the live-run count (db/reset.ts)
  logger: Logger;
  /** Injected by wire IFF config.github is set (composition root builds the adapter). */
  github: GitHubPlatform | undefined;
}

// Strict, so a client that still asks for the database wipe is refused instead of being answered as
// if the wipe had run.
const ResetInput = z.object({
  confirm: z.string(),
  deleteBranches: z.array(z.string().min(1).max(253)).max(50),
  includeMaster: z.boolean(),
}).strict();

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// clusters/active/<fqdn>.yaml on master — the cluster map. Its file name IS the cluster's FQDN, which
// IS its install branch, so a map names the branch it belongs to with no recomposition.
const MARKING_RE = new RegExp(`^${CLUSTER_MAP_DIR}/([a-z0-9-]+(?:\\.[a-z0-9-]+)+)\\.yaml$`);

/** Serializes resets in-process (module-level on purpose; one Manager pod). */
let resetInFlight = false;

/**
 * THE destructive reset (Reset wizard backend). Removes the selected clusters' maps from master and
 * deletes their install branches on GitHub. The Manager's database is never part of it: it is
 * infrastructure, and every server, cluster, run and audit row stays as it was.
 *
 * THE ORDER IS THE SAFETY. Deleting a branch is the one act here that cannot be taken back: the sha
 * is captured and reported, but GitHub reaps objects no ref points at, so a sha is a chance and not
 * a promise. The map removal is a commit on master and stays in its history. So every step that can
 * still refuse runs BEFORE the first branch delete:
 *   1. list the branches — no sha, no delete, because a delete with no captured sha has no way back;
 *   2. remove the cluster maps, and refuse if that fails — a branch deleted while its map stands
 *      leaves the master's slaves-appset generating a <name>-apps Application for a dead branch.
 * Each of those two refuses the whole request with nothing removed. Then the branches go, and the
 * audit entry runs last — where nothing may throw: an error response after the branches are gone
 * would carry neither what went nor the shas to restore it with.
 */
export function registerResetRoutes(app: Hono<AppEnv>, deps: ResetApiDeps): void {
  app.post("/api/reset", async (c) => {
    const log = deps.logger.child({ route: "reset" });
    const operator = c.get("operator");

    // Every refusal leaves an audit trace (log-everything) BEFORE it throws. The declared type lets
    // a call narrow what follows it, which an arrow's own return annotation does not.
    const refuse: (err: AppError) => never = (err) => {
      writeAudit(deps.db, {
        action: "manager.reset.refused",
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
      refuse(errNotAMember("break-glass sessions cannot reset — sign in via OIDC"));
    }
    const parsed = ResetInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) refuse(errValidation(parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ")));
    const input = parsed.data;
    if (input.confirm !== "RESET") refuse(errValidation('confirmation failed — type "RESET" (exactly) to confirm'));
    const branches = [...new Set(input.deleteBranches)];
    if (branches.length === 0) refuse(errValidation("nothing to reset: no branches are selected"));

    // A reset NEVER runs beside live runs — its branch deletes race a deploy-slave's pushes.
    const live = countLiveRuns(deps.sqlite);
    if (live > 0) refuse(errIllegalTransition(`cannot reset: ${live} run(s) in flight (planning/queued/approved/running) — cancel or let them finish`));

    if (!deps.github) refuse(errNotConfigured("GitHub is not configured (set GITHUB_REPO + GITHUB_WRITE_PAT) — branch deletion is unavailable"));
    const gh = deps.github;
    // The master's install branch is TWO things at once here, which is why one derivation serves
    // both: it is the shape every deletable install branch is measured against, and it is the
    // branch this installation keeps its books on — so it is also where the cluster maps stand
    // that step 2 reconciles.
    const masterBranch = booksBranch(deps.db, deps.config.master?.fqdn);
    if (!masterBranch) refuse(errValidation("no master FQDN derivable (no role=master row, MASTER_FQDN unset) — refusing branch deletion"));
    if (!masterBranch.includes(".")) refuse(errValidation(`master FQDN "${masterBranch}" has no base domain — refusing branch deletion (no derivable install-branch shape)`));
    const base = masterBranch.slice(masterBranch.indexOf(".") + 1);
    const installShape = new RegExp(`^[a-z0-9-]+\\.${base.replaceAll(".", "\\.")}$`);
    for (const b of branches) {
      if (b === "master") refuse(errValidation('refusing: "master" is never deletable'));
      if (!installShape.test(b)) refuse(errValidation(`refusing "${b}": not an install branch (<name>.${base})`));
      if (b === masterBranch && !input.includeMaster) refuse(errValidation(`refusing "${b}": deleting the master's own install branch requires the explicit opt-in`));
    }

    if (resetInFlight) refuse(errResourceBusy("another reset is already running"));
    resetInFlight = true;
    try {
      const outcomes: ResetBranchOutcome[] = [];
      let pointers: ResetPointerOutcome;
      const deletingMaster = branches.includes(masterBranch);
      const slaveBranches = branches.filter((b) => b !== masterBranch);

      // ---- 1. one listBranches: sha capture (the undo anchor) + orphan-map detection ------------
      // The sha is the only thing a deleted branch can be pushed back from, so the listing is a
      // PRECONDITION of a delete, not an enrichment of it.
      const shaByName = new Map<string, string>();
      try {
        for (const r of await gh.listBranches()) shaByName.set(r.name, r.sha);
      } catch (err) {
        refuse(errUpstream(`could not list the branches (${msg(err)}) — refusing to delete a branch whose sha was not captured first`));
      }

      // The same listing decides which maps are ORPHANS — a map whose install branch is gone. A
      // listing of the wrong repo would make every map an orphan and remove them all, so orphan
      // reconciliation runs only with the master's own install branch present in the listing: that
      // branch is the proof that these branches belong to the repo this manager was installed
      // from. Maps SELECTED for deletion need no such proof — the operator named them.
      const reconcileOrphans = shaByName.has(masterBranch);

      // ---- 2. cluster maps, ahead of the branches they describe: a branch removed while its map
      // stands leaves a phantom <name>-apps syncing a dead branch. Reconciles ORPHANS too, so a
      // previously half-failed reset heals them. The maps stand on the books branch — the master's
      // own install branch — so this runs whichever install branches go, and a reset that also
      // deletes THAT branch (the explicit includeMaster opt-in) takes the maps with it wholesale,
      // which is the same outcome by a shorter road.
      try {
        const blobs = await gh.listBlobs(masterBranch);
        const selected = new Set(branches);
        const candidates = blobs.filter((p) => {
          const m = MARKING_RE.exec(p);
          if (!m) return false;
          const fqdn = m[1] as string;
          return selected.has(fqdn) || (reconcileOrphans && !shaByName.has(fqdn));
        });
        if (candidates.length > 0) {
          const res = await gh.deletePaths(masterBranch, candidates,
            `reset: remove cluster maps (${candidates.map((p) => MARKING_RE.exec(p)?.[1]).join(", ")})`);
          pointers = { branch: masterBranch, removed: res.removed, commit: res.commitSha };
          log.info({ branch: masterBranch, removed: res.removed, commit: res.commitSha }, "reset: removed cluster maps");
        } else {
          pointers = { branch: masterBranch, removed: [], commit: null };
        }
      } catch (err) {
        // The last refusal. deletePaths builds the tree and the commit before it moves the ref, and
        // both are unreferenced until it does, so a throw leaves master either untouched or already
        // committed — and either way the branches still stand.
        log.error({ branch: masterBranch, err: msg(err) }, "reset: cluster-map cleanup FAILED — refusing, nothing else was touched");
        refuse(errUpstream(`cluster-map cleanup on ${masterBranch} failed (${msg(err)}) — refusing: no branch was deleted, so this reset can simply be run again`));
      }

      // ---- 3. slave branches — from here the work is IRREVERSIBLE ------------------------------
      for (const b of slaveBranches) {
        const sha = shaByName.get(b);
        try {
          await gh.deleteBranch(b);
          outcomes.push({ branch: b, ok: true, ...(sha ? { sha } : {}) });
          log.info({ branch: b, sha, actor: operator.sub }, "reset: deleted install branch");
        } catch (err) {
          outcomes.push({ branch: b, ok: false, ...(sha ? { sha } : {}), error: msg(err) });
          log.error({ branch: b, err: msg(err) }, "reset: install branch NOT deleted");
        }
      }

      // ---- 4. master install branch LAST among remote ops (opt-in gated above) ---------------------------
      if (deletingMaster) {
        const sha = shaByName.get(masterBranch);
        try {
          await gh.deleteBranch(masterBranch);
          outcomes.push({ branch: masterBranch, ok: true, ...(sha ? { sha } : {}) });
          log.warn({ branch: masterBranch, sha, actor: operator.sub }, "reset: deleted the MASTER's own install branch (explicit opt-in)");
        } catch (err) {
          outcomes.push({ branch: masterBranch, ok: false, ...(sha ? { sha } : {}), error: msg(err) });
          log.error({ branch: masterBranch, err: msg(err) }, "reset: master install branch NOT deleted");
        }
      }

      // ---- 5. audit LAST ------------------------------------------------------------------------
      // It may not throw here: the branch shas in `outcomes` reach durable storage nowhere else, and
      // a 500 would drop them. Logged at error level instead, with the whole detail, so the record
      // survives even when the row does not.
      const detail = { via: operator.via, includeMaster: input.includeMaster, branches: outcomes, pointers };
      try {
        writeAudit(deps.db, { action: "manager.reset", detail });
      } catch (err) {
        log.error({ err: msg(err), actor: operator.sub, detail }, "reset: the audit entry could NOT be written — this log line is the only record of what the reset did");
      }

      return c.json({ ok: outcomes.every((o) => o.ok), branches: outcomes, pointers } satisfies ResetResult);
    } finally {
      resetInFlight = false;
    }
  });
}
