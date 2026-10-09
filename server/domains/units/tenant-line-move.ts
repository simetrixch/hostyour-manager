// Which pairing a tenant moves to when it moves to a newer engine line (tenant-line-move). A bundle and
// the platform part that carries its engine are written for one line, and every writer refuses a
// pairing across lines (engine-line.ts), so a move takes both at once: the newest bundle release on the
// line, and the newest tag on the line that every build of the engine's part has released at the
// stage. The plan and the Versions dialog's offer both read it here, so what the dialog offers is what
// the run would write.
import type { Stage } from "../../../shared/enums.ts";
import type { AppsEngine } from "../../../shared/apps-manifest.ts";
import { parseReleaseTag } from "../../../shared/release.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { LineMoveView } from "../../../shared/api-types-line-move.ts";
import type { Db } from "../../db/client.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { bundleReleaseTag, engineLineRefusal, repositoryEngine, versionLine } from "./engine-line.ts";
import { sameApprovals, stagePinsAndNamesOf, tenantVersionParts, versionRefusal, withChosenVersions, type Approvals } from "./tenant-versions.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

export type LineMovePorts = Pick<TenantOnboardPorts, "repo" | "deployCredentialId" | "registrations" | "attestedBuilds" | "registryProbe" | "channelStages">;

/** What a move to `line` writes: the bundle release on the line, and one tag for every build of the
 *  part that carries the bundle's engine, inside the tenant's whole approvedTags. */
export interface LinePairing {
  line: string;
  bundleRelease: string;
  appsImageTag: string;
  part: string;
  partTag: string;
  builds: string[];
  approvedTags: Approvals;
}

export interface LineMoveReading {
  /** The line the tenant runs now, as its bundle's apps.yaml declares it; null where it declares no
   *  engine, which is a bundle the engine-line checks pass, and which has no line to move from. */
  line: string | null;
  /** The line a move goes to: the one asked for, or the newest newer one released; null where none is. */
  toLine: string | null;
  /** The pairing a move writes; null where no newer line is released at the stage, or where it is refused. */
  target: LinePairing | null;
  /** Why the move cannot be planned; empty where it can. */
  refusals: string[];
  /** The registration already carries the target pairing, so a run only waits for it to render. */
  standing: boolean;
}

/** Whether line `a` ("x.y") comes after line `b`. */
export function isNewerLine(a: string, b: string): boolean {
  const [ax, ay] = a.split(".").map(Number) as [number, number];
  const [bx, by] = b.split(".").map(Number) as [number, number];
  return ax > bx || (ax === bx && ay > by);
}

/** The tenant's line and the pairing a move to `line` writes; without `line`, the line of the newest
 *  bundle release the stage takes, where that is newer than the tenant's. THROWS where the tenant runs
 *  no bundle; a bundle that declares no engine answers no line, with the refusal that says so. */
export async function readLineMove(
  ports: LineMovePorts,
  input: { stage: Stage; entry: TenantRegistration; registryHost: string; line?: string; log: (line: string) => void; signal: AbortSignal },
): Promise<LineMoveReading> {
  const { entry, stage } = input;
  if (!entry.appsRepo || !entry.appsImage || !entry.appsImageTag) throw errValidation(`tenant ${entry.subdomain} runs no apps bundle, so it runs no engine line to move`);
  const appsRepo = entry.appsRepo;
  const read = { repo: ports.repo, ...(ports.deployCredentialId ? { deployCredentialId: ports.deployCredentialId } : {}) };
  const ctx = { log: input.log, signal: input.signal };
  const engines = new Map<string, Promise<AppsEngine | undefined>>();
  const engineOf = (release: string): Promise<AppsEngine | undefined> => {
    if (!engines.has(release)) engines.set(release, repositoryEngine(read, { repoURL: appsRepo, ref: release }, ctx));
    return engines.get(release)!;
  };

  const runningRelease = bundleReleaseTag(entry.appsImageTag);
  const tRunning = performance.now();
  const running = await engineOf(runningRelease);
  input.log(`engine of the running release ${runningRelease}: ${Math.round(performance.now() - tRunning)} ms`);
  if (running === undefined) {
    return { line: null, toLine: null, target: null, refusals: [`the apps bundle of tenant ${entry.subdomain} at ${runningRelease} declares no engine, so the line it runs is unknown`], standing: false };
  }
  const tReleases = performance.now();
  const channels = await ports.channelStages();
  const runningTs14 = parseReleaseTag(runningRelease)?.ts14 ?? "";
  // The bundle releases the stage takes, from the one the tenant runs on, newest first.
  const releases = (await ports.repo.listTags({ repoURL: appsRepo, ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}), signal: input.signal }))
    .flatMap((t) => {
      const parsed = parseReleaseTag(t.name);
      return parsed && parsed.ts14 >= runningTs14 && (channels[parsed.channel] ?? []).includes(stage) ? [{ release: t.name, commit: t.commit, ts14: parsed.ts14 }] : [];
    })
    .sort((a, b) => b.ts14.localeCompare(a.ts14));
  input.log(`releases of ${appsRepo} and the stages of their channels: ${releases.length} at ${stage}, ${Math.round(performance.now() - tReleases)} ms`);

  let line = input.line;
  if (line === undefined) {
    let newest: AppsEngine | undefined;
    if (releases[0]) {
      const tNewest = performance.now();
      newest = await engineOf(releases[0].release);
      input.log(`engine of the newest release ${releases[0].release}: ${Math.round(performance.now() - tNewest)} ms`);
    }
    if (newest === undefined || !isNewerLine(newest.line, running.line)) return { line: running.line, toLine: null, target: null, refusals: [], standing: false };
    line = newest.line;
  }
  if (line !== running.line && !isNewerLine(line, running.line)) {
    return { line: running.line, toLine: line, target: null, refusals: [`line ${line} is not newer than line ${running.line}, which tenant ${entry.subdomain} runs`], standing: false };
  }

  const refusals: string[] = [];
  let bundle: { release: string; commit: string; engine: AppsEngine } | undefined;
  const tSearch = performance.now();
  let searched = 0;
  for (const r of releases) {
    const engine = await engineOf(r.release);
    searched++;
    if (engine?.line === line) {
      bundle = { release: r.release, commit: r.commit, engine };
      break;
    }
  }
  input.log(`releases searched for line ${line}: ${searched} engines, ${Math.round(performance.now() - tSearch)} ms`);
  if (!bundle) return { line: running.line, toLine: line, target: null, refusals: [`no release of ${appsRepo} that ${stage} takes declares engine line ${line}`], standing: false };

  const tParts = performance.now();
  const parts = await tenantVersionParts(ports, stage, entry.members, entry.approvedTags);
  input.log(`parts and their released tags: ${Math.round(performance.now() - tParts)} ms`);
  const part = parts.find((p) => p.builds.some((b) => b.name === bundle.engine.build));
  if (!part) return { line: running.line, toLine: line, target: null, refusals: [`no member of tenant ${entry.subdomain} renders ${bundle.engine.build}, the engine ${bundle.release} is written for`], standing: false };
  // versionRefusal holds a tag to every build of the part having released it at the stage.
  const partTag = (part.builds[0]?.released ?? [])
    .filter((t) => versionLine(t) === line && versionRefusal(t, part, channels, stage) === null)
    .sort((a, b) => (b.split("-")[2] ?? "").localeCompare(a.split("-")[2] ?? ""))[0];
  if (partTag === undefined) {
    const unreleased = part.builds.filter((b) => !b.released.some((t) => versionLine(t) === line)).map((b) => b.name);
    const why = unreleased.length > 0
      ? `no release made ${unreleased.join(", ")} of ${part.name} ${line}.x available at ${stage}`
      : `no ${line}.x tag was released at ${stage} for every build of ${part.name} together (${part.builds.map((b) => b.name).join(", ")})`;
    return { line: running.line, toLine: line, target: null, refusals: [why], standing: false };
  }

  const appsImageTag = `${bundle.release}-${bundle.commit.slice(0, 7)}`;
  const images = [{ repo: entry.appsImage, tag: appsImageTag }, ...part.builds.map((b) => ({ repo: b.image, tag: partTag }))];
  const tProbes = performance.now();
  for (const image of images) {
    if (!(await ports.registryProbe.imageExists({ registryHost: input.registryHost, ...image }, { signal: input.signal }))) {
      refusals.push(`${input.registryHost}/${image.repo}:${image.tag} is not in the registry`);
    }
  }
  input.log(`registry probes: ${images.length} images, ${Math.round(performance.now() - tProbes)} ms`);
  const tPins = performance.now();
  const pins = await stagePinsAndNamesOf((chart) => ports.registrations.listPinnedBuilds(stage, chart), entry.members);
  input.log(`pins of the stage: ${Math.round(performance.now() - tPins)} ms`);
  const approvedTags = withChosenVersions(entry.approvedTags, pins, Object.fromEntries(part.builds.map((b) => [b.name, partTag])));
  const mismatch = engineLineRefusal(bundle.engine, approvedTags);
  if (mismatch !== null) refusals.push(mismatch);
  const target: LinePairing = { line, bundleRelease: bundle.release, appsImageTag, part: part.name, partTag, builds: part.builds.map((b) => b.name), approvedTags };
  const standing = refusals.length === 0 && entry.appsImageTag === appsImageTag && sameApprovals(entry.approvedTags, approvedTags);
  if (line === running.line && !standing) {
    refusals.push(`tenant ${entry.subdomain} already runs line ${line}; within a line its releases and the Versions run move it`);
  }
  return { line: running.line, toLine: line, target: refusals.length === 0 ? target : null, refusals, standing };
}

/** GET /api/tenants/:id/line-moves: the line the tenant runs and the move the dialog offers, read by the
 *  plan's own reader, so the offer is what the run would write or the reasons it would refuse. */
export async function readTenantLineMoves(
  ports: LineMovePorts & Pick<TenantOnboardPorts, "resolveClusterValueFiles">,
  db: Db,
  tenantId: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<LineMoveView> {
  const started = performance.now();
  const tc = loadTenantCluster(db, tenantId);
  // Logged on every path, a refused or failed read included, because the time is what tells which read is slow.
  try {
    const tValues = performance.now();
    const read = await ports.registrations.readTenant(tc.stage, tc.guid);
    if (!read) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
    if (!read.entry.appsImage) return { line: null, offer: null };
    const registryHost = registryHostFromChain(await ports.resolveClusterValueFiles(tc.domain, tc.stage));
    log(`registration and cluster values: ${Math.round(performance.now() - tValues)} ms`);
    const reading = await readLineMove(ports, { stage: tc.stage, entry: read.entry, registryHost, log, signal: signal ?? new AbortController().signal });
    if (reading.toLine === null || reading.standing) return { line: reading.line, offer: null };
    return {
      line: reading.line,
      offer: {
        line: reading.toLine,
        fromBundle: read.entry.appsImageTag ?? "",
        toBundle: reading.target?.appsImageTag ?? null,
        part: reading.target?.part ?? null,
        partTag: reading.target?.partTag ?? null,
        builds: reading.target?.builds ?? [],
        refusals: reading.refusals,
      },
    };
  } finally {
    log(`line-move read of tenant ${tc.guid}: ${Math.round(performance.now() - started)} ms`);
  }
}
