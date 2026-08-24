// gate-runner/src/gates/secret-contract.gate.ts
// G7 "secret contract" (hard). Validates the rendered SecretStore + ExternalSecret documents
// against the single-Vault injection contract. Two rules, both fail-closed:
//   every rendered SecretStore must authenticate to Vault with the role "consumer-eso" and
//        point at the cluster's own Vault URL. That URL is read back out of the SAME values chain
//        G3 rendered with (`global.endpoints.vault.url`, last file that sets it wins), so the gate holds the
//        render against the cluster's value rather than against anything the Manager computed.
//        The rendered-output equality on `server` is the SOLE control against a chart hardcoding a
//        non-templated `server:` literal, so it stays hard.
//   every rendered ExternalSecret must read from the expected secret path
//        `<stage>/consumer/<name>/app`, and every property it extracts must be a key the consumer
//        actually DECLARED in its manifest (manifest.secrets[].key). An ExternalSecret that
//        references an undeclared property is a foretold boot failure (the key is absent in Vault),
//        so it is rejected rather than warned. The cluster-scoped sibling ClusterExternalSecret
//        carries the SAME read spec nested under `spec.externalSecretSpec` (and a namespaceSelector
//        that fans the Secret into arbitrary namespaces), so it is held to the identical key + declared-property checks.
// Declared-but-unreferenced manifest keys are advisory only (surfaced in `found`, never blocking).
// ctx.rendered[i].raw is UNTRUSTED parsed YAML — every nested read is guarded (typeof / Array
// checks), and every untrusted string embedded in the report text is truncated, so a hostile chart
// can neither crash the gate nor push the report over the text caps.
import { parse } from "yaml";
import type { CheckGate, GateContext, RenderedDoc } from "./gate.ts";
import type { GateEvidence, GateResult, GateSeverity } from "../../../shared/gates.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import { fail, pass } from "./result.ts";

const ID = "G7";
const TITLE = "secret contract";
const SEVERITY: GateSeverity = "hard";
const CONSUMER_ROLE = "consumer-eso";

const EXPECTED =
  "SecretStore role==consumer-eso + server==the cluster chain's global.endpoints.vault.url; every " +
  "ExternalSecret / ClusterExternalSecret remoteRef.key==<stage>/consumer/<name>/app " +
  "referencing only manifest-declared secrets";

// --- untrusted-value guards ---------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The cluster's Vault URL as the values chain resolves it: walk the files in layering order and keep
 *  the last `global.endpoints.vault.url` that is set — the same last-wins merge helm performs over
 *  these files in G3's render. An unparseable file contributes nothing; null means no file in the
 *  chain sets the key, which leaves nothing to hold the rendered SecretStore against. */
export function chainVaultServer(files: readonly ClusterValueFile[]): string | null {
  let found: string | null = null;
  for (const file of files) {
    let doc: unknown;
    try {
      doc = parse(file.content);
    } catch {
      continue;
    }
    const root = asRecord(doc);
    const globals = root ? asRecord(root.global) : null;
    const endpoints = globals ? asRecord(globals.endpoints) : null;
    const vault = endpoints ? asRecord(endpoints.vault) : null;
    const url = vault ? asString(vault.url) : null;
    if (url !== null) found = url;
  }
  return found;
}

/** Quote an untrusted string for report text, truncated so a giant hostile value cannot blow the
 *  text caps. `null` (field absent / wrong type) renders as a plain marker. */
function q(v: string | null): string {
  if (v === null) return "<missing>";
  const s = v.length > 120 ? `${v.slice(0, 117)}...` : v;
  return `"${s}"`;
}

/** Build a rendered-doc evidence pin, omitting `value` when there is nothing concrete to cite
 *  (exactOptionalPropertyTypes forbids an explicit `value: undefined`). */
function pin(doc: RenderedDoc, fieldPath: string, value: string | null): GateEvidence {
  const v = value === null ? undefined : value.length > 256 ? value.slice(0, 256) : value;
  return {
    source: "rendered",
    docIndex: doc.docIndex,
    kind: doc.kind,
    name: doc.name,
    fieldPath,
    ...(v !== undefined ? { value: v } : {}),
  };
}

/** Collect string values at any property named `role` or `roleRef` inside an untrusted Vault-auth
 *  subtree. Depth-bounded so a hostile deeply-nested object cannot exhaust the stack. Being liberal
 *  about WHERE the role sits (kubernetes.role, appRole.roleRef, …) is intentional; the CONTROL is
 *  that whatever role is found must equal "consumer-eso". */
function collectRoles(node: unknown, depth: number, out: string[]): void {
  if (depth > 6) return;
  const rec = asRecord(node);
  if (!rec) return;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "role" || k === "roleRef") {
      const s = asString(v);
      if (s !== null) out.push(s);
    }
    if (asRecord(v)) collectRoles(v, depth + 1, out);
  }
}

// --- per-document checks ------------------------------------------------------------------------

function checkStore(doc: RenderedDoc, vaultServer: string, problems: string[], evidence: GateEvidence[]): void {
  const spec = asRecord(doc.raw.spec);
  const provider = spec ? asRecord(spec.provider) : null;
  const vault = provider ? asRecord(provider.vault) : null;

  const server = vault ? asString(vault.server) : null;
  if (server !== vaultServer) {
    problems.push(
      `SecretStore ${q(doc.name)} (doc ${doc.docIndex}) targets Vault server ${q(server)} but the ` +
        `cluster's global.endpoints.vault.url is ${q(vaultServer)}`,
    );
    evidence.push(pin(doc, "spec.provider.vault.server", server));
  }

  const roles: string[] = [];
  if (vault) collectRoles(vault, 0, roles);
  const roleOk = roles.length > 0 && roles.every((r) => r === CONSUMER_ROLE);
  if (!roleOk) {
    const seen = roles.length === 0 ? "absent" : roles.map(q).join(", ");
    problems.push(
      `SecretStore ${q(doc.name)} (doc ${doc.docIndex}) must authenticate to Vault with role ` +
        `${q(CONSUMER_ROLE)} but the rendered auth role is ${seen}`,
    );
    evidence.push(pin(doc, "spec.provider.vault.auth", roles.length === 0 ? null : roles.join(",")));
  }
}

/** Validate one ExternalSecret-shaped read spec (its data[].remoteRef and dataFrom[].extract). The
 *  same spec shape is carried directly under `spec` by an ExternalSecret and one level deeper under
 *  `spec.externalSecretSpec` by a cluster-scoped ClusterExternalSecret; the caller resolves which
 *  record holds it and passes the matching `specPath` prefix so evidence field paths stay accurate. */
function checkExternalSecret(
  doc: RenderedDoc,
  esSpec: Record<string, unknown> | null,
  specPath: string,
  expectedKey: string,
  declaredKeys: ReadonlySet<string>,
  referenced: Set<string>,
  problems: string[],
  evidence: GateEvidence[],
): void {
  asArray(esSpec ? esSpec.data : []).forEach((entry, i) => {
    const rec = asRecord(entry);
    const remoteRef = rec ? asRecord(rec.remoteRef) : null;
    const key = remoteRef ? asString(remoteRef.key) : null;
    const property = remoteRef ? asString(remoteRef.property) : null;
    const base = `${specPath}.data[${i}].remoteRef`;
    if (key !== expectedKey) {
      problems.push(
        `${doc.kind} ${q(doc.name)} (doc ${doc.docIndex}) ${base}.key is ${q(key)} but must equal ` +
          `${q(expectedKey)}`,
      );
      evidence.push(pin(doc, `${base}.key`, key));
    }
    if (property !== null) {
      referenced.add(property);
      if (!declaredKeys.has(property)) {
        problems.push(
          `${doc.kind} ${q(doc.name)} (doc ${doc.docIndex}) ${base}.property ${q(property)} is not ` +
            `declared in manifest.secrets[].key`,
        );
        evidence.push(pin(doc, `${base}.property`, property));
      }
    }
  });

  asArray(esSpec ? esSpec.dataFrom : []).forEach((entry, i) => {
    const rec = asRecord(entry);
    const extract = rec ? asRecord(rec.extract) : null;
    const key = extract ? asString(extract.key) : null;
    const base = `${specPath}.dataFrom[${i}].extract`;
    if (key !== expectedKey) {
      problems.push(
        `${doc.kind} ${q(doc.name)} (doc ${doc.docIndex}) ${base}.key is ${q(key)} but must equal ` +
          `${q(expectedKey)}`,
      );
      evidence.push(pin(doc, `${base}.key`, key));
    }
  });
}

/** Join at most CAP problems into report text; the rest are counted, not spelled out, so a chart
 *  emitting hundreds of violations cannot push `found`/`reason` past the caps. */
function joinCapped(items: string[], cap: number): string {
  if (items.length <= cap) return items.join("; ");
  return `${items.slice(0, cap).join("; ")}; and ${items.length - cap} more violation(s)`;
}

function check(ctx: GateContext): GateResult {
  if (ctx.manifest === null) {
    return fail({
      id: ID,
      title: TITLE,
      severity: SEVERITY,
      expected: EXPECTED,
      found:
        "The manifest could not be parsed (G1 produced no ConsumerManifest), so the set of declared " +
        "secret keys that every ExternalSecret property must reference is unknown.",
      reason:
        "Without a parsed manifest the SecretStore and ExternalSecret references cannot be checked " +
        "against the declared secrets, so the secret contract is unverifiable; the plan is rejected " +
        "fail-closed.",
    });
  }

  const declaredKeys = new Set<string>(ctx.manifest.secrets.map((s) => s.key));
  const expectedKey = `${ctx.stage}/consumer/${ctx.targetName}/app`;
  const vaultServer = chainVaultServer(ctx.clusterValueFiles);
  if (vaultServer === null) {
    return fail({
      id: ID,
      title: TITLE,
      severity: SEVERITY,
      expected: EXPECTED,
      found:
        `No file of the cluster values chain (${ctx.clusterValueFiles.map((f) => f.path).join(", ") || "none supplied"}) ` +
        "sets global.endpoints.vault.url, so the cluster's Vault server is unknown.",
      reason:
        "Without the cluster's Vault URL the rendered SecretStore's `server` cannot be held against " +
        "anything, which is the sole control against a chart hardcoding its own Vault; the plan " +
        "is rejected fail-closed.",
    });
  }

  const problems: string[] = [];
  const evidence: GateEvidence[] = [];
  const referenced = new Set<string>();
  let storeCount = 0;
  let esCount = 0;

  for (const doc of ctx.rendered) {
    // G7 validates the render that will ACTUALLY be deployed — the onboarding stage. The chart is
    // rendered for EVERY declared env (G3's kubeconform coverage), so ctx.rendered also carries the
    // dev/test SecretStores + ExternalSecrets whose remoteRef.key embeds THOSE stages; measuring them
    // against the onboarding stage's expected key (<stage>/consumer/<name>/app) is a false positive
    // (a correct chart templates the stage from the cluster chain's `global.env`). The other rendered-doc
    // gates still inspect all envs; only this stage-specific secret-path gate scopes to ctx.stage.
    if (doc.env !== ctx.stage) continue;
    if (doc.kind === "SecretStore") {
      storeCount += 1;
      checkStore(doc, vaultServer, problems, evidence);
    } else if (doc.kind === "ExternalSecret") {
      esCount += 1;
      checkExternalSecret(doc, asRecord(doc.raw.spec), "spec", expectedKey, declaredKeys, referenced, problems, evidence);
    } else if (doc.kind === "ClusterExternalSecret") {
      // Cluster-scoped sibling (external-secrets.io): the identical read spec is nested one level
      // deeper under spec.externalSecretSpec, and its namespaceSelector fans the resulting Secret
      // into arbitrary namespaces — so it must clear the same key + declared-property checks.
      esCount += 1;
      const outer = asRecord(doc.raw.spec);
      const esSpec = outer ? asRecord(outer.externalSecretSpec) : null;
      checkExternalSecret(
        doc,
        esSpec,
        "spec.externalSecretSpec",
        expectedKey,
        declaredKeys,
        referenced,
        problems,
        evidence,
      );
    }
  }

  const unreferenced = [...declaredKeys].filter((k) => !referenced.has(k));
  const unrefNote =
    unreferenced.length > 0
      ? ` Advisory (non-blocking): ${unreferenced.length} declared manifest secret key(s) are not ` +
        `read by any ExternalSecret: ${joinCapped(unreferenced.map(q), 8)}.`
      : "";
  const scanned =
    `Inspected ${storeCount} rendered SecretStore and ${esCount} rendered ` +
    `ExternalSecret/ClusterExternalSecret document(s) for the onboarding stage ${q(ctx.stage)}; ` +
    `required SecretStore role ${q(CONSUMER_ROLE)} + server ${q(vaultServer)} and remoteRef key ${q(expectedKey)}.`;

  if (problems.length > 0) {
    const listed = joinCapped(problems, 3);
    return fail({
      id: ID,
      title: TITLE,
      severity: SEVERITY,
      expected: EXPECTED,
      found: `${scanned} Found ${problems.length} violation(s): ${listed}.${unrefNote}`,
      reason:
        `${listed}. A hardcoded or incorrect Vault server or auth role escapes the cluster's ` +
        `single-Vault fence, and an ExternalSecret key or property that does not match the ` +
        `cluster's secret path or a manifest-declared secret is a foretold boot failure; the ` +
        `plan is rejected.`,
      evidence: evidence.slice(0, 20),
    });
  }

  return pass({
    id: ID,
    title: TITLE,
    severity: SEVERITY,
    expected: EXPECTED,
    found:
      `${scanned} Every SecretStore uses role ${q(CONSUMER_ROLE)} and the cluster's Vault server, and ` +
      `every ExternalSecret reads the expected key with only manifest-declared properties.${unrefNote}`,
  });
}

export const secretContractGate: CheckGate = { id: ID, title: TITLE, severity: SEVERITY, check };
