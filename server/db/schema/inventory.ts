import { sqliteTable, text, integer, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  SERVER_STATUS, SERVER_ROLE, SERVER_TAILNET_STATE, SERVER_PASSWORD_LOGIN_STATE, SERVER_AUTHORIZED_KEYS_STATE,
  STAGE, APP_STATUS, TENANT_STATUS, TENANT_ADMIN_STATE,
  APP_PROVENANCE, CLUSTER_STATUS, CLUSTER_TIER, PLANE_STATE,
} from "../../../shared/enums.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// The inventory tables: the servers the platform owns, the clusters on them, and what is deployed
// on those clusters (consumer apps, tenants and their per-app fan-out).
export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),                                     // "srv_" + ulid
  name: text("name").notNull(),
  // The TWO addresses a run can reach this machine on OVER SSH, and which one it takes is the
  // plan's to state (server/executor/transport.ts): a target that names no transport gets
  // `lan_host` when the row carries one and `host` otherwise, and a target that asks for the public
  // address gets `host` whatever else the row holds. Neither is a fallback for the other — nothing
  // retries the second address when the first refuses.
  host: text("host").notNull(),                                    // the address the machine answers on from outside
  lanHost: text("lan_host"),                                       // 10.1.1.x — the address it answers on inside the cluster network
  // A THIRD address, and NOT a third SSH transport: the address the MASTER's IN-CLUSTER components
  // dial this machine's kube-apiserver on once it is a slave — its per-slave ArgoCD instance, Vault
  // on every ESO login, the shared dashboard's kubeconfig, and the Controller's own per-slave kube
  // client, which writes. deploy-slave puts it in the cluster map's apiHost field and passes the
  // same value to the slave's --emit-mgmt-credentials, so the git side and the slave-composed side
  // carry one address instead of two that can disagree. Falls back to lan_host and then host, which
  // is what a slave sitting in the master's own network wants.
  //
  // Its own column and NOT lan_host, because lan_host answers a different question and two readers
  // depend on that answer: the pod-CIDR guard derives the cluster LAN as the /24 around it, and the
  // boot seed reconciles the master's row from MASTER_LAN_HOST on every start. It is also not
  // tailnet_json.address below — that is a READING taken off the host's own client, and this is
  // what the platform DECLARES, stated before the host has joined anything.
  tailnetHost: text("tailnet_host"),
  sshPort: integer("ssh_port").notNull().default(22),
  sshUser: text("ssh_user").notNull(),
  role: text("role", { enum: SERVER_ROLE }).notNull().default("slave"),
  status: text("status", { enum: SERVER_STATUS }).notNull().default("bare"),
  machineId: text("machine_id"),                                   // /etc/machine-id; NULL until the first deploy backfills it (executor/attest.ts)
  preflightJson: text("preflight_json", { mode: "json" }),
  // Tailnet membership, per SERVER — a second axis beside `status`, on this table rather than on
  // `clusters` because a machine joins the private network BEFORE it is deployed and a bare/ready
  // server has no cluster row to carry it. Every writer goes through recordTailnetReading
  // (domains/runs/tailnet-probe.ts): adopt's `baseline`, which reads a machine the platform has
  // never touched; deploy-slave's `install-microk8s`, which reads it again right after the host
  // joins — that second one is what a live slave's row actually carries, since the client only
  // exists after the base install; and the `read-membership` step every tailnet repair verb ends
  // with, which is what makes a disconnect or a rejoin visible on the card that offered it. State
  // and document go down in ONE statement, so a membership can never be stored without the moment
  // and the run that produced it. The default is "unknown" — the honest reading of a row nothing
  // has looked at, and the only literal no step writes.
  tailnetState: text("tailnet_state", { enum: SERVER_TAILNET_STATE }).notNull().default("unknown"),
  tailnetJson: text("tailnet_json", { mode: "json" }),              // ServerTailnetV0 (shared/tailnet.ts)
  // Whether this host's sshd takes a PASSWORD, per SERVER — a third axis beside `status` and the
  // tailnet pair above, and the same shape: the state the card keys on, plus the document saying
  // when the reading was taken and by which run. Every writer goes through
  // recordPasswordLoginReading (domains/runs/password-login-probe.ts), which reads `sshd -T` and
  // nothing else: a drop-in file can say `PasswordAuthentication no` while the daemon answers
  // `yes`, because sshd takes the FIRST occurrence of a keyword and reads its drop-in directory in
  // alphabetical order. Three moments write it — adopt's `disable-password-login`, which reads the
  // host before it shuts the door and again after, and the two password-login verbs, which do the
  // same on a host that is already adopted. The default is "unknown", the honest reading of a row
  // nothing has looked at, and the only literal no step writes.
  passwordLoginState: text("password_login_state", { enum: SERVER_PASSWORD_LOGIN_STATE }).notNull().default("unknown"),
  passwordLoginJson: text("password_login_json", { mode: "json" }),  // ServerPasswordLoginV0 (shared/password-login.ts)
  // WHO this host lets in, per SERVER — a fourth axis beside `status` and the two pairs above, and
  // the same shape: the state the card keys on, plus the document listing every key line the
  // reading found. Every writer goes through recordAuthorizedKeysReading
  // (domains/runs/operator-keys-probe.ts), which reads ~/.ssh/authorized_keys on the host and
  // classifies each line against two things this controller knows — the marker adopt wrote and the
  // fingerprint of the ssh_key credential sealed for this server. Four moments write it: adopt's
  // `baseline`, which reads a machine straight after the controller's own key landed on it, and the
  // three operator-key verbs. The default is "unknown", the honest reading of a row nothing has
  // looked at, and the only literal no step writes.
  authorizedKeysState: text("authorized_keys_state", { enum: SERVER_AUTHORIZED_KEYS_STATE }).notNull().default("unknown"),
  authorizedKeysJson: text("authorized_keys_json", { mode: "json" }),  // ServerAuthorizedKeysV0 (shared/operator-keys.ts)
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  adoptedAt: integer("adopted_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("servers_name_uq").on(t.name),
  uniqueIndex("servers_host_port_uq").on(t.host, t.sshPort),
  // At most ONE server carries the master part. Indexed on the PREDICATE, not on `role`: an index
  // on the column would be unique per distinct VALUE, so a "master" row and a "master+slave" row
  // would sit side by side and the platform would have two management planes. The expression is 1
  // for every indexed row, and the partial WHERE keeps the slaves (whose predicate is 0) out of the
  // index entirely — otherwise every slave would collide with every other slave on 0.
  uniqueIndex("servers_one_master_uq")
    .on(sql`(role IN ('master', 'master+slave'))`)
    .where(sql`role IN ('master', 'master+slave')`),
]);

export const clusters = sqliteTable("clusters", {
  id: text("id").primaryKey(),                                     // "cls_" + ulid
  serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "restrict" }),
  stage: text("stage", { enum: STAGE }).notNull(),
  domain: text("domain").notNull(),                                // == install branch == plane.branch
  status: text("status", { enum: CLUSTER_STATUS }).notNull().default("planned"),
  tier: text("tier", { enum: CLUSTER_TIER }).notNull().default("rehearsal"), // one-way audited promotion
  slaveId: integer("slave_id"),                                    // internal ordinal; NEVER in a resource name; NULL for the master
  planeState: text("plane_state", { enum: PLANE_STATE }).notNull().default("absent"),
  // ClusterPlaneV0 (shared/plane.ts). TWO steps of the deploy-slave Run write it: create-mgmt folds
  // in the harvested kube access, register writes the whole plane. planeState above has THREE
  // writers (create-mgmt, verify-slave, register). Stated because the comment here used to claim a
  // single writer, and a reader who believes that reasons about the column as if it settled once.
  planeJson: text("plane_json", { mode: "json" }),
  provisionedAt: integer("provisioned_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("clusters_server_uq").on(t.serverId),                // one VM = one cluster
  uniqueIndex("clusters_domain_uq").on(t.domain),
  uniqueIndex("clusters_slave_id_uq").on(t.slaveId).where(sql`slave_id IS NOT NULL`), // ordinal never reused
]);

// A consumer app deployed on a cluster. `clusterId` records WHICH cluster the consumer runs on
// (a slave or the master) — the pointer/report/apps row all agree. Written by the onboard Run's
// `record-inventory` step (the first writer of this table); read by resume/upgrade/offboard.
export const apps = sqliteTable("apps", {
  id: text("id").primaryKey(),                                     // "app_" + ulid
  clusterId: text("cluster_id").notNull().references(() => clusters.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  // NO revision column. The Controller records no pin of its own: the registration states no revision,
  // and what a unit runs is read off its Application's spec (server/domains/onboarding/live-recon.ts
  // driftOf). A column here would have no writer with anything true to write, and calling one the pin is
  // what made the Consumers card cry "Drift" at two converged consumers.
  // Which stage this consumer runs at on `clusterId` — copied from the cluster's own row so a reader
  // of the inventory needs no join, and part of the upsert key. A cluster carries exactly ONE stage
  // and a registration for stage X may only name a cluster marked X (domains/onboarding/registry.ts
  // assertClusterStage), so a unit deployed at two stages stands on two clusters and (clusterId, name)
  // already separates its rows; carrying the stage in the key states that identity outright instead of
  // leaving it implied by the cluster row.
  //
  // NOT NULL, because the one INSERT of this table cannot produce a null and a null would break it:
  // every row is written by upsertAppRow (domains/onboarding/onboard-steps.ts), whose AppRowValues
  // carries the stage, and the remaining writers only flip status or clusterId. SQLite treats NULLs as
  // DISTINCT in a unique index, so a null-stage row would sit outside apps_cluster_name_stage_uq
  // entirely, while upsertAppRow looks the existing row up with `stage = ?` — which never matches a
  // NULL. That one writer would then insert a second row beside the first on every run.
  stage: text("stage", { enum: STAGE }).notNull(),
  repoUrl: text("repo_url"),                                       // the consumer repo URL
  chartPath: text("chart_path"),                                   // path to the Helm chart inside the repo
  // the credential-store id of a private repo's read credential; NULL = public. A loose ref
  // (not a Drizzle FK) to avoid an inventory<->credentials import cycle — same convention as audit.run_id.
  repoCredentialId: text("repo_credential_id"),
  provenance: text("provenance", { enum: APP_PROVENANCE }).notNull().default("controller"),
  // The last onboarding lifecycle run for this app (its step checkpoint holds the SmokeVerdict).
  // Loose ref to runs(id), same convention as above.
  lastRunId: text("last_run_id"),
  status: text("status", { enum: APP_STATUS }).notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
}, (t) => [uniqueIndex("apps_cluster_name_stage_uq").on(t.clusterId, t.name, t.stage)]);

// A tenant (multi-app package) deployed on a cluster. Unlike a consumer `apps` row, a tenant fans
// out to one ArgoCD Application per MEMBER (auth/jobs/report plus one per app), each in its own
// namespace <guid>-<member>, so it carries the guid identity instead of a single repoUrl/chartPath. The row
// is mutable (suspend/resume field-flips, add-app), unlike the append-once `apps` row — hence updatedAt.
// Written by the create-tenant Run's `record-provisional` step (the FIRST writer — it records INTENT
// before any git/kube mutation, status "provisioning", so a run that dies mid-way still leaves a row
// every removal verb can name) and settled to "active" by its `record-inventory` step; read by
// add-app/suspend/resume/offboard. `lastRunId` is a loose ref to runs(id) (text, not a Drizzle FK) to
// avoid an inventory<->runs import cycle — same convention as apps.lastRunId.
export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),                                     // "tnt_" + ulid
  clusterId: text("cluster_id").notNull().references(() => clusters.id, { onDelete: "restrict" }),
  guid: text("guid").notNull(),                                   // 12-char Crockford base32 — the sole tenant identity
  subdomain: text("subdomain").notNull(),
  stage: text("stage", { enum: STAGE }).notNull(),
  // WHICH member is this tenant's identity provider — the one member name the row-keyed paths need:
  // the activation reads a Secret in its namespace, and a relocation reads the crypto material there
  // and resolves the tenant's public auth host from it. Recorded per tenant because it is a fact about
  // THIS tenant, resolved from the product's manifest when it was created. A constant `auth` stood in
  // the code instead, which is the platform knowing what one product calls its IdP.
  identityProvider: text("identity_provider").notNull(),
  // The tenant's STANDING member names, as they stood in the product's manifest when it was created.
  // Beside the IdP and for the same reason. Here rather than only in the registration because the
  // paths that need the whole SET do not hold one: the tenant view, the watch-set projection and the
  // replace union all work from rows, and a git read per call to learn a namespace name is a read
  // nobody should pay for. The registration carries it too — that copy is the one the CHARTS read.
  members: text("members", { mode: "json" }).$type<string[]>().notNull(),
  // Whether the tenant's IdP boot-seeds initial accounts. Also a registration field (the registration
  // is what the charts read); recorded here as the platform's own trace of what was asked for.
  seedUsers: integer("seed_users", { mode: "boolean" }).notNull().default(false),
  suspended: integer("suspended", { mode: "boolean" }).notNull().default(false), // tenant-wide pause
  owner: text("owner"),
  provenance: text("provenance", { enum: APP_PROVENANCE }).notNull().default("controller"),
  lastRunId: text("last_run_id"),                                 // loose ref to runs(id)
  // TENANT_STATUS, never the consumer APP_STATUS: a tenant additionally has "provisioning" (recorded
  // intent, run unfinished) and "purged" (deprovisioned by tenant-purge, as opposed to the un-deployed
  // "offboarded" that KEEPS the cluster state). The column DDL is unchanged by either widening — SQLite
  // stores it as plain text with no CHECK constraint, so the enum is a TypeScript-side narrowing
  // only and needs no migration.
  status: text("status", { enum: TENANT_STATUS }).notNull().default("active"),
  // What the last administrator check found, and when. Written by the check-tenants Run and by
  // nothing else. All three are null until the first check lands, which is how "not yet known" stays
  // distinguishable from "known to be fine" — a tenant that has never been checked must not read as
  // healthy on any screen.
  adminState: text("admin_state", { enum: TENANT_ADMIN_STATE }),
  // The count the tenant reported. Null where the check could not reach it, because a count of zero
  // and no answer at all say opposite things and one column must not conflate them.
  adminCount: integer("admin_count"),
  adminCheckedAt: integer("admin_checked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
}, (t) => [uniqueIndex("tenants_cluster_guid_uq").on(t.clusterId, t.guid)]);

// A single app inside a tenant's guid × apps[] matrix (Application <guid>-<name>-<stage>). One row
// per entry in the tenant pointer's apps[]. Written by the create-tenant Run's `record-provisional`
// step (status "provisioning") and settled by its `record-inventory` step, plus the add-app Run's
// `record-inventory` step (the sole writers); `lastRunId` is a loose ref to runs(id), same convention
// as tenants.lastRunId. Its status follows the TENANT's list, not the consumer one — a half-created
// tenant's app rows are "provisioning" too, and every fan-out watch set must still count them.
export const tenantApps = sqliteTable("tenant_apps", {
  id: text("id").primaryKey(),                                     // "tna_" + ulid
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  status: text("status", { enum: TENANT_STATUS }).notNull().default("active"),
  lastRunId: text("last_run_id"),                                 // loose ref to runs(id)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
}, (t) => [uniqueIndex("tenant_apps_tenant_name_uq").on(t.tenantId, t.name)]);

// The size table — the ONE place an installation says what `small`, `medium` and `large` mean. A row
// per size, seeded from shared/unit-size.ts UNIT_SIZE_SEED when the database is created and EDITABLE
// afterwards, because a size is what a unit is sold and that changes without a release.
//
// It is data and not a values file for a reason branch-classes.yaml states: a books path — what one
// installation knows about itself — is never tracked on the trunk, so a table that both ships with the
// product and gets overwritten in service could not be one file. The Controller holds it, resolves it
// into each unit's registration when it writes one, and ArgoCD delivers the resolved figures. Nothing
// on a cluster reads this table; a cluster reads registrations.
//
// The key is (component, name): nine rows, three per component. A unit's quota is base + postgresql +
// mongodb x members, so what a size means depends on WHICH part is being asked for — and the operator
// adjusts each part once instead of every combination of them.
export const unitSizes = sqliteTable("unit_sizes", {
  component: text("component").notNull(),                          // SIZE_COMPONENT: base | postgresql | mongodb
  name: text("name").notNull(),                                    // UNIT_SIZE: small | medium | large
  // The six figures of one namespace's ResourceQuota, field for field as
  // hostyour-cloud/apps/unit-quota renders them. The four quantities stay TEXT: "500m" and "1Gi" are
  // Kubernetes quantities, and storing them as numbers would force a unit and lose the notation an
  // operator typed.
  requestsCpu: text("requests_cpu").notNull(),
  requestsMemory: text("requests_memory").notNull(),
  limitsCpu: text("limits_cpu").notNull(),
  limitsMemory: text("limits_memory").notNull(),
  pods: integer("pods").notNull(),
  persistentVolumeClaims: integer("persistent_volume_claims").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
}, (t) => [primaryKey({ columns: [t.component, t.name] })]);
