// The carrier fakes the pin search + the reaper are tested against — in-memory, no git, no network.
// Two shapes, because the search reads two kinds of source: a GitOps repo it walks branch by branch
// (hostyour-cloud, catalog) and a unit's own repo it clones once per stage at a delivery branch.
import type { CarrierRepo } from "./search.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import type { BranchScope, ClonedRepo, RepoReader } from "../../adapters/git/port.ts";

/** A GitOps repo whose branches and files a test states outright. `seed` puts one file on one branch;
 *  a branch exists as soon as something is seeded on it, so a test never lists branches separately.
 *  listDir derives the immediate children from the seeded paths, exactly as the real readers do. */
export class FakeCarrierRepo implements CarrierRepo {
  /** The books branch of the installation under test — a real one's value (the master cluster's
   *  FQDN), never "master": class (a) of the search reads its registration index there, and a fake
   *  that put it on the trunk would let a search of the trunk pass. */
  readonly booksBranch: string;
  // "branch\0path" -> content
  private readonly store = new Map<string, string>();
  /** Every branch a turn was taken on, in order — a test asserts the search read them all. */
  readonly fetched: string[] = [];

  constructor(opts: { booksBranch?: string } = {}) {
    this.booksBranch = opts.booksBranch ?? "m1.example.com";
  }

  seed(branch: string, path: string, content: string): void {
    this.store.set(`${branch}\0${path}`, content);
  }

  async listBranches(): Promise<readonly { name: string }[]> {
    const names = new Set<string>();
    for (const key of this.store.keys()) names.add(key.slice(0, key.indexOf("\0")));
    return [...names].sort().map((name) => ({ name }));
  }

  async withBranch<T>(branch: string, fn: (scope: BranchScope) => Promise<T>): Promise<T> {
    this.fetched.push(branch);
    return fn({
      branch,
      readFile: async (relPath) => this.store.get(`${branch}\0${relPath}`) ?? null,
      listDir: async (relPath) => {
        const prefix = `${relPath.replace(/\/+$/, "")}/`;
        const names = new Set<string>();
        for (const key of this.store.keys()) {
          if (!key.startsWith(`${branch}\0`)) continue;
          const path = key.slice(branch.length + 1);
          if (!path.startsWith(prefix)) continue;
          const seg = path.slice(prefix.length).split("/")[0];
          if (seg) names.add(seg);
        }
        return [...names];
      },
      // The pin search only ever READS. A carrier fake that could write would model a reaper that
      // does not exist: deletion happens against the registry, never against these files.
      commit: () => Promise.reject(new Error("FakeCarrierRepo is read-only")),
      mintTag: () => Promise.reject(new Error("FakeCarrierRepo is read-only")),
    });
  }
}

/** WHERE THE PLATFORM'S OWN CHARTS AND THEIR IMAGE PINS STAND on hostyour-cloud, as a LITERAL and
 *  never as the constant the search uses. A fixture that seeds from that constant agrees with the
 *  reader whatever the platform repository holds, which is how the walk went on reading `apps/`
 *  through the rename that gathered every chart under `clusters/` — green here, while the release
 *  surface reported no app versions and the reaper's keep floor silently lost the class that protects
 *  the platform's own images. Measured in simetrixch/hostyour-cloud on 2026-08-26: no branch of that
 *  repository carries `apps/`, and `clusters/inventories/` is where the release bump writes the tags
 *  (clusters/inventories/consumer-build/templates/pipeline-release.yaml globs exactly that path). */
export const PLATFORM_APPS_DIR = "clusters/inventories";

/** The path of ONE platform app's per-stage pin file, on hostyour-cloud. */
export function platformAppPinPath(app: string, stage: string): string {
  return `${PLATFORM_APPS_DIR}/${app}/values-${stage}.yaml`;
}

/** A unit's own repo, keyed by (repoURL, ref). A clone of a ref nothing was seeded on THROWS, which is
 *  how a test models the delivery branch a unit does not have — the case the search must refuse. */
export class FakeUnitRepo implements Pick<RepoReader, "cloneAtRef" | "readFile" | "dispose"> {
  // "repoURL\0ref\0path" -> content
  private readonly store = new Map<string, string>();
  private readonly refs = new Set<string>(); // "repoURL\0ref"
  /** Every (repoURL, ref, credentialId) a clone was asked for — a test asserts the unit's OWN credential
   *  was used, and that the search cloned the delivery branch rather than a default one. */
  readonly clones: { repoURL: string; ref: string; credentialId?: string }[] = [];
  /** Workdirs still open — a test asserts every clone was disposed. */
  readonly open = new Set<string>();

  /** Mark a ref as EXISTING (so a clone succeeds) without putting a file on it. */
  seedRef(repoURL: string, ref: string): void {
    this.refs.add(`${repoURL}\0${ref}`);
  }

  seed(repoURL: string, ref: string, path: string, content: string): void {
    this.seedRef(repoURL, ref);
    this.store.set(`${repoURL}\0${ref}\0${path}`, content);
  }

  async cloneAtRef(input: { repoURL: string; ref: string; credentialId?: string; signal?: AbortSignal }): Promise<ClonedRepo> {
    this.clones.push({ repoURL: input.repoURL, ref: input.ref, ...(input.credentialId ? { credentialId: input.credentialId } : {}) });
    if (!this.refs.has(`${input.repoURL}\0${input.ref}`)) {
      throw new Error(`fake unit repo: ${input.repoURL} has no ref ${input.ref}`);
    }
    const workdir = `/fake-unit/${encodeURIComponent(input.repoURL)}/${encodeURIComponent(input.ref)}`;
    this.open.add(workdir);
    return { workdir, resolvedSha: "a".repeat(40) };
  }

  async readFile(workdir: string, relPath: string): Promise<string | null> {
    const [, repoURL, ref] = workdir.split("/fake-unit/")[1]!.match(/^([^/]+)\/([^/]+)$/) ?? [];
    return this.store.get(`${decodeURIComponent(repoURL!)}\0${decodeURIComponent(ref!)}\0${relPath}`) ?? null;
  }

  async dispose(workdir: string): Promise<void> {
    this.open.delete(workdir);
  }
}

/** A stage registration as commitRegistration writes it — flat `key: <json>` lines. */
export function stageRegistration(input: {
  name: string;
  repoURL: string;
  repoCredentialId?: string;
  chartPath: string;
  cluster: string;
  suspended?: boolean;
  quiesced?: boolean;
}): string {
  const entry: Record<string, unknown> = {
    name: input.name,
    repoURL: input.repoURL,
    ...(input.repoCredentialId ? { repoCredentialId: input.repoCredentialId } : {}),
    suspended: input.suspended ?? false,
    quiesced: input.quiesced ?? false,
    chartPath: input.chartPath,
    cluster: input.cluster,
    databases: [],
    services: [],
    // Part of the deploy group since the size choice was wired: a stage registration without it
    // fails the schema, so the fixture carries the chart's own default like a real one does.
    size: "small", mongodb: "shared", quota: seedQuota("small"),
  };
  return (
    Object.entries(entry)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n") + "\n"
  );
}

/** A build-only registration — no deploy group, so it carries no chartPath and pins nothing. */
export function buildRegistration(input: { name: string; repoURL: string; builds: string[] }): string {
  const entry = { name: input.name, repoURL: input.repoURL, suspended: false, quiesced: false, builds: input.builds };
  return (
    Object.entries(entry)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n") + "\n"
  );
}

/** A values file that pins the given `<image>:<tag>` pairs under the builds[] grammar. */
export function pinFile(pins: readonly [image: string, tag: string][]): string {
  return ["builds:", ...pins.flatMap(([image, tag]) => [`  - name: ${image}`, `    image: ${image}`, `    tag: "${tag}"`]), ""].join("\n");
}
