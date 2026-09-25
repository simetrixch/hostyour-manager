// The helpers every validateOnboard test builds its world from: the request and the target, the
// runner's report, the registration reader over the other units' claims, and the deps around them.
import { ConsumerManifestSchema, type ConsumerManifest } from "../../../shared/consumer.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import type { GateReport, GateResult } from "../../../shared/gates.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { GateRunner } from "../../adapters/gate-runner/port.ts";
import type { OnboardTarget, OnboardRequest, ValidateDeps, AttestedBuildReader, AttestedFqdnReader, AttestedSmtpSenderReader } from "./validate.ts";

export const SHA = "a".repeat(40);
export const RELEASE = "1.4.0-stable-20260719120000";


export function req(over: Partial<OnboardRequest> = {}): OnboardRequest {
  return { repoURL: "https://github.com/x/acme.git", ref: RELEASE, consumerName: "acme", size: "medium", ...over };
}

export function target(over: Partial<OnboardTarget> = {}): OnboardTarget {
  return {
    domain: "s1.example",
    stage: "dev",
    chartPath: "deploy/chart",
    clusterValueFiles: [
      { path: "clusters/platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
      { path: "clusters/platform/values-dev.yaml", content: "global:\n  env: dev\n" },
      { path: clusterMapPath("s1.example"), content: "global:\n  endpoints:\n    vault:\n      url: https://vault.s1.example:8200\n" },
    ],
    ...over,
  };
}

export function report(gate: GateResult, verdict: "pass" | "fail", manifest: ConsumerManifest | null = null): GateReport {
  return {
    contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "main", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [], gates: [gate],
    sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
    verdict, reportHash: "runner-hash",
  };
}

export const g1Pass: GateResult = { id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "deploy/platform.yaml validates", found: "parsed", reason: null, detail: "ok" };
export const g1Fail: GateResult = { id: "G1", title: "manifest present", severity: "hard", status: "fail", expected: "deploy/platform.yaml validates", found: "missing", reason: "no manifest; the plan is rejected", detail: "missing" };

/** In-memory registration reader — the build names and fqdns OTHER units have registered. */
export class FakeAttestedBuilds implements AttestedBuildReader, AttestedFqdnReader, AttestedSmtpSenderReader {
  readonly asked: string[] = [];
  readonly askedFqdns: string[] = [];
  constructor(
    private readonly attested: { unit: string; build: string }[] = [],
    private readonly fqdns: { unit: string; stage: "dev" | "test" | "prod"; fqdn: string }[] = [],
    private readonly senders: { unit: string; cluster: string; entry: { service: string; port: number } }[] = [],
  ) {}
  async listSmtpSenders(_stage: "dev" | "test" | "prod"): Promise<{ unit: string; cluster: string; entry: { service: string; port: number } }[]> {
    return this.senders;
  }
  async listAttestedBuildNames(exceptUnit: string): Promise<{ unit: string; build: string }[]> {
    this.asked.push(exceptUnit);
    return this.attested.filter((a) => a.unit !== exceptUnit);
  }
  async listAttestedFqdns(except: { unit: string; stage: "dev" | "test" | "prod" }): Promise<{ unit: string; stage: "dev" | "test" | "prod"; fqdn: string }[]> {
    this.askedFqdns.push(`${except.unit}@${except.stage}`);
    return this.fqdns.filter((a) => !(a.unit === except.unit && a.stage === except.stage));
  }
  /** The labels other units stand on — every attested unit on its own name here, which is what a
   *  registration without `host` means. */
  async listAttestedHostLabels(_stage: "dev" | "test" | "prod", except: { unit: string }): Promise<{ unit: string; host: string }[]> {
    return [...new Set(this.attested.map((a) => a.unit))].filter((u) => u !== except.unit).map((u) => ({ unit: u, host: u }));
  }
}

export function deps(repo: RepoReader, runner: GateRunner, over: Partial<ValidateDeps> = {}): ValidateDeps {
  // The zone answers "free" unless a case says otherwise — G27 reads it for every deployable target
  // whose chain names the apex.
  return { repo, runner, registrations: new FakeAttestedBuilds(), tenantSubdomains: async () => [], log: () => {}, signal: new AbortController().signal, declareListening: true, resolveQuota: (size, brings) => seedQuota(size, brings), standingHost: async () => ({ kind: "free" as const }), ...over };
}

/** A manifest that declares `builds`, with a chart unless `chart` is false. */
export function manifestWith(builds: string[], chart = true, fqdn?: string): ConsumerManifest {
  return ConsumerManifestSchema.parse({
    apiVersion: "hostyour.cloud/v1",
    kind: "ConsumerManifest", mongodb: "shared" as const,
    name: "acme",
    owner: "team-acme",
    envs: ["dev"],
    ...(chart ? { chart: { path: "deploy/chart" } } : {}),
    builds: builds.map((name) => ({ name, containerfile: `${name}/Containerfile` })),
    ...(fqdn !== undefined ? { fqdn } : {}),
  });
}

/** A values chain that states the unitApex — what G19 holds a declared fqdn's suffix against. */
export const APEX_CHAIN = [
  { path: "clusters/platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
  { path: "clusters/platform/values-dev.yaml", content: "global:\n  env: dev\n" },
  { path: clusterMapPath("s1.example"), content: "global:\n  unitApex: units.example.com\n" },
];

export const pinFile = (...images: string[]): string =>
  ["builds:", ...images.map((i) => `  - name: ${i}\n    image: ${i}\n    tag: "0.0.0-placeholder"`)].join("\n") + "\n";
