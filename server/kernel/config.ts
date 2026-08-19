import { join } from "node:path";
import { z } from "zod";
import { STAGE, CLUSTER_TIER } from "../../shared/enums.ts";

// zod fail-fast env. The redirect URI + cookie flags are DERIVED from
// PUBLIC_URL once, never from a request URL — the L1 lesson (old console built the
// callback from the proxied req.url and got http:// behind the TLS proxy).
const EnvSchema = z.object({
  PUBLIC_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  ADMINS_GROUP: z.string().min(1).default("admins"),
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(1800),
  SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().positive().default(43200),
  PORT: z.coerce.number().int().positive().default(8484),
  EMERGENCY_PORT: z.coerce.number().int().positive().default(8485),
  DATA_DIR: z.string().min(1),
  // OPTIONAL kubeconfig-file override for every kube client (dev/test — point the adapters at a
  // file). Unset/empty ⇒ the clients load the pod ServiceAccount's in-cluster credentials
  // (kube.ts buildKubeConfig → loadFromCluster): the Controller acts on its OWN cluster over RBAC
  // bound to its SA — no kubeconfig file is mounted anymore, and NO feature gates on this value.
  KUBECONFIG_PATH: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // The running image tag (apps/controller values imageTag), injected by the Deployment as
  // CONTROLLER_VERSION so the UI can show which version is live. REQUIRED and explicitly
  // declared in every environment (Deployment from imageTag, tests, dev) — no silent
  // default: a missing value must fail loudly at boot, never run on a quiet guess.
  CONTROLLER_VERSION: z.string().min(1),
  // Vault as the secrets DB. When VAULT_ADDR is set the credential store
  // keeps its secret VALUES in Vault KV (metadata stays in SQLite); unset ⇒ local keyfile/
  // plaintext (dev/tests). Auth is Vault kubernetes-auth via the pod's ServiceAccount token.
  VAULT_ADDR: z.string().url().optional(),
  VAULT_K8S_ROLE: z.string().default("controller"),
  VAULT_KV_PREFIX: z.string().default("controller/cred"),
  // The kubernetes auth mount is named after the cluster (kubernetes-<cluster>) and exists nowhere
  // else, so there is no value that is right by default. REQUIRED whenever VAULT_ADDR is set: a
  // default would send every login to a mount that does not exist and turn a wiring mistake into a
  // 403 at the first credential read instead of a boot error. The controller chart sets it from
  // global.vaultKubernetesAuthPath.
  VAULT_K8S_AUTH_MOUNT: z.string().min(1).optional(),
  VAULT_SA_TOKEN_PATH: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/token"),
  // Master self-registration (boot/seed-master.ts). When MASTER_FQDN is set the Controller
  // seeds the one role=master server row (this control host) so deploy-slave's loadMaster
  // finds it on a FRESH DB — no manual SQL. All optional: unset ⇒ no seeding (dev/tests).
  // MASTER_FQDN is the control host's FQDN == its install branch (masterFqdnOf reads host);
  // MASTER_SSH_USER is the OS account the deploy-slave master-side steps run as (its serve
  // conversations and the checkout upkeep at /srv/hostyour-cloud). MASTER_SSH_KEY_FILE is where the ESO-materialized private
  // key is mounted — read once at boot and sealed into the credential store so ctx.ssh(master)
  // can reach the host (the Controller SSHes to its OWN host over the LAN).
  // MASTER_SSH_HOST_KEY_FP is the master sshd's host-key fingerprint ("SHA256:…", the exact
  // shape adapters/ssh/ssh2-session.ts computes) — the installer reads it from the host key
  // and ships it via the same dedicated secret; seed-master pins it on the master row so the
  // SSH-to-self is authenticated (not MITM-able TOFU).
  MASTER_FQDN: z.string().min(1).optional(),
  MASTER_SSH_USER: z.string().min(1).optional(),
  MASTER_SSH_PORT: z.coerce.number().int().min(1).max(65535).default(22),
  MASTER_LAN_HOST: z.string().min(1).optional(),
  MASTER_SSH_KEY_FILE: z.string().min(1).optional(),
  MASTER_SSH_HOST_KEY_FP: z.string().min(1).optional(),
  // MASTER_SSH_HOST_KEY_FP_FILE: the SAME fingerprint as a mounted FILE. An env var is fixed at
  // container start and never refreshes; kubelet DOES refresh secret-volume files in a running
  // pod (~1min). seed-master reads this file FRESH on every attempt, so a secret that
  // materializes only AFTER boot (the fresh-install ESO/Vault-role race) converges without a
  // pod restart. This carries the PATH, not the value; the env var stays as a static fallback.
  MASTER_SSH_HOST_KEY_FP_FILE: z.string().min(1).optional(),
  // The control host is ALSO a cluster in the inventory (seed-master.ts seeds a clusters row for
  // it, slaveId=NULL). MASTER_STAGE is that self-cluster's stage (dev|test|prod) — the deployed
  // environment, injected by the Deployment as .Values.global.env; REQUIRED whenever MASTER_FQDN
  // is set (same guard as MASTER_SSH_USER — a master row without a stage cannot seed its cluster).
  MASTER_STAGE: z.enum(STAGE).optional(),
  // The self-cluster's tier (rehearsal|real). Defaults to "rehearsal": the crypto gate
  // refuses onboarding to a non-rehearsal cluster under a plaintext keystore, so the master stays
  // rehearsal until the keystore is hardened. Promotion to "real" is a one-way audited step.
  MASTER_TIER: z.enum(CLUSTER_TIER).default("rehearsal"),
  // GitHub repo access for the Branches view + the Reset wizard (delete install branches).
  // GITHUB_REPO is "owner/repo". GITHUB_WRITE_PAT is a fine-grained PAT with Contents: read+write
  // on THIS repo — but a token DEDICATED to the Controller host: it is NOT the platform's
  // GITOPS_REPO_PAT (which is read-only and gets copied by --slave-add into every slave namespace).
  // Keeping them separate is deliberate: a write-capable token must never be materialized in a
  // slave ns, or any slave-ns secret reader could push to master. Its Vault home is the
  // controller-host path, never a per-slave app path. BOTH or NEITHER — a partial config is a
  // boot error, never a half-enabled feature.
  GITHUB_REPO: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'GITHUB_REPO must be "owner/repo"').optional(),
  GITHUB_WRITE_PAT: z.string().min(1).optional(),
  // Consumer onboarding. Chart validation runs as an in-cluster
  // `gate-run` Tekton PipelineRun in the locked-down `gate-runner` namespace (a Calico egress fence + a
  // token-less pod) — NOT a host Quadlet. ONBOARD_GATE_CONTROLLER_ADDR is the Controller's OWN address
  // (host:port) the gate pod must PROVE it cannot reach; set ⇒ the onboarding Run family is registered
  // with its real adapters (git over GITHUB_*, kube in-cluster over the pod SA, the Tekton gate-runner)
  // and the consumer mutating routes go live; unset ⇒ they answer 501 NOT_CONFIGURED. The extra internal
  // must-fail probe targets (ONBOARD_GATE_FENCE_MUST_FAIL, csv of host:port; defaults to the controller
  // address) and the one must-pass egress (github, defaulted) complete the CLI's fail-closed fence probe.
  ONBOARD_GATE_CONTROLLER_ADDR: z.string().min(1).optional(),
  ONBOARD_GATE_FENCE_MUST_FAIL: z.string().default(""),
  ONBOARD_GATE_MUST_PASS: z.string().min(1).default("github.com:443"),
  ONBOARD_KUBE_VERSION: z.string().min(1).default("1.30.0"),
  // The consumer build webhook. The onboard `setup-webhook` step creates a
  // push-webhook on the consumer repo pointing at the image-builder EventListener ingress on the BUILD
  // PLANE (build.<build-plane-fqdn>/github); the EventListener validates each delivery's X-Hub-Signature-256
  // against a SHARED HMAC secret. GITHUB_WEBHOOK_SECRET is that secret — it must equal the
  // image-builder EventListener's Vault key <stage>/app/image-builder:github-webhook-secret. The
  // controller's seeder is WRITE-ONLY (it cannot read Vault back), so the secret is fed to the
  // controller as env via its OWN ExternalSecret (a parallel hostyour-cloud change). Absent ⇒ the onboard
  // setup-webhook step fails LOUD (a hook without the matching secret never triggers a build).
  // BUILD_EVENTLISTENER_SUBDOMAIN is the ingress subdomain (default "build") — overridable for a
  // non-standard cluster.
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  BUILD_EVENTLISTENER_SUBDOMAIN: z.string().min(1).default("build"),
  // The unit DNS record: the DNS-only Cloudflare token from secret/<stage>/app/cloudflare-dns,
  // fed to the controller as env off the controller-cloudflare-dns ExternalSecret's Secret. Set ⇒ the
  // DnsProvider is wired and the provision-dns/remove-dns steps work; unset ⇒ those steps fail LOUD
  // (DNS is a mandatory part of onboard, offboard and purge — never a silent skip).
  CLOUDFLARE_DNS_API_TOKEN: z.string().min(1).optional(),
  // Tenant (multi-app) onboarding. The central
  // catalog GitOps repo the live ApplicationSets read is a PLATFORM CONSTANT (owner/repo),
  // so it defaults and is rarely overridden. CATALOG_WRITE_PAT is the Controller's
  // first-party, write-capable PAT for it (Contents: read+write on catalog) — the SAME token
  // clones it for controller-side validation AND pushes tenant registrations onto the books branch. It is DISTINCT
  // from GITHUB_WRITE_PAT (that one writes the consumer platform repo); a second repo needs its own
  // credential. Set ⇒ the tenant Run family is registered (a SECOND platform repo bound to
  // catalog + the controller-side HelmRenderer, kube in-cluster over the pod SA);
  // unset ⇒ the tenant mutating routes answer 501. The tenant format is INDEPENDENT of the consumer
  // gate-runner
  // (tenant charts are trusted first-party, validated controller-side — no consumer gate-runner).
  CATALOG_REPO: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'CATALOG_REPO must be "owner/repo"').default("simetrixch/catalog"),
  CATALOG_WRITE_PAT: z.string().min(1).optional(),
  // The Hetzner Storage Box behind move, backup and restore: the staging area every dump
  // lands on and every restore reads from, reachable over SSH. The three values come from
  // secret/<stage>/app/storage-box via the controller's own ExternalSecret (the seeder is write-only,
  // so like GITHUB_WEBHOOK_SECRET they arrive as env, never as a Vault read-back). ALL THREE or NONE —
  // a partial config is a boot error. Absent ⇒ the backup/restore/migrate dump steps fail loud.
  STORAGE_BOX_HOST: z.string().min(1).optional(),
  STORAGE_BOX_USER: z.string().min(1).optional(),
  STORAGE_BOX_PASSWORD: z.string().min(1).optional(),
  // The machine-side deployment programs. The redeploy master arm drives deploy-cluster /
  // deploy-gitops through `ansiwise serve` on the target machine; this is the command that starts
  // that surface over the run's SSH session — and so names WHICH catalogue checkout the service
  // reads its programs from, which is the installation's decision, never an assumption. Absent ⇒
  // the program steps fail loud (errNotConfigured) and every other verb is untouched.
  ANSIWISE_SERVE_COMMAND: z.string().min(1).optional(),
  // The pinned dbtools job image (<registry-host>/dbtools:<tag>) the relocation Jobs
  // run — mongodb tools, postgresql client, an S3 client and SSH for the staging area. The pin lives
  // as a builds[] entry in apps/controller/values-<stage>.yaml and the Deployment projects it here,
  // the same road CONTROLLER_VERSION travels. Absent ⇒ the dump/restore steps fail loud.
  DBTOOLS_IMAGE: z.string().min(1).optional(),
}).refine((e) => !e.VAULT_ADDR || Boolean(e.VAULT_K8S_AUTH_MOUNT), {
  message: "VAULT_K8S_AUTH_MOUNT is required when VAULT_ADDR is set (the auth mount is named after the cluster, kubernetes-<cluster>)",
  path: ["VAULT_K8S_AUTH_MOUNT"],
}).refine((e) => !e.MASTER_FQDN || Boolean(e.MASTER_SSH_USER), {
  message: "MASTER_SSH_USER is required when MASTER_FQDN is set (the master row needs an ssh user)",
  path: ["MASTER_SSH_USER"],
}).refine((e) => !e.MASTER_FQDN || Boolean(e.MASTER_STAGE), {
  message: "MASTER_STAGE is required when MASTER_FQDN is set (the master self-cluster row needs a stage)",
  path: ["MASTER_STAGE"],
}).refine((e) => Boolean(e.GITHUB_REPO) === Boolean(e.GITHUB_WRITE_PAT), {
  message: "GITHUB_REPO and GITHUB_WRITE_PAT must be set together (both enable the Branches/Reset feature, or neither)",
  path: ["GITHUB_REPO"],
}).refine((e) => {
  const set = [e.STORAGE_BOX_HOST, e.STORAGE_BOX_USER, e.STORAGE_BOX_PASSWORD].filter(Boolean).length;
  return set === 0 || set === 3;
}, {
  message: "STORAGE_BOX_HOST, STORAGE_BOX_USER and STORAGE_BOX_PASSWORD must be set together (the staging area needs all three, or none)",
  path: ["STORAGE_BOX_HOST"],
});

export interface Config {
  publicUrl: string;
  origin: string;
  redirectUri: string;
  cookieSecure: boolean;
  oidc: { issuer: string; clientId: string; clientSecret: string; adminsGroup: string };
  session: { idleSeconds: number; absoluteSeconds: number };
  port: number;
  emergencyPort: number;
  dataDir: string;
  dbFile: string;
  /** OPTIONAL kubeconfig-file override for the kube clients (dev/test). Absent ⇒ the adapters use
   *  the pod ServiceAccount's in-cluster credentials (loadFromCluster) — the production mode.
   *  Never part of a feature's enable gate: onboarding goes live without it. */
  kubeconfigPath?: string;
  logLevel: string;
  /** The running image tag (from the Deployment's CONTROLLER_VERSION env = values imageTag).
   *  Required — explicitly declared per environment, never defaulted. Surfaced at /healthz
   *  and in the UI footer so the operator can see which version is live. */
  version: string;
  /** Present ⇒ store secret values in Vault KV (kubernetes-auth). Absent ⇒ local store. */
  vault?: {
    addr: string;
    k8sRole: string;
    kvPrefix: string;
    k8sAuthMount: string;
    saTokenPath: string;
  };
  /** Present ⇒ seed the role=master row (this control host) at boot (seed-master.ts).
   *  Absent ⇒ no seeding. keyFile is where the master self-SSH private key is mounted;
   *  hostKeyFp is the master sshd's host-key fingerprint to pin (SHA256:…); hostKeyFpFile is
   *  the same fingerprint as a mounted file (read FRESH each attempt — it refreshes in a
   *  running pod, the env does not; the file wins when readable). */
  master?: {
    fqdn: string;
    sshUser: string;
    sshPort: number;
    lanHost?: string;
    keyFile?: string;
    hostKeyFp?: string;
    hostKeyFpFile?: string;
    /** The self-cluster's stage (the deployed environment) and tier — seed-master.ts uses these to
     *  seed a clusters row for the control host itself (slaveId=NULL). tier defaults to "rehearsal". */
    stage: (typeof STAGE)[number];
    tier: (typeof CLUSTER_TIER)[number];
  };
  /** Present ⇒ the Branches view + Reset wizard can talk to GitHub. Absent ⇒ those routes report
   *  "not configured". owner/repo from GITHUB_REPO; token is the Controller-dedicated,
   *  write-capable GITHUB_WRITE_PAT (never the slave-copied read-only GITOPS_REPO_PAT). */
  github?: {
    owner: string;
    repo: string;
    token: string;
  };
  /** Present ⇒ consumer onboarding is wired (the Tekton gate-runner). The onboarding Run family is
   *  registered with its real adapters and the mutating consumer routes go live; also requires github
   *  (the platform repo + write PAT) — kube access is in-cluster via the pod SA, so no kubeconfig
   *  gates this. Absent ⇒ routes 501. `fence` is the egress self-probe the gate CLI proves
   *  fail-closed; `kubeVersion` is the kubeconform target. */
  onboarding?: {
    fence: { mustFailTargets: string[]; controllerAddr: string; mustPassTarget: string };
    kubeVersion: string;
  };
  /** Present ⇒ tenant (multi-app) onboarding is wired: the central catalog GitOps repo the
   *  live ApplicationSets read (repoURL, a platform constant) + the Controller's first-party,
   *  write-capable PAT for it (token). The SAME PAT clones catalog for controller-side
   *  validation and pushes tenant pointers to master. Independent of `onboarding` (the consumer
   *  gate-runner) — tenant charts are trusted first-party, validated controller-side; kube access
   *  is in-cluster via the pod SA. Absent ⇒ the tenant Run family answers 501. */
  catalog?: {
    repoURL: string;
    token: string;
  };
  /** The consumer build webhook. `subdomain` is the image-builder
   *  EventListener ingress label (default "build") the onboard step points the hook at
   *  (build.<build-plane-fqdn>/github); `secret` is the shared HMAC secret (GITHUB_WEBHOOK_SECRET) the
   *  EventListener validates deliveries against — ABSENT in dev, which makes the onboard setup-webhook
   *  step fail loud (no matching secret ⇒ no build would ever fire). Always present (subdomain always
   *  defaults); only `secret` is optional. */
  webhook: {
    subdomain: string;
    secret?: string;
  };
  /** Present ⇒ the unit DNS provider is wired: the DNS-only Cloudflare token the
   *  provision-dns/remove-dns steps manage the one record per unit with. Absent ⇒ those steps fail
   *  loud — DNS is a mandatory part of the verbs. */
  dns?: {
    cloudflareApiToken: string;
  };
  /** Present ⇒ the Hetzner Storage Box is wired: the SSH staging area every relocation dump
   *  lands on. Absent ⇒ the dump/restore steps fail loud — the box is a mandatory part of the verbs. */
  storageBox?: {
    host: string;
    user: string;
    password: string;
  };
  /** The pinned dbtools job image the relocation Jobs run. Absent ⇒ those steps fail loud. */
  dbtoolsImage?: string;
  /** The command that starts `ansiwise serve` on a target machine over the run's SSH session —
   *  the door to the machine's deployment programs (redeploy master arm). Absent ⇒ the program
   *  steps fail loud. */
  ansiwiseServeCommand?: string;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Pure + testable: throws ConfigError (never exits). */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const e = parsed.data;
  const pub = new URL(e.PUBLIC_URL);
  return {
    publicUrl: e.PUBLIC_URL,
    origin: pub.origin,
    redirectUri: new URL("/auth/callback", e.PUBLIC_URL).toString(),
    cookieSecure: pub.protocol === "https:",
    oidc: {
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      adminsGroup: e.ADMINS_GROUP,
    },
    session: { idleSeconds: e.SESSION_IDLE_SECONDS, absoluteSeconds: e.SESSION_ABSOLUTE_SECONDS },
    port: e.PORT,
    emergencyPort: e.EMERGENCY_PORT,
    dataDir: e.DATA_DIR,
    dbFile: join(e.DATA_DIR, "controller.db"),
    // Empty string counts as unset (deployments often template the var to "") — absent means
    // in-cluster, so the property is omitted rather than carried as a falsy sentinel.
    ...(e.KUBECONFIG_PATH ? { kubeconfigPath: e.KUBECONFIG_PATH } : {}),
    logLevel: e.LOG_LEVEL,
    version: e.CONTROLLER_VERSION,
    // The refine above guarantees VAULT_K8S_AUTH_MOUNT whenever VAULT_ADDR is set; the pair guard
    // narrows both.
    ...(e.VAULT_ADDR && e.VAULT_K8S_AUTH_MOUNT
      ? {
          vault: {
            addr: e.VAULT_ADDR,
            k8sRole: e.VAULT_K8S_ROLE,
            kvPrefix: e.VAULT_KV_PREFIX,
            k8sAuthMount: e.VAULT_K8S_AUTH_MOUNT,
            saTokenPath: e.VAULT_SA_TOKEN_PATH,
          },
        }
      : {}),
    // MASTER_FQDN, MASTER_SSH_USER and MASTER_STAGE are guaranteed together by the schema refines
    // above (MASTER_TIER always has its "rehearsal" default). The triple guard narrows all three.
    ...(e.MASTER_FQDN && e.MASTER_SSH_USER && e.MASTER_STAGE
      ? {
          master: {
            fqdn: e.MASTER_FQDN,
            sshUser: e.MASTER_SSH_USER,
            sshPort: e.MASTER_SSH_PORT,
            stage: e.MASTER_STAGE,
            tier: e.MASTER_TIER,
            ...(e.MASTER_LAN_HOST ? { lanHost: e.MASTER_LAN_HOST } : {}),
            ...(e.MASTER_SSH_KEY_FILE ? { keyFile: e.MASTER_SSH_KEY_FILE } : {}),
            ...(e.MASTER_SSH_HOST_KEY_FP ? { hostKeyFp: e.MASTER_SSH_HOST_KEY_FP } : {}),
            ...(e.MASTER_SSH_HOST_KEY_FP_FILE ? { hostKeyFpFile: e.MASTER_SSH_HOST_KEY_FP_FILE } : {}),
          },
        }
      : {}),
    // Both are guaranteed together by the schema refine above; the regex guarantees "owner/repo".
    ...(e.GITHUB_REPO && e.GITHUB_WRITE_PAT
      ? {
          github: {
            owner: e.GITHUB_REPO.split("/")[0] ?? "",
            repo: e.GITHUB_REPO.split("/")[1] ?? "",
            token: e.GITHUB_WRITE_PAT,
          },
        }
      : {}),
    ...(e.ONBOARD_GATE_CONTROLLER_ADDR
      ? {
          onboarding: {
            fence: {
              // A non-empty must-fail list is REQUIRED (an empty list can never prove the fence — see
              // fence.ts mustFailDenied); default it to the controller address the pod must not reach.
              mustFailTargets: ((): string[] => {
                const extra = e.ONBOARD_GATE_FENCE_MUST_FAIL.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
                return extra.length > 0 ? extra : [e.ONBOARD_GATE_CONTROLLER_ADDR];
              })(),
              controllerAddr: e.ONBOARD_GATE_CONTROLLER_ADDR,
              mustPassTarget: e.ONBOARD_GATE_MUST_PASS,
            },
            kubeVersion: e.ONBOARD_KUBE_VERSION,
          },
        }
      : {}),
    // catalog is a platform constant (CATALOG_REPO defaults), so the WRITE PAT is the
    // sole discriminator: present ⇒ tenant onboarding is configured; the repoURL is built the same
    // way the consumer platform URL is (https, never with embedded credentials).
    ...(e.CATALOG_WRITE_PAT
      ? { catalog: { repoURL: `https://github.com/${e.CATALOG_REPO}.git`, token: e.CATALOG_WRITE_PAT } }
      : {}),
    // Always present: the subdomain always has its "build" default; only the HMAC secret is optional
    // (absent ⇒ the onboard setup-webhook step fails loud, never a silent no-build).
    webhook: {
      subdomain: e.BUILD_EVENTLISTENER_SUBDOMAIN,
      ...(e.GITHUB_WEBHOOK_SECRET ? { secret: e.GITHUB_WEBHOOK_SECRET } : {}),
    },
    ...(e.CLOUDFLARE_DNS_API_TOKEN ? { dns: { cloudflareApiToken: e.CLOUDFLARE_DNS_API_TOKEN } } : {}),
    // The refine above guarantees the three together; the triple guard narrows them.
    ...(e.STORAGE_BOX_HOST && e.STORAGE_BOX_USER && e.STORAGE_BOX_PASSWORD
      ? { storageBox: { host: e.STORAGE_BOX_HOST, user: e.STORAGE_BOX_USER, password: e.STORAGE_BOX_PASSWORD } }
      : {}),
    ...(e.DBTOOLS_IMAGE ? { dbtoolsImage: e.DBTOOLS_IMAGE } : {}),
    ...(e.ANSIWISE_SERVE_COMMAND ? { ansiwiseServeCommand: e.ANSIWISE_SERVE_COMMAND } : {}),
  };
}

/** Boot entry: parse, or print field errors and exit 1 (before the logger exists). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const issue of err.issues) {
        // eslint-disable-next-line no-console -- config failure happens before the logger exists
        console.error(`config: ${issue}`);
      }
      process.exit(1);
    }
    throw err;
  }
}
