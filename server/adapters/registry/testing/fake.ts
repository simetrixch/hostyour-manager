// In-memory RegistryProbe fake for the onboarding domain tests — no network. Defaults to "every
// image is present" so the existing create-tenant/add-app suites run the ensure-images step as a
// pure pass; a test scripts missing tags to exercise the failure path. Records every probe so a
// test can assert exactly which <repo>:<tag> coordinates the step checked.
import type { RegistryProbe, ImageRef, RegistryMaintenance, ManifestDigest } from "../port.ts";

export class FakeRegistryProbe implements RegistryProbe {
  /** Every probed coordinate, in order, as "<repo>:<tag>". */
  readonly probes: string[] = [];
  private readonly missing: Set<string>;

  constructor(scripted: {
    /** "<repo>:<tag>" keys the registry does not hold — models an image that was never released. */
    missing?: readonly string[];
  } = {}) {
    this.missing = new Set(scripted.missing ?? []);
  }

  async imageExists(ref: ImageRef): Promise<boolean> {
    const key = `${ref.repo}:${ref.tag}`;
    this.probes.push(key);
    return !this.missing.has(key);
  }
}

/**
 * In-memory RegistryMaintenance fake for the registry-reaper domain tests — no network. Backed by a
 * repo → (tag → digest) map so a test scripts exactly what the catalog holds; a shared digest across
 * two tags is modelled by giving them the same digest string. Records every deleteManifest so a test
 * can assert EXACTLY which (repo, digest) the reaper removed — and that it removed nothing it should
 * not have. `scripted.throwListTags` / `throwDigest` model an undecidable registry so a test can
 * prove the reaper fails closed.
 */
export class FakeRegistryMaintenance implements RegistryMaintenance {
  private readonly repos: Map<string, Map<string, ManifestDigest>>;
  /** Every (repo, digest) a deleteManifest removed, in order — a test asserts EXACTLY these. */
  readonly deleted: { repo: string; digest: ManifestDigest }[] = [];
  private readonly throwListTags: Set<string>;
  private readonly throwDigest: Set<string>; // "<repo>:<tag>"

  constructor(
    seed: Record<string, Record<string, ManifestDigest>> = {},
    scripted: { throwListTags?: readonly string[]; throwDigest?: readonly string[] } = {},
  ) {
    this.repos = new Map(Object.entries(seed).map(([repo, tags]) => [repo, new Map(Object.entries(tags))]));
    this.throwListTags = new Set(scripted.throwListTags ?? []);
    this.throwDigest = new Set(scripted.throwDigest ?? []);
  }

  async listRepos(): Promise<string[]> {
    return [...this.repos.keys()];
  }

  async listTags(repo: string): Promise<string[]> {
    if (this.throwListTags.has(repo)) throw new Error(`scripted listTags failure for ${repo}`);
    return [...(this.repos.get(repo)?.keys() ?? [])];
  }

  async resolveDigest(repo: string, tag: string): Promise<ManifestDigest> {
    if (this.throwDigest.has(`${repo}:${tag}`)) throw new Error(`scripted resolveDigest failure for ${repo}:${tag}`);
    const digest = this.repos.get(repo)?.get(tag);
    // A missing manifest THROWS, mirroring the real adapter's fail-closed 404-throws contract (the
    // reaper resolves a tag it just listed, so absence is a race, never a normal answer).
    if (digest === undefined) throw new Error(`fake registry: no manifest for ${repo}:${tag}`);
    return digest;
  }

  async deleteManifest(repo: string, digest: ManifestDigest): Promise<void> {
    this.deleted.push({ repo, digest });
    const tags = this.repos.get(repo);
    if (tags) for (const [t, d] of [...tags]) if (d === digest) tags.delete(t); // strip every tag on that digest
  }
}
