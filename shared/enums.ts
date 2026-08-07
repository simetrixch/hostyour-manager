// The single home of every enum literal. Nothing else in docs/ or
// code restates these lists — CI greps for duplicate enum blocks. Server, web, and the
// Drizzle schema all import from here.

export const SERVER_STATUS = ["bare", "adopting", "ready", "provisioning",
  "healthy", "degraded", "draining", "undeployed"] as const;
export type ServerStatus = (typeof SERVER_STATUS)[number];

/** Does this controller hold its OWN SSH key for a server in this status — i.e. can it reach the
 *  host without a password?
 *
 *  Only two statuses say no. "bare" is a machine adopt has never touched, and "adopting" is one
 *  whose key is being installed right now. Every other status follows a completed adoption, or —
 *  for the master, which is never adopted at all — its boot-time self-registration, which seals the
 *  self-SSH key and lands the row at "healthy" (server/boot/seed-master.ts).
 *
 *  Named once because two readers must key on the same set, and a disagreement between them shows
 *  as a button that plans a run the server then refuses: the password-login plan, which will not
 *  shut a host's password door unless something else can still reach it, and the card that offers
 *  that verb. `adoptedAt` is NOT that set — the master's row carries none and it is the one host
 *  most in need of the verb. */
export function hasControllerKey(status: ServerStatus): boolean {
  return status !== "bare" && status !== "adopting";
}

// What a server's cluster does for the platform, and nothing else: who operates ArgoCD, Vault,
// identity and the build plane for whom. "master+slave" is one server doing BOTH jobs — a regular
// role, not a special case — so the list is a union of two independent parts, not three unrelated
// literals. A role is never a placement rule and never something an app can see.
export const SERVER_ROLE = ["master", "slave", "master+slave"] as const; // default "slave"
export type ServerRole = (typeof SERVER_ROLE)[number];

/** The members of SERVER_ROLE that carry the MASTER part. Named once, here, because every reader
 *  that asks "does this server operate the management plane?" must key on the same set: a
 *  hand-spelled `role === "master"` answers NO for a master+slave, and every one of those readers
 *  then does the opposite of what it means — the master row lookup (server/boot/seed-master.ts,
 *  domains/inventory/read.ts) finds nothing, the host-key pin stops being required
 *  (server/executor/context.ts, which refuses to SSH the master unpinned), and redeploy plans its
 *  two-host shape — a second target plus a lock on the master's own branch — for a cluster that is in
 *  fact this controller's own.
 *
 *  READONLY, so Drizzle call sites spread it (`inArray(servers.role, [...MASTER_ROLES])`, which
 *  takes a mutable array) — the copy is the price of a shared constant nothing can mutate. */
export const MASTER_ROLES = ["master", "master+slave"] as const satisfies readonly ServerRole[];

/** Does this role carry the MASTER part? The in-memory twin of MASTER_ROLES for rows already read
 *  and for the browser, which has no query to put the set into. */
export function isMasterRole(role: ServerRole): boolean {
  return (MASTER_ROLES as readonly ServerRole[]).includes(role);
}

export const STAGE = ["dev", "test", "prod"] as const;
export type Stage = (typeof STAGE)[number];

// A consumer row's lifecycle. "provisioning" is the state the row is BORN in: the onboard run records
// it before it mutates anything, so a failure between write-registration and the live app leaves a row
// that names the leftovers — a registration, an AppProject, a namespace, Vault entries, a DNS record and
// a webhook. Without it those existed with no row at all, findable only by an explicit detected-scan.
// The tenant path has carried the same state since its own record-provisional; this is the consumer twin.
export const APP_STATUS = ["provisioning", "active", "suspended", "offboarded"] as const;
export type AppStatus = (typeof APP_STATUS)[number];

/** The TERMINAL member(s) of APP_STATUS — the consumer twin of TENANT_SETTLED_STATUS below, named for
 *  the same reason: every reader that asks "does this row still stand for a consumer that is out
 *  there?" (the detected-consumer scan's inventory diff, the adopt run's already-tracked refusal) must
 *  key on ONE named set, never a hand-spelled `!== "offboarded"` that falls silently on the permissive
 *  side the day a second terminal state exists. A settled row records a removal that already ran
 *  (the row is kept); it does not account for a live pointer standing beside it.
 *  READONLY like its tenant twin — Drizzle call sites spread it (`notInArray(col, [...APP_SETTLED_STATUS])`). */
export const APP_SETTLED_STATUS = ["offboarded"] as const satisfies readonly AppStatus[];

/** The states a row is in while its consumer STANDS somewhere — provisioning included, and that is the
 *  point. A provisioning row is not serving yet, but something of it is already out there: the
 *  registration is committed, the namespace may exist, the Vault entries are seeded. Every reader that
 *  asks "may I create this consumer / adopt it / call it undetected?" must count it as present, or the
 *  half-built unit is invisible in exactly the window where it needs finding. */
export const APP_PRESENT_STATUS = ["provisioning", "active", "suspended"] as const satisfies readonly AppStatus[];

// The lifecycle of a TENANT row (tenants.status) and of one row of its apps[] matrix
// (tenant_apps.status). Deliberately its OWN list rather than a widened APP_STATUS: a tenant carries TWO
// states no consumer app can ever be in, and widening APP_STATUS would leak both into the consumer apps
// domain, where nothing could ever produce them and every consumer reader would still have to handle them.
//   - "provisioning" — written by create-tenant's record-provisional step BEFORE the run mutates git or
//     the cluster: "the Controller has started creating this tenant and the run has
//     not finished".
//   - "purged" — written by the tenant-purge teardown's record step: the tenant was
//     DEPROVISIONED, not merely un-deployed. It exists because "offboarded" and "purged" state OPPOSITE
//     things about what is still out there, and settling both to the one literal made a completed purge
//     INVISIBLE — the tenant stayed on the Tenants page's "Offboarded tenants" panel and went on offering
//     the very purge it had just finished. offboarded = un-deployed with the cluster state deliberately
//     KEPT (the member namespaces, the Tenant CR, the Vault path, the object-storage credential and the
//     Mongo databases all stand — which is precisely why purge exists and why that panel offers it);
//     purged = the Tenant CR is gone and the tenant operator's deprovision cascade has run, so there is
//     nothing left to reap.
// The other three literals match APP_STATUS by intention, not by sharing: active = live, suspended =
// paused (base survives), offboarded = settled soft state (the row is kept, never deleted).
//
// NEITHER addition needed a schema change: tenants.status and tenant_apps.status are plain SQLite text
// with no CHECK constraint, so this list is a TypeScript-side narrowing only —
// the same reason "provisioning" needed none. The column states it too (server/db/schema/inventory.ts).
export const TENANT_STATUS = ["provisioning", "active", "suspended", "offboarded", "purged"] as const;
export type TenantStatus = (typeof TENANT_STATUS)[number];

/** The TERMINAL members of TENANT_STATUS — the two ways a tenant's lifecycle ENDS. Both keep the row
 * and both mean nothing of the tenant is deployed; they differ only in what survived on the
 *  cluster, which is the distinction the states themselves carry.
 *
 *  Named ONCE here, beside the list it is a subset of, because unrelated readers all over the onboarding
 *  domain ask the same question — "does this row still stand for a tenant that is out there?" — of
 *  tenants.status (the orphan scan, the teardown-target resolver, the create-tenant replace-target
 *  lookup) and of tenant_apps.status (the fan-out watch set, the live reconciliation read, the two
 *  teardown record steps). Every one of them used to spell it `!== "offboarded"`, and every one of them
 *  would have fallen silently on the permissive side the moment "purged" existed: a fully deprovisioned
 *  tenant would have been read as a tenant that still stands. A named set makes a future terminal state
 *  one edit here instead of a hunt through those modules.
 *
 *  It is NOT the inverse of the server's TENANT_LIVE_STATUS (tenant-live-guard.ts): "provisioning" is
 *  neither live nor settled, so the two sets are stated separately and answer different questions.
 *
 *  ORDERED — weakest claim FIRST. That is a declaration, not an accident of how it was typed:
 *  atLeastAsSettledAs below reads the order, so the two must be read together. "purged" states
 *  everything "offboarded" states (nothing of the tenant is deployed) AND that its cluster state went
 *  with it, so the two terminal states are totally ordered by HOW MUCH of the tenant is gone. A third
 *  terminal state must be INSERTED at its place in that order, never appended out of habit.
 *
 *  READONLY, so its Drizzle call sites spread it — `notInArray(col, [...TENANT_SETTLED_STATUS])`, since
 *  that operator takes a mutable array. The copy is the price of a shared constant nothing can mutate. */
export const TENANT_SETTLED_STATUS = ["offboarded", "purged"] as const satisfies readonly TenantStatus[];

/** ONE of the two terminal states — the type of every "which state does this removal settle to?" knob
 *  (tenant-teardown.ts TenantTeardownOpts.settledStatus) and the parameter atLeastAsSettledAs takes.
 *  Narrower than TenantStatus on purpose: a settle step that could be handed "active" would have no
 *  answer to the question below, since only the terminal states are ordered against each other. */
export type TenantSettledStatus = (typeof TENANT_SETTLED_STATUS)[number];

/** WHICH rows a settle to `next` must LEAVE ALONE: `next` itself plus every terminal status AFTER it in
 *  the order above — i.e. every row that already records a removal at least as complete as the one about
 *  to be written. Spread into the Drizzle filter of every step that settles a tenants or a tenant_apps
 *  row (`notInArray(col, atLeastAsSettledAs(status))`), so the decision is made in exactly one place.
 *
 *  It answers two opposite-looking questions with one rule, and both were live defects
 *:
 *   - a settle may never DOWNGRADE a terminal row. Three flavours settle "offboarded" — create-tenant's
 *     ABORT_TEARDOWN, the REPLACE_TEARDOWN and tenant-offboard's own record-offboard — and every one
 *     of them can be aimed at a row a tenant-purge already settled "purged": the failed create-tenant
 *     still offers "Abort (cleanup)" after the operator purged the tenant it left behind, and
 *     POST /api/tenants/:id/offboard takes any row id. Their steps then no-op, because there is nothing
 *     left to remove — while the record step re-stamps the row "offboarded" with a run id that removed
 *     nothing. That puts a deprovisioned tenant back on the Tenants page's "Offboarded tenants" panel,
 *     advertising the purge that already ran, with a detail page telling the operator its namespace,
 *     Tenant CR, Vault path, object-storage credential and Mongo databases all still stand.
 *   - a settle MUST still be able to DEEPEN one. The product prescribes offboard FIRST, then purge (the
 *     Tenants panel, the offboard dialog and the purge's own live-tenant refusal all say so). The
 *     offboard settles every tenant_apps row "offboarded"; the purge that follows genuinely deletes the
 *     Tenant CR and the namespace those apps WERE, so its record step has to write "purged" over them.
 *     A flat "skip anything already settled" left the tenant "purged" with every app row still badged
 *     "offboarded" — badged with the word this very list defines as "un-deployed, cluster state KEPT",
 *     directly above a bar saying the namespace, the Vault path and the Mongo databases are gone.
 *  What keeps the remove-app case intact is the same rule, not an exception to it: an app row a per-app
 *  remove-app settled "offboarded" is EQUALLY settled, not less, so a later tenant-wide offboard leaves
 *  it (and its own run id) alone. Only a strictly DEEPER removal may overwrite.
 *
 *  Returns TenantStatus[] — mutable for Drizzle's notInArray, and widened to the full status type so a
 *  caller can also ask it about the status a ROW carries (`keep.includes(row.status)`), which is any
 *  member of TENANT_STATUS and not just a terminal one. */
export function atLeastAsSettledAs(next: TenantSettledStatus): TenantStatus[] {
  return TENANT_SETTLED_STATUS.slice(TENANT_SETTLED_STATUS.indexOf(next));
}

// ArgoCD's TWO per-Application status enums — the sync state and the health state an Application CR
// reports (argoproj.io/v1alpha1 `.status.sync.status` / `.status.health.status`). They live HERE with
// every other enum because this file's own rule is that nothing restates these lists, and these two
// were the one pair that did: the kube port declared them, kube-map.ts restated their members as the
// two `allowed` arrays it validates raw CR text against, and the browser restated them a THIRD time
// inside its hand-mirrored live-reconciliation shapes. Now server, mapper and web all read them here.
//
// "Unknown" is OURS, not ArgoCD's: a CRD status field is server-provided text, so the mapper keeps a
// value only when it is a member of the list and falls back to "Unknown" otherwise (kube-map.ts pick).
// It is therefore a member of BOTH lists — a status we can always answer with, never a fabricated one.
export const ARGO_SYNC = ["Synced", "OutOfSync", "Unknown"] as const;
export type ArgoSync = (typeof ARGO_SYNC)[number];

export const ARGO_HEALTH = ["Healthy", "Progressing", "Degraded", "Missing", "Unknown"] as const;
export type ArgoHealth = (typeof ARGO_HEALTH)[number];

// The answers the live reconciliation read may give to its ONE deployment question — does what the
// cluster RUNS match what the unit's GitOps pointer PINS? Computed server-side once for both unit kinds
// (server/domains/onboarding/api.ts driftOf -> LiveDriftView.verdict) and named for the operator once in
// the browser (web/src/reconVocabulary.ts), so the Consumers card and the Tenants card can never answer
// the same situation differently.
//
// A named list rather than the `boolean | null` this started as, because a boolean carries THREE answers
// and the question has FOUR — and the fourth spent a while folded onto "converged", which is the one
// direction a facts panel must never be wrong in:
//   "converged"    — a comparison HAPPENED and the two revisions agree. The green claim, and it may be
//                    made ONLY here.
//   "drift"        — a comparison happened and they disagree. Includes pinned-but-not-deployed (a pin
//                    resolves, nothing runs).
//   "not-deployed" — NOTHING was compared: nothing is pinned and nothing runs. That is the deliberate
//                    outcome of a consumer suspend/offboard and of a tenant offboard/purge — and it is
//                    equally the shape a HALF-FINISHED lifecycle run leaves behind, which is why it is
//                    its own answer instead of "converged": no comparison happened, so no verdict about
//                    one may be claimed. NEUTRAL, never green.
//   "unknown"      — ArgoCD could not be read AT ALL, so not even the facts are in. Also neutral:
//                    painting "we could not read it" as "it is wrong" would make a facts panel lie.
export const DRIFT_VERDICT = ["converged", "drift", "not-deployed", "unknown"] as const;
export type DriftVerdict = (typeof DRIFT_VERDICT)[number];

// How an inventory row came to exist. ONE list for BOTH unit kinds — apps.provenance and
// tenants.provenance are the same question asked of a consumer and of a tenant, and the answer has to
// read the same either way, because the query it exists for ("which units did this Controller onboard,
// and which did it only write down") spans both tables:
//   - "controller" — a Run of this Controller onboarded the unit and gate-validated what it deployed.
//                    Written by the consumer onboard's record-inventory step (domains/onboarding/
//                    onboard-steps.ts) and by create-tenant's upsertTenantInventory (create-tenant.
//                    run.ts), and it is the DEFAULT of both columns.
//   - "adopted"    — RECONSTRUCTED FROM THE GITOPS REGISTRATION by an adopt-consumer run: the consumer
//                    was live in GitOps with no apps row (its onboard died before record-inventory, or
//                    the registration was written by hand), so the row is the registration's word
//                    attested against the live cluster, never gate-validated by that run. Consumer-only
//                    — there is no adopt verb for a tenant.
//
// Two literals, not three. "imported" was the consumer onboard's word for exactly what the tenant
// writer called "controller", so one act carried two names and a reader of either concluded they meant
// different things: a query for one word answered about one unit kind and silently left out the other.
// Its declared second meaning — a consumer taken over from a cluster this platform did not build — was
// reserved for a connect-cluster verb that is in no RUN_KIND, so nothing else wrote it either.
//
// The column is plain SQLite text with no CHECK constraint (like tenants.status), so this list is a
// TypeScript-side narrowing only: the DDL, the migration baseline and its snapshot are unchanged. No
// stored row has to be rewritten either — the schema is unreleased, so every database that exists is
// built fresh from that baseline and its rows come from the writers named above.
export const APP_PROVENANCE = ["controller", "adopted"] as const;
export type AppProvenance = (typeof APP_PROVENANCE)[number];

export const CLUSTER_STATUS = ["planned", "provisioning", "active",
  "rebuilding", "removing", "removed"] as const;

export const CLUSTER_TIER = ["rehearsal", "real"] as const; // default "rehearsal"
export type ClusterTier = (typeof CLUSTER_TIER)[number];

// Lifecycle of a slave's master-side management plane (the per-slave namespaced
// ArgoCD + Vault surface — see shared/plane.ts). Formerly TRIO_STATE; "trio" is
// dropped terminology and the column is clusters.plane_state.
//
// Four literals, not five: "removing" was declared here and no step ever wrote it — there is no
// plane-removal path in the product at all — so every reader that handled it handled a state the
// platform could not reach. The column is plain SQLite text with no CHECK constraint, so dropping
// a literal is a TypeScript-side narrowing only; nothing stored has to change.
export const PLANE_STATE = ["absent", "creating", "verifying", "ready"] as const;

// Whether a SERVER is a member of the tailnet — the private network between the master and its
// slaves, named the way headscale and its client name it. Its own axis, never folded into
// SERVER_STATUS: a machine joins the tailnet BEFORE it is deployed, so a server at "bare" or
// "ready" (which has no cluster row at all) still has a tailnet membership to state.
//   - "unknown"           — no run has looked at this host yet. The column default, and the only
//                           literal a step does not write: it says "nothing was measured", which
//                           is what a fresh row honestly carries.
//   - "no-client"         — a run looked and found no tailnet client on the host.
//   - "client-unreadable" — the client is there but would not say what it is doing. Its own
//                           literal, not folded into "not-joined": the daemon runs from the
//                           moment the client is installed, so a client that does not answer
//                           proves nothing about membership, and reporting that silence as
//                           "this host is on no network" is an assertion the run never measured.
//   - "not-joined"        — the client answered and reports a backend state other than Running.
//   - "joined"            — the client answered and reports Running.
// Every reading is a SNAPSHOT taken by the run that took it (servers.tailnet_json carries when,
// and by which run), never a live probe — the surface that renders it must say so.
export const SERVER_TAILNET_STATE = ["unknown", "no-client", "client-unreadable", "not-joined", "joined"] as const;
export type ServerTailnetState = (typeof SERVER_TAILNET_STATE)[number];

// Whether a SERVER's sshd accepts a PASSWORD, as the last run to look at it found. A third axis
// beside `status` and the tailnet state, and a MEASUREMENT rather than a setting: every literal
// below comes from `sshd -T`, which prints what the daemon resolved after every Include and every
// ordering rule. Reading a FILE instead cannot produce these values at all — sshd takes the FIRST
// occurrence of a keyword and reads /etc/ssh/sshd_config.d in alphabetical order, so a drop-in
// named to sort late states one thing while the daemon does the other.
//   - "unknown"    — no run has looked at this host yet. The column default, and the only literal
//                    no step writes.
//   - "unreadable" — a run looked and the daemon would not print its effective configuration.
//                    There is no second absence to tell apart the way the tailnet states do: every
//                    host here is reached over its own sshd, so the daemon is always present and
//                    only the reading can fail.
//   - "on"         — the daemon accepts a password. Either keyword is enough: PAM serves passwords
//                    through keyboard-interactive as well, so a host with
//                    `passwordauthentication no` and `kbdinteractiveauthentication yes` still has
//                    the door open.
//   - "off"        — both keywords resolved to no.
export const SERVER_PASSWORD_LOGIN_STATE = ["unknown", "unreadable", "on", "off"] as const;
export type ServerPasswordLoginState = (typeof SERVER_PASSWORD_LOGIN_STATE)[number];

// WHO a key line in a host's ~/.ssh/authorized_keys belongs to, as the reading found it. Three
// answers, because the file mixes three origins and a surface that folded any two of them together
// would hide the one that matters.
//   - "controller" — this controller's OWN login identity for the host: the line whose fingerprint
//                    matches the ssh_key credential sealed for this server, or whose comment is the
//                    marker adopt wrote. Both are checked, because the master's key is not written
//                    by adopt at all (it arrives as a file the boot seed seals) and carries whatever
//                    comment its generator gave it.
//   - "operator"   — a human's key this controller placed: the line carries the operator marker AND
//                    its fingerprint is the one stored under the label that marker names. Both,
//                    because the comment is text on the machine and anyone who can append to the
//                    file can type it. The label is what the removal keys on.
//   - "foreign"    — a line nothing here wrote: a cloud image's provisioning key, a colleague's key
//                    added by hand, a key left behind by someone who is gone, a stranger's key under
//                    a marker naming a label no row carries. Its own answer and never folded into
//                    "operator", because this is the whole thing the reading exists to make visible.
export const AUTHORIZED_KEY_KIND = ["controller", "operator", "foreign"] as const;
export type AuthorizedKeyKind = (typeof AUTHORIZED_KEY_KIND)[number];

// What a SERVER's ~/.ssh/authorized_keys held, as the last run to read it found. A FOURTH axis
// beside `status`, the tailnet state and the password-login state, and the same shape as those two:
// the state a card keys on, plus a document naming every key line.
//   - "unknown"     — no run has read this host's file. The column default, and the only literal no
//                     step writes.
//   - "unreadable"  — a run looked and the file could not be read.
//   - "accounted"   — every line in the file is one this platform can name: the controller's own
//                     key, or an operator key placed under a label. A host in this state has nobody
//                     on it that the Controller cannot also take off.
//   - "unaccounted" — at least one line is FOREIGN, or at least one did not read as a key here. The
//                     point of the axis: a departed operator's hand-placed key, or an image's
//                     provisioning key, is a working way in that no verb here can remove, and it
//                     must not sit unseen — and a line this build cannot read may be a certificate
//                     sshd authenticates with, which is the same thing with a different cause.
export const SERVER_AUTHORIZED_KEYS_STATE = ["unknown", "unreadable", "accounted", "unaccounted"] as const;
export type ServerAuthorizedKeysState = (typeof SERVER_AUTHORIZED_KEYS_STATE)[number];

// What a sealed credential IS, for the store's list filters and the card that shows it. Every member
// has a producer: `ssh_key` (adopt, seed-master), `pat` (the consumer repo PAT), `kubeconfig` (a
// slave's cluster bearer) and `other` (the adopt bootstrap password, a slave's Vault reviewer JWT).
// A member with nothing sealing it is a filter that can only ever answer empty, and a kind the card
// offers for a credential this platform cannot hold.
export const CREDENTIAL_KIND = ["ssh_key", "pat", "kubeconfig", "other"] as const;
export type CredentialKind = (typeof CREDENTIAL_KIND)[number];

// Every verb the Controller can run. A literal with no definition behind it is a verb the UI offers,
// the API accepts and nothing can execute — the plan route answers "unknown run kind" only after the
// operator has already asked for it. A verb therefore enters this list WITH its implementation and
// leaves it WITH its implementation, never before either. Two checks keep that true: the source census
// (server/domains/runs/registry-census.test.ts) proves every literal is implemented SOMEWHERE, and the
// registry.total boot check (server/boot/selfchecks.ts) proves the running process offers no verb it
// cannot serve, via the RUN_FAMILY grouping below.
export const RUN_KIND = [
  "noop",                                                       // permanent resume-proof fixture
  // The cluster verbs. `adopt` takes a bare machine into service, `deploy-slave` turns an adopted
  // server into a live slave, `redeploy` rebuilds the machine layer of a cluster that is already
  // live, and `release` raises the platform version the cluster stands on. Distinct on purpose:
  // each answers a different question, and a boolean on another verb hides that.
  "adopt", "deploy-slave", "redeploy", "release",
  // The tailnet repair verbs, on a host that is already deployed. Three acts, not one with a
  // switch: `tailnet-disconnect` takes the host off the private network and leaves it there,
  // `tailnet-reconnect` puts it back with the credential the host still holds, and
  // `tailnet-rejoin` is for when it holds none — the master mints a fresh one, which only the
  // coordinator can do. Each reaches its host on the PUBLIC address, because a verb cannot
  // travel over the network it is repairing.
  "tailnet-disconnect", "tailnet-reconnect", "tailnet-rejoin",
  // The password-login verbs, on a host this controller already holds a key for. `password-login-
  // disable` shuts the sshd password door and destroys the bootstrap password sealed beside the
  // server row — two doors, and only the second one outlives the machine's configuration.
  // `password-login-enable` opens the sshd door again for a repair, which is the only reason it
  // exists: adoption already leaves the door shut.
  "password-login-disable", "password-login-enable",
  // The operator-key verbs, on a host this controller already holds a key for. The two acts are
  // named for what they place — one human's key, under its own label and its own marker, so a
  // removal can never reach the controller's own line. The read is named for the FILE, because it
  // reports every key in it and not only the ones this platform put there: a key nobody here placed
  // is exactly what it exists to surface.
  "operator-key-place", "operator-key-remove", "authorized-keys-read",
  "onboard", "suspend", "resume", "offboard", "purge",          // ONB; purge = force-offboard by name (orphan removal)
  // The last step of putting a NEW secret value in front of a unit, and only that: a unit reads its
  // secrets as env vars, which are materialized once at container start, so a changed Vault value
  // reaches a RUNNING pod only when something rolls it. Named for what it does rather than for what
  // it completes, because it moves no secret of its own — writing Vault and deleting the target
  // Secret are the operator's two steps before it.
  // consumer + tenant, because the gap is the same on both sides and a tenant owns one namespace
  // PER MEMBER — so the tenant verb walks them, it is not the consumer verb with another id.
  "restart-workloads", "tenant-restart-workloads",
  // The ONLY way a size-table change reaches something already deployed: it writes the table's
  // CURRENT figures into the unit's registration. Asking for the size a unit already has is therefore
  // not a no-op but the re-apply — which is why the verb is named for the act (set a size) and not for
  // a change (resize), and why editing the table alone moves nothing.
  "set-size", "tenant-set-size",
  "adopt-consumer",                                             // ONB — reconstruct the apps row from the GitOps pointer; NOT "adopt" (taken by the server-adopt above)
  // The relocation verbs — ONE mechanism over the Hetzner Storage Box, three slices of it:
  // backup = close access, dump every store, verify, reopen (the box folder stays); restore = provide
  // the target and rebuild the unit from a folder; migrate = both halves plus the repoint and the
  // one-record DNS switch. Never three code paths — the defs compose shared step builders.
  "backup", "restore", "migrate",                               // ONB — consumer relocation
  "create-tenant", "add-app", "remove-app",                     // TNT — tenant (multi-app) onboarding
  "tenant-suspend", "tenant-resume", "tenant-offboard",         // TNT lifecycle
  "tenant-purge",                                               // TNT — force-offboard by guid (orphan removal)
  "tenant-backup", "tenant-restore", "tenant-migrate",          // TNT relocation — the same mechanism over the whole member bracket
] as const;
export type RunKind = (typeof RUN_KIND)[number];

/**
 * The run families — the units a registry is assembled in, and the units the UI filters runs by.
 * `fixture` and `cluster` are registered unconditionally by buildRegistry (server/domains/runs/
 * registry.ts). `consumer` and `tenant` are the two opt-in families of buildOnboarding (server/boot/
 * wire-onboarding.ts): each is built only when its own adapters are configured, and a family that is
 * not built has no defs at all — its routes then answer 501 NOT_CONFIGURED.
 *
 * Every RUN_KIND literal belongs to exactly one family, and a family is registered whole or not at
 * all. The registry.total boot check asserts both against the registry the process assembled.
 */
export const RUN_FAMILY = {
  fixture: ["noop"],
  cluster: [
    "adopt", "deploy-slave", "redeploy", "release",
    "tailnet-disconnect", "tailnet-reconnect", "tailnet-rejoin",
    "password-login-disable", "password-login-enable",
    "operator-key-place", "operator-key-remove", "authorized-keys-read",
  ],
  consumer: ["onboard", "offboard", "purge", "adopt-consumer", "suspend", "resume", "restart-workloads", "set-size", "backup", "restore", "migrate"],
  tenant: ["create-tenant", "add-app", "remove-app", "tenant-suspend", "tenant-resume", "tenant-offboard", "tenant-purge", "tenant-restart-workloads", "tenant-set-size", "tenant-backup", "tenant-restore", "tenant-migrate"],
} as const satisfies Record<string, readonly RunKind[]>;
export type RunFamily = keyof typeof RUN_FAMILY;

export const RUN_STATUS = ["planning", "planned", "approved", "running",
  "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const STEP_STATUS = ["pending", "running", "ok", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUS)[number];

export const EVENT_STREAM = ["stdout", "stderr", "meta"] as const;
export type EventStream = (typeof EVENT_STREAM)[number];

/** The live-only stream: published to the run's SSE bus, never written to the append-only `events`
 *  table. The channel for a value that must reach the watching operator once and survive nowhere —
 *  the activate_url a first-admin invite returns. Kept OUT of EVENT_STREAM because that list types
 *  the events.stream column, and this stream must never be a value that column can hold. */
export const EPHEMERAL_STREAM = "ephemeral" as const;
/** What a run may emit: the three persisted streams, or the live-only one. */
export type RunOutputStream = EventStream | typeof EPHEMERAL_STREAM;

export const TARGET_KIND = ["server", "cluster", "app", "tenant", "credential", "all", "self"] as const;
export type TargetKind = (typeof TARGET_KIND)[number];

// The mutexes a run can hold. `server` is derived from the plan's own targets (server/executor/locks.ts
// deriveServerLocks keeps the ownsHost ones), while `git-branch`, `master-kube` and `master-vault` are
// named by a run definition's `locks` — and `master-vault` is the platform's ONE Vault, which lives on
// the master, so every cluster's Vault writes serialize on that single member instead of on a key per
// cluster. `controller` and `all` are the two GLOBAL claims, implemented by acquireLocks rather than
// named by a def: either is admitted only against an empty lock table, and while one is held every
// other claim is refused. A member nothing implements and no def names serializes nothing while
// reading as protection.
export const LOCK_RESOURCE = ["server", "git-branch", "master-kube",
  "master-vault", "controller", "all"] as const;
export type LockResource = (typeof LOCK_RESOURCE)[number];
