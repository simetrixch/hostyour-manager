// The onboard `inject-release-kit` step + the shared offboard/purge release-kit removal. Split out
// of onboard.run.ts (like onboard-webhook.ts / onboard-seed-repo-pat.ts) so the release-kit concern
// is one small, testable unit and both sides of it (commit + git-rm) share one place for the file
// set + the fail direction.
//
// inject-release-kit REPLACES, it does not layer: every kit file is written to exactly the
// current asset bytes whenever the repo's copy differs, and every file under the kit's own directory
// that the current asset set no longer carries is REMOVED in the same commit. The kit is
// platform-owned tooling — the injected script is what the onboarding itself triggers next, so a
// consumer-edited or stale copy would make that trigger run bytes nobody validated. An onboarding
// over an older kit therefore leaves the repo in the state a fresh one would. Consumer-owned paths —
// everything outside release/ and the one workflow file — are never touched.
//
// It is FAIL-CLOSED — an unwired writer, an unresolvable branch, or a push the PAT is not authorized
// for (no contents:write) throws and rejects the run: no release kit, no release cycle.
//
// The offboard/purge removal (removeReleaseKit) is FAIL-SOFT (like removeConsumerWebhook): a failure
// to git-rm the release-kit NEVER blocks teardown — every failure path logs a warning and returns.
import type { Step, StepCtx } from "../../executor/types.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";
import type { ConsumerRepo } from "../../adapters/git/port.ts";
import { errValidation } from "../../kernel/errors.ts";
import { RELEASE_KIT_DIR, RELEASE_KIT_FILES, RELEASE_KIT_PATHS, RELEASE_KIT_REMOVE_PATHS } from "./release-kit/release-kit.ts";

/** The onboard `inject-release-kit` step: commit the release-kit (release/ scripts + the release
 *  workflow) into the consumer repo's default branch, replacing whatever kit stood there. Fails LOUD
 *  on any missing prerequisite (an unwired writer) or a failed push — no release tooling, the
 *  consumer cannot cut a release, so this must never be a silent skip (setup-webhook precedent). */
export function injectReleaseKitStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "inject-release-kit",
    title: "Commit the release kit into the consumer repo (release/ + workflow)",
    run: async (ctx) => {
      // Fail-loud wiring gap (setup-webhook precedent): the step is UNCONDITIONAL (every consumer
      // needs the release client), so an unwired consumer-repo writer is a manager misconfiguration,
      // never a silent skip.
      if (!ports.consumerRepo) {
        throw errValidation(`onboard "${p.consumerName}" requires the consumer-repo git writer but none is wired on this manager — refusing to onboard a consumer whose repo cannot mint a release (no release kit → no release build)`);
      }
      const session = await ports.consumerRepo.open({ repoURL: p.repoURL, credentialId: p.repoCredentialId, signal: ctx.signal });
      try {
        // Write BY COMPARISON: only a file whose repo copy differs from the current asset bytes is
        // staged, so a repo already on the current kit commits nothing.
        const toWrite: { path: string; content: string }[] = [];
        for (const f of RELEASE_KIT_FILES) {
          const existing = await ports.consumerRepo.readFile(session.workdir, f.path);
          if (existing === f.content) continue;
          toWrite.push({ path: f.path, content: f.content });
          if (existing !== null) ctx.log("meta", `release-kit: ${f.path} differs from the current kit — replacing it (the kit is platform-owned; the trigger below runs exactly these bytes)`);
        }
        // The stale-file delete, derived from the SAME source as the write side: every entry under
        // the kit's own directory that the current asset set no longer carries was written by an
        // older kit and goes in the same commit.
        const current = new Set(RELEASE_KIT_PATHS);
        const toRemove = (await ports.consumerRepo.listDir(session.workdir, RELEASE_KIT_DIR))
          .map((entry) => `${RELEASE_KIT_DIR}/${entry}`)
          .filter((path) => !current.has(path));
        if (toWrite.length === 0 && toRemove.length === 0) {
          ctx.log("meta", `release-kit: all ${RELEASE_KIT_PATHS.length} files in ${p.repoURL} on ${session.branch} already carry the current kit — nothing to commit`);
          return;
        }
        const { commit, changed } = await ports.consumerRepo.commitPush({
          workdir: session.workdir,
          branch: session.branch,
          credentialId: p.repoCredentialId,
          message: `chore(release-kit): sync platform release tooling [${ctx.runId}]`,
          write: toWrite,
          remove: toRemove,
          signal: ctx.signal,
        });
        ctx.checkpoint({ releaseKit: toWrite.map((w) => w.path), removed: toRemove, branch: session.branch, commit, changed });
        ctx.log("meta", changed
          ? `release-kit: synced ${p.repoURL} on ${session.branch} (${commit}) — wrote ${toWrite.length} file(s)${toWrite.length ? ` (${toWrite.map((w) => w.path).join(", ")})` : ""}${toRemove.length ? `, removed ${toRemove.length} stale file(s) (${toRemove.join(", ")})` : ""}`
          : `release-kit: nothing changed in ${p.repoURL} on ${session.branch} — already up to date`);
      } finally {
        await ports.consumerRepo.dispose(session.workdir);
      }
    },
  };
}

/** Shared, FAIL-SOFT release-kit removal for offboard + purge (self-contained teardown): git-rm the
 *  release-kit — the whole release/ directory (stale files of older kits included) plus the workflow
 *  file — from the consumer repo using its sealed PAT. A removal failure NEVER blocks teardown —
 *  every failure path logs a warning and returns. Fail-soft cases:
 *   - no consumer-repo writer wired               → log + skip
 *   - repoURL / repoCredentialId unknown          → log + skip (a true purge orphan with no row)
 *   - the PAT is revoked/absent, or the push fails → log a warning + continue (a lingering release/ is
 *                                                    surfaced for hand-removal, never a crash) */
export async function removeReleaseKit(
  ctx: StepCtx,
  opts: {
    consumerRepo: ConsumerRepo | undefined;
    consumerName: string;
    repoURL: string | null | undefined;
    repoCredentialId: string | null | undefined;
  },
): Promise<void> {
  if (!opts.consumerRepo) {
    ctx.log("meta", `release-kit removal skipped for ${opts.consumerName} — no consumer-repo git writer is wired on this manager`);
    return;
  }
  if (!opts.repoURL || !opts.repoCredentialId) {
    ctx.log("meta", `release-kit removal skipped for ${opts.consumerName} — no repo URL / sealed consumer PAT available (no inventory row); remove release/ + .github/workflows/release.yml by hand if they linger`);
    return;
  }
  let session;
  try {
    session = await opts.consumerRepo.open({ repoURL: opts.repoURL, credentialId: opts.repoCredentialId, signal: ctx.signal });
  } catch (err) {
    // The sealed credential may already be revoked (a re-run after remove-repo-pat) or the clone may
    // fail — not a teardown blocker. Surface it so an operator can remove the files by hand.
    ctx.log("meta", `release-kit NOT removed for ${opts.consumerName} — could not open ${opts.repoURL} (${err instanceof Error ? err.message : String(err)}); remove release/ + .github/workflows/release.yml by hand if they linger`);
    return;
  }
  try {
    const { commit, changed } = await opts.consumerRepo.commitPush({
      workdir: session.workdir,
      branch: session.branch,
      credentialId: opts.repoCredentialId,
      message: `chore(release-kit): remove platform release tooling [${ctx.runId}]`,
      remove: [...RELEASE_KIT_REMOVE_PATHS],
      signal: ctx.signal,
    });
    ctx.log("meta", changed
      ? `release-kit removed from ${opts.repoURL} on ${session.branch} (${commit}) — release/ + .github/workflows/release.yml are gone`
      : `no release-kit to remove from ${opts.repoURL} on ${session.branch} — already absent`);
  } catch (err) {
    // Fail-soft: a scope refusal / transport error must not block offboard/purge. Warn so a lingering
    // release-kit stays visible.
    ctx.log("meta", `release-kit NOT removed for ${opts.consumerName} on ${opts.repoURL} — ${err instanceof Error ? err.message : String(err)}; remove release/ + .github/workflows/release.yml by hand if they linger`);
  } finally {
    await opts.consumerRepo.dispose(session.workdir).catch(() => undefined);
  }
}
