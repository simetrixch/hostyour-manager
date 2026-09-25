// In-memory GitHubApp fake for the run and boot tests — no network, no key. The token and the
// owner are scripted, the repositories are a set keyed `org/name` so createRepository is
// genuinely idempotent (a seeded or already created name answers {created:false}), and every create
// that made a repository is recorded so a test can assert what a run created and where.
import type { GitHubApp, CreateRepositoryInput } from "../port.ts";

export class FakeGitHubApp implements GitHubApp {
  /** What installationToken answers — the value a test expects to see handed on as a per-call PAT. */
  token = "ghs_fake_installation_token";
  /** What installationOrg answers — the owner the fake installation is bound to. */
  org = "example-org";
  /** What identityFingerprint answers — what a sealed github-app credential carries. */
  fingerprint = "sha256:fakeappidentity0";
  /** When set, every call throws it — the App identity that GitHub refuses (a revoked key, a
   *  suspended installation, an unreachable API). */
  failWith: Error | null = null;
  /** Every repository standing in the fake, as `org/name`. */
  /** Every repository standing in the owner, as `org/name` — what a test asserts STAYS (#241). */
  readonly repos = new Set<string>();
  /** What reachesRepository answers beyond the default: the default is every repository of `org`
   *  (an installation on all repositories of its owner) and no other; a test that needs a
   *  repository outside the owner reached, or one inside it not reached, sets it here. */
  readonly reachable = new Map<string, boolean>();
  /** Only the calls that actually created a repository — not the idempotent-skip calls. */
  readonly created: CreateRepositoryInput[] = [];

  /** Pre-seed a standing repository so a test can drive the already-exists path. */
  seedRepository(org: string, name: string): void {
    this.repos.add(`${org}/${name}`);
  }

  /** Whether a repository stands right now — the shape a test asserts against. */
  hasRepository(org: string, name: string): boolean {
    return this.repos.has(`${org}/${name}`);
  }

  async installationToken(): Promise<string> {
    if (this.failWith) throw this.failWith;
    return this.token;
  }

  async installationOrg(): Promise<string> {
    if (this.failWith) throw this.failWith;
    return this.org;
  }

  identityFingerprint(): string {
    return this.fingerprint;
  }

  async reachesRepository(input: { owner: string; repo: string }): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.reachable.get(`${input.owner}/${input.repo}`) ?? input.owner === this.org;
  }

  async createRepository(input: CreateRepositoryInput): Promise<{ created: boolean }> {
    if (this.failWith) throw this.failWith;
    const key = `${input.org}/${input.name}`;
    if (this.repos.has(key)) return { created: false };
    this.repos.add(key);
    this.created.push(input);
    return { created: true };
  }
}
