// The onboard `inject-release-kit` step + the shared offboard/purge release-kit removal. Split out
// of onboard.run.ts (like build-webhook.ts / seed-repo-pat.ts) so the release-kit concern
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
//
// A unit released by hand with its own release.sh runs the kit that stands in its repository, so the
// boot writes the current kit into every registered unit's repository too, and into every library the
// deploy repository names (syncReleaseKits).
import type { Step, StepCtx } from "#core/server/executor/types.ts";
import type { BuildPorts, BuildParams } from "./build-chain.ts";
import type { RepoFileWrite, RepoWriter } from "#core/server/adapters/git/port.ts";
import type { Logger } from "#core/server/kernel/logger.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import type { Registrations } from "./registrations.ts";
import { RELEASE_KIT_DIR, RELEASE_KIT_FILES, RELEASE_KIT_PATHS, RELEASE_KIT_REMOVE_PATHS, RELEASE_KIT_WORKFLOW } from "./release-kit/release-kit.ts";

/** The current kit into one repository's default branch, by comparison: a file whose bytes or whose
 *  mode differ is written, a file under the kit's own directory that the current set no longer carries
 *  is removed in the same commit, and a repository already on the current kit commits nothing.
 *  `refuse` judges what stands at the workflow path before anything is written, in the same clone; a
 *  reason leaves the repository as it is and comes back as `refused`. */
export async function syncReleaseKit(
  writer: RepoWriter,
  input: { repoURL: string; credentialId: string; message: string; signal?: AbortSignal; refuse?: (workflow: string | null) => string | null },
): Promise<{ branch: string; commit?: string; changed: boolean; written: string[]; replaced: string[]; removed: string[]; refused?: string }> {
  const signal = input.signal ? { signal: input.signal } : {};
  const session = await writer.open({ repoURL: input.repoURL, credentialId: input.credentialId, ...signal });
  try {
    const refused = input.refuse?.(await writer.readFile(session.workdir, RELEASE_KIT_WORKFLOW.path)) ?? null;
    if (refused !== null) return { branch: session.branch, changed: false, written: [], replaced: [], removed: [], refused };
    const toWrite: RepoFileWrite[] = [];
    const replaced: string[] = [];
    for (const f of RELEASE_KIT_FILES) {
      const existing = await writer.readFile(session.workdir, f.path);
      // A file of the right bytes and the wrong mode is written too, so a boot corrects a release.sh
      // an older kit left without its executable bit; git's own record of the mode is read, so a
      // repository already right commits nothing.
      if (existing === f.content && (await writer.isExecutable(session.workdir, f.path)) === f.executable) continue;
      toWrite.push({ path: f.path, content: f.content, executable: f.executable });
      if (existing !== null) replaced.push(f.path);
    }
    const current = new Set(RELEASE_KIT_PATHS);
    const removed = (await writer.listDir(session.workdir, RELEASE_KIT_DIR))
      .map((entry) => `${RELEASE_KIT_DIR}/${entry}`)
      .filter((path) => !current.has(path));
    const written = toWrite.map((w) => w.path);
    if (toWrite.length === 0 && removed.length === 0) return { branch: session.branch, changed: false, written, replaced, removed };
    const { commit, changed } = await writer.commitPush({ workdir: session.workdir, branch: session.branch, credentialId: input.credentialId, message: input.message, write: toWrite, remove: removed, ...signal });
    return { branch: session.branch, commit, changed, written, replaced, removed };
  } finally {
    await writer.dispose(session.workdir);
  }
}

/** At boot: the current kit into the repository of every registered unit and of every library the
 *  deploy repository names, so a release made there by hand runs the kit this Manager ships. NEVER
 *  rejects: boot starts it unawaited behind the listener, and a repository that fails is logged by
 *  name while the others go on. */
export async function syncReleaseKits(deps: {
  registrations: Pick<Registrations, "listBuildRegistrations">;
  writer: RepoWriter;
  /** The credential id a unit's repository is written with (repo-identity.ts resolveRepoCredentialId). */
  credentialFor: (repoURL: string) => Promise<string>;
  /** The deploy repository's `tenant.libraryRepos`; empty where the installation has no deploy repository. */
  libraryRepos: () => Promise<string[]>;
  /** Gate G28 over what stands at the workflow path of a library: a reason refuses the write. A unit
   *  passed the same gate at its onboarding; a library was never onboarded, so it is judged here. */
  refuseWorkflow: (workflow: string | null) => string | null;
  version: string;
  logger: Logger;
}): Promise<void> {
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const commitMessage = `chore(release-kit): sync platform release tooling [boot ${deps.version}]`;
  let units: Awaited<ReturnType<Registrations["listBuildRegistrations"]>> = [];
  try {
    units = await deps.registrations.listBuildRegistrations();
  } catch (err) {
    deps.logger.error({ err: message(err) }, "the release kit was synced into no registered unit: the registrations could not be read");
  }
  for (const { unit, entry } of units) {
    try {
      const synced = await syncReleaseKit(deps.writer, { repoURL: entry.repoURL, credentialId: await deps.credentialFor(entry.repoURL), message: commitMessage });
      if (synced.changed) deps.logger.info({ unit, repoURL: entry.repoURL, branch: synced.branch, commit: synced.commit, written: synced.written, removed: synced.removed }, "release kit synced into the unit's repository");
    } catch (err) {
      deps.logger.error({ unit, repoURL: entry.repoURL, err: message(err) }, "the release kit could not be synced into this unit's repository — a release made there by hand runs the kit that stands");
    }
  }
  let libraries: string[] = [];
  try {
    libraries = await deps.libraryRepos();
  } catch (err) {
    deps.logger.error({ err: message(err) }, "the release kit was synced into no library: the deploy repository's libraryRepos could not be read");
  }
  for (const repoURL of libraries) {
    try {
      const synced = await syncReleaseKit(deps.writer, { repoURL, credentialId: await deps.credentialFor(repoURL), message: commitMessage, refuse: deps.refuseWorkflow });
      if (synced.refused !== undefined) deps.logger.error({ library: repoURL, reason: synced.refused }, "the release kit was NOT written into this library — a workflow of its own stands where the kit's goes");
      else if (synced.changed) deps.logger.info({ library: repoURL, branch: synced.branch, commit: synced.commit, written: synced.written, removed: synced.removed }, "release kit synced into the library's repository");
    } catch (err) {
      deps.logger.error({ library: repoURL, err: message(err) }, "the release kit could not be synced into this library's repository — a release made there runs the kit that stands");
    }
  }
}

/** The onboard `inject-release-kit` step: commit the release-kit (release/ scripts + the release
 *  workflow) into the consumer repo's default branch, replacing whatever kit stood there. Fails LOUD
 *  on any missing prerequisite (an unwired writer) or a failed push — no release tooling, the
 *  consumer cannot cut a release, so this must never be a silent skip (setup-webhook precedent). */
export function injectReleaseKitStep(ports: BuildPorts, p: Pick<BuildParams, "consumerName" | "repoURL" | "repoCredentialId">): Step {
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
      const synced = await syncReleaseKit(ports.consumerRepo, { repoURL: p.repoURL, credentialId: p.repoCredentialId, message: `chore(release-kit): sync platform release tooling [${ctx.runId}]`, signal: ctx.signal });
      for (const path of synced.replaced) ctx.log("meta", `release-kit: ${path} differs from the current kit — replacing it (the kit is platform-owned; the trigger below runs exactly these bytes)`);
      if (synced.written.length === 0 && synced.removed.length === 0) {
        ctx.log("meta", `release-kit: all ${RELEASE_KIT_PATHS.length} files in ${p.repoURL} on ${synced.branch} already carry the current kit — nothing to commit`);
        return;
      }
      ctx.checkpoint({ releaseKit: synced.written, removed: synced.removed, branch: synced.branch, commit: synced.commit, changed: synced.changed });
      ctx.log("meta", synced.changed
        ? `release-kit: synced ${p.repoURL} on ${synced.branch} (${synced.commit}) — wrote ${synced.written.length} file(s)${synced.written.length ? ` (${synced.written.join(", ")})` : ""}${synced.removed.length ? `, removed ${synced.removed.length} stale file(s) (${synced.removed.join(", ")})` : ""}`
        : `release-kit: nothing changed in ${p.repoURL} on ${synced.branch} — already up to date`);
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
    consumerRepo: RepoWriter | undefined;
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
