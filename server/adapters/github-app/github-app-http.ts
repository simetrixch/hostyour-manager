// The concrete GitHub App client (fetch, no SDK — the same rationale as the two GitHub clients
// beside it). The JWT is minted with node's own crypto: an RS256 signature over two base64url JSON
// parts is six lines, and node's createPrivateKey reads the PKCS#1 PEM GitHub hands out as well as a
// PKCS#8 one, which the jose importer this process uses for sessions does not. Mirrors the consumer
// client's request/header/error style (Bearer, x-github-api-version, user-agent).
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { GitHubApp, CreateRepositoryInput } from "./port.ts";
import { GitHubAppError } from "./port.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";

type FetchLike = typeof fetch;

/** The JWT is dated a minute into the past: GitHub refuses a token whose iat is ahead of its own
 *  clock, and a minute covers the drift between two well-kept clocks. */
const JWT_BACKDATE_S = 60;
/** Nine minutes, under GitHub's ten-minute ceiling on an App JWT; it is minted per request, so the
 *  length only has to outlive one round trip. */
const JWT_LIFETIME_S = 9 * 60;
/** A token handed out stays valid at least this long; a cached one with less life left is minted
 *  afresh. The longest holder is the build secret the App-token refresh writes: it is read until the
 *  next refresh (boot/refresh-app-tokens-schedule.ts), plus the time a pipeline takes to reach its
 *  clone. GitHub gives a token one hour, so the cache serves the same token for about ten minutes. */
export const TOKEN_MIN_VALIDITY_MS = 50 * 60_000;

const base64urlJson = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export class HttpGitHubApp implements GitHubApp {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly key: KeyObject;
  private token: { value: string; expiresAt: number } | undefined;
  private org: string | undefined;

  /** `fetchImpl` is injectable so tests never hit the network. The key is parsed ONCE here, so a PEM
   *  node cannot read fails where the client is built and not at the first run. */
  constructor(private readonly opts: { appId: string; installationId: string; privateKey: string; apiBase?: string; fetchImpl?: FetchLike }) {
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.key = createPrivateKey(opts.privateKey);
  }

  /** The App's own JWT: RS256 over {iat, exp, iss}, iss being the App id. Minted per request — it
   *  lives nine minutes and nothing here holds a request open that long. */
  private appJwt(): string {
    const nowS = Math.floor(Date.now() / 1000);
    const signingInput = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${base64urlJson({ iat: nowS - JWT_BACKDATE_S, exp: nowS + JWT_LIFETIME_S, iss: this.opts.appId })}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.key, "base64url");
    return `${signingInput}.${signature}`;
  }

  /** The per-call auth + version headers. The credential rides ONLY here (the Bearer header) — never
   *  a URL, a body field, or a log line. */
  private headers(bearer: string): Record<string, string> {
    return {
      authorization: `Bearer ${bearer}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "hostyour-manager",
    };
  }

  /** Thin fetch wrapper: merges the auth headers over any caller headers (auth ALWAYS wins) and turns a
   *  transport error into a GitHubAppError. It does NOT throw on a non-2xx — createRepository reads
   *  the 422 that means "already exists" itself. */
  private async send(bearer: string, path: string, init: RequestInit | undefined): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, { ...init, headers: { ...(init?.headers ?? {}), ...this.headers(bearer) } });
    } catch (e) {
      throw new GitHubAppError(`GitHub request failed (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** GitHub's own message off a non-2xx body, with the per-field errors a 422 carries appended —
   *  never a generic mask. */
  private static async ghMessage(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
    const details = (body?.errors ?? []).map((e) => e.message).filter((m): m is string => typeof m === "string");
    return [body?.message ?? res.statusText, ...details].join(": ");
  }

  private get installationPath(): string {
    return `/app/installations/${encodeURIComponent(this.opts.installationId)}`;
  }

  identityFingerprint(): string {
    return fingerprintSecret(Buffer.from(`github-app:${this.opts.appId}:${this.opts.installationId}`, "utf8"));
  }

  async installationToken(signal?: AbortSignal): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_MIN_VALIDITY_MS) return this.token.value;
    const path = `${this.installationPath}/access_tokens`;
    const res = await this.send(this.appJwt(), path, { method: "POST", ...(signal ? { signal } : {}) });
    if (!res.ok) throw new GitHubAppError(`GitHub POST ${path} → ${res.status}: ${await HttpGitHubApp.ghMessage(res)}`, res.status);
    const body = (await res.json()) as { token?: string; expires_at?: string };
    const expiresAt = Date.parse(body.expires_at ?? "");
    if (!body.token || Number.isNaN(expiresAt)) throw new GitHubAppError(`GitHub POST ${path} returned no token with an expires_at`);
    this.token = { value: body.token, expiresAt };
    return body.token;
  }

  async installationOrg(signal?: AbortSignal): Promise<string> {
    if (this.org !== undefined) return this.org;
    const path = this.installationPath;
    const res = await this.send(this.appJwt(), path, signal ? { signal } : undefined);
    if (!res.ok) throw new GitHubAppError(`GitHub GET ${path} → ${res.status}: ${await HttpGitHubApp.ghMessage(res)}`, res.status);
    const body = (await res.json()) as { account?: { login?: string } };
    if (!body.account?.login) throw new GitHubAppError(`GitHub GET ${path} returned no account.login`);
    this.org = body.account.login;
    return this.org;
  }

  async reachesRepository(input: { owner: string; repo: string; signal?: AbortSignal }): Promise<boolean> {
    const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/installation`;
    const res = await this.send(this.appJwt(), path, input.signal ? { signal: input.signal } : undefined);
    if (res.status === 404) return false;
    if (!res.ok) throw new GitHubAppError(`GitHub GET ${path} → ${res.status}: ${await HttpGitHubApp.ghMessage(res)}`, res.status);
    const body = (await res.json()) as { id?: number };
    return String(body.id ?? "") === String(this.opts.installationId);
  }

  async createRepository(input: CreateRepositoryInput): Promise<{ created: boolean }> {
    const path = `/orgs/${encodeURIComponent(input.org)}/repos`;
    const res = await this.send(await this.installationToken(input.signal), path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: input.name, description: input.description, private: input.private }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (res.status === 201) return { created: true };
    const message = await HttpGitHubApp.ghMessage(res);
    // GitHub's one answer for a name that is taken: a 422 whose field error reads "name already
    // exists on this account". Any other 422 (a name it refuses outright) is a real refusal.
    if (res.status === 422 && /already exists/i.test(message)) return { created: false };
    throw new GitHubAppError(`GitHub POST ${path} → ${res.status}: ${message}`, res.status);
  }
}
