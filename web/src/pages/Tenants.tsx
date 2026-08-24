import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { OrphanScanView, PurgeTenantTarget, WorkloadStatusView } from "../../../shared/api-types.ts";
import {
  listTenants, getTenantLive, scanTenantOrphans, purgeTenant,
  type TenantView,
} from "../api.ts";
import { TENANT_RUN_KINDS } from "../runKinds.ts";
import { splitTenantRows, tenantRowOffer } from "../tenantRows.ts";
import { adminBadge, neverChecked, withoutAnAdministrator } from "../tenantAdmin.ts";
import { SectionRuns } from "../components/SectionRuns.tsx";
import { InviteAdminDialog } from "../components/InviteAdminDialog.tsx";
import { PurgeTenantDialog } from "../components/PurgeTenantDialog.tsx";
import { TenantOrphanPanel } from "../components/TenantOrphanPanel.tsx";
import { TenantStatusBadge, UnfinishedTenantNotice } from "../components/TenantStatusBadge.tsx";
import { ReconDrift } from "../components/ReconDrift.tsx";
import { IconChevronRight } from "../components/icons.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A tenants row narrowed to what a purge is AIMED at (PurgeTenantTarget, shared/api-types.ts): the three fields the
 *  run is keyed on plus the subdomain, which is the part of the identity a human recognises. Written
 *  once so the two purge triggers on this page — the unfinished card and the settled list — can never
 *  aim at differently-built targets. */
const purgeTarget = (t: TenantView): PurgeTenantTarget => ({ guid: t.guid, subdomain: t.subdomain, stage: t.stage, clusterId: t.clusterId });

/** ArgoCD health → a tone token (Healthy good, Degraded/Missing bad, the rest cautionary). */
function healthTone(h: string): "ok" | "warn" | "down" {
  if (h === "Healthy") return "ok";
  if (h === "Degraded" || h === "Missing") return "down";
  return "warn";
}

/** One ✓/✕ live fact (namespace present, ExternalSecrets ready, …). */
function Fact({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`recon__fact recon__fact--${ok ? "ok" : "down"}`}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

/** Workload availability rolled up across every member namespace: N of M available (cautionary tint
 *  when any is down). A tenant switched off by a suspend reads "available" everywhere — 0 replicas of 0
 *  desired is available — so a fan-out asking for no replicas at all is called what it is, PAUSED,
 *  instead of being reported as healthy. */
function WorkloadFact({ workloads }: { workloads: WorkloadStatusView[] }) {
  const up = workloads.filter((w) => w.available).length;
  const allUp = up === workloads.length;
  const paused = workloads.length > 0 && workloads.every((w) => w.desired === 0);
  if (paused) return <span className="recon__fact recon__fact--warn">{workloads.length} workloads paused</span>;
  return (
    <span className={`recon__fact recon__fact--${allUp ? "ok" : "warn"}`}>
      {up}/{workloads.length} workloads
    </span>
  );
}

/** The tenant's opt-in flags as short chips (only the enabled ones show). The trio is never among
 *  them — auth, jobs and report are members of every tenant, so there is nothing to report. */
function trioChips(t: TenantView): string[] {
  return t.seedUsers ? ["seed-users"] : [];
}

/** The LIVE reconciliation of ONE tenant, loaded lazily per row (a slow/unreachable slave spins only
 *  its own card). Mirrors ConsumerLive: a tenant fans out to MANY Applications across MANY namespaces,
 *  so the cluster FACT is every member namespace smoked and folded into one answer (all namespaces
 *  exist + the union of their workloads + all ExternalSecrets ready) and the ArgoCD FACT is the whole
 *  fan-out ROLLED UP (sync + worst-of health). The drift verdict underneath is the SAME component the
 *  Consumers card renders (ReconDrift), so both pages answer identically: the auth member's pin vs its
 *  deployed revision. */
function TenantLive({ tenantId }: { tenantId: string }) {
  const [live, setLive] = useState<Awaited<ReturnType<typeof getTenantLive>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getTenantLive(tenantId)
      .then((l) => {
        if (alive) setLive(l);
      })
      .catch((e: unknown) => {
        if (alive) setError(msg(e));
      });
    return () => {
      alive = false;
    };
  }, [tenantId]);

  if (error) return <div className="recon recon--muted">Live check failed: {error}</div>;
  if (!live)
    return (
      <div className="recon recon--muted">
        <span className="spinner" aria-hidden="true" /> Checking the cluster…
      </div>
    );
  if (live.reason === "onboarding-not-configured")
    return <div className="recon recon--muted">Live checks unavailable — tenant onboarding is not configured on this manager.</div>;

  return (
    <div className="recon">
      <div className="recon__row">
        <span className="recon__label">Cluster</span>
        {live.cluster === null ? (
          <span className="recon__fact">—</span>
        ) : !live.cluster.ok ? (
          <span className="recon__err">{live.cluster.error}</span>
        ) : (
          <>
            <Fact ok={live.cluster.namespaceExists} label={live.cluster.namespaceExists ? "namespace" : "no namespace"} />
            <WorkloadFact workloads={live.cluster.workloads} />
            <Fact ok={live.cluster.externalSecretsReady} label={live.cluster.externalSecretsReady ? "secrets synced" : "secrets not ready"} />
          </>
        )}
      </div>

      <div className="recon__row">
        <span className="recon__label">ArgoCD</span>
        {live.argo === null ? (
          <span className="recon__fact">—</span>
        ) : !live.argo.ok ? (
          <span className="recon__err">{live.argo.error}</span>
        ) : (
          <>
            <span className={`recon__fact recon__fact--${live.argo.sync === "Synced" ? "ok" : "warn"}`}>{live.argo.sync}</span>
            <span className={`recon__fact recon__fact--${healthTone(live.argo.health)}`}>{live.argo.health}</span>
          </>
        )}
        {live.argocdUrl && (
          <a className="recon__link" href={live.argocdUrl} target="_blank" rel="noreferrer">
            open in ArgoCD ↗
          </a>
        )}
      </div>

      {live.drift && <ReconDrift drift={live.drift} />}
    </div>
  );
}

/** The onboarded tenants as a two-tab section, the tenant analogue of the Consumers page.
 *  LEFT ("Reconciliation") is the combined view: each SQL row (what the Manager BELIEVES) beside the
 *  live cluster + ArgoCD facts (what actually RUNS), drift highlighted. RIGHT ("Runs") is this section's
 *  runs — the ONE shared runs component filtered to tenant kinds. Each guid whose one pointer fans out
 *  to a multi-app package links into the per-tenant detail, where the apps matrix + the tenant-wide
 *  actions live.
 *
 *  A settled tenant row is kept even after a removal, and the Reconciliation tab PARTITIONS on
 *  the shared status rule (splitTenantRows, tenantRows.ts) rather than filtering rows away: the cards show
 *  the tenants that still run, and the OFFBOARDED ones get their own compact list underneath. They have to
 *  stay reachable because an offboard KEEPS the tenant's cluster state on purpose and purge is the only
 *  run kind that reaps it — and no other surface can find such a tenant, since every removal git-rm's the
 *  pointer as its first step and the orphan scan below reads pointers.
 *
 *  PURGED tenants are the one kind this page shows NOWHERE (owner decision). A purge
 *  deprovisions the tenant — Tenant CR, namespace, Vault path, object-storage credential and Mongo
 *  databases all gone — so there is neither anything to reconcile nor anything left to reap, and keeping
 *  such a row on the "Offboarded tenants" panel is what made a completed purge look like a no-op: the row
 *  did not move and it went on offering the very purge that had just finished. The row survives in the
 *  inventory as the trace and its detail page still states the whole truth at its own URL; it is simply not
 *  listed here. That is why the split is a three-way partition and not a filter — `lists.unlisted` is the
 *  decision, made once in the shared rule, rather than a row quietly falling out of a predicate. */
export function Tenants() {
  const nav = useNavigate();
  const [rows, setRows] = useState<TenantView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"live" | "runs">("live");
  // The tenant whose first-admin invite/resend dialog is open (null = closed). Held at section level so
  // the one-time activation link the dialog shows survives independently of the row map.
  const [inviteFor, setInviteFor] = useState<TenantView | null>(null);
  // The orphan scan. null = never run: the scan CLONES catalog server-side,
  // so it is bound to an explicit operator action and must NEVER fire on page load. `scanning` drives the
  // in-flight feedback; `scanError` holds a failed REQUEST (the route itself answers a failed scan
  // fail-soft, inside the payload's `error`).
  const [scan, setScan] = useState<OrphanScanView | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // The tenant whose purge confirmation is open (null = closed) — an orphan the scan found, an unfinished
  // tenant's card, or a row from the offboarded list. Always a SELECTION, from a scan entry or a tenants
  // row: there is no free-text guid anywhere, because the guid is minted by the plan, never chosen.
  const [purgeFor, setPurgeFor] = useState<PurgeTenantTarget | null>(null);

  useEffect(() => {
    listTenants()
      .then(setRows)
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  async function runScan(): Promise<void> {
    setScanning(true);
    setScanError(null);
    try {
      setScan(await scanTenantOrphans());
    } catch (e) {
      setScan(null); // never leave a previous result standing under a failed re-scan
      setScanError(msg(e));
    } finally {
      setScanning(false);
    }
  }

  // Purge is keyed on guid+stage+cluster (an orphan has no tenant row, hence no tenantId), so it takes a
  // target rather than a row id — from the scan or from a tenants row alike. Like every other lifecycle
  // action it only PLANS the run and hands off to the Run screen, where the operator approves it.
  async function purge(target: PurgeTenantTarget): Promise<void> {
    setError(null);
    try {
      const { runId } = await purgeTenant({ guid: target.guid, stage: target.stage, clusterId: target.clusterId });
      nav(`/runs/${runId}`);
    } catch (e) {
      setError(msg(e));
    }
  }

  // Offboarded tenants keep their inventory row for audit and have nothing live to reconcile, so
  // they leave the CARDS — but not the page: they move to their own list below it, where the one run kind
  // they still have is offered (see the component docblock). A PROVISIONING tenant stays on the cards:
  // create-tenant records the row before it deploys, so this is exactly the
  // half-created tenant the operator has to see and act on — it is marked unfinished, not moved away.
  // PURGED tenants land in `lists.unlisted`, which this page renders nowhere at all.
  const lists = rows === null ? null : splitTenantRows(rows);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Tenants</h2>
          <p className="page__desc">Multi-app packages this manager has fanned out onto the clusters.</p>
        </div>
        <div className="page__actions">
          {/* Find ORPHANS: tenants that exist in GitOps but have no inventory row, so they appear in no
              list above and no row-keyed action can reach them. The scan itself is read-only (the purge
              it offers is not), and it is explicit because it clones catalog server-side. */}
          <button type="button" className="btn" onClick={() => void runScan()} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan for orphaned tenants"}
          </button>
          <Link className="btn btn--primary" to="/tenants/create">
            Create a tenant
          </Link>
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      {/* The scan's result, deliberately OUTSIDE both tabs: it answers an explicit operator action rather
          than showing either tab's data, and it must stay put while the operator works through it.
          Rendered only once a scan has actually run. */}
      {(scanning || scanError !== null || scan !== null) && (
        <TenantOrphanPanel scanning={scanning} scanError={scanError} scan={scan} onPurge={setPurgeFor} />
      )}

      {/* The finding, above everything else on the page. A tenant nobody can get into is the one
          thing here that needs acting on, and putting it inside a tab would make seeing it depend on
          which tab happens to be open. Rendered only when there IS one. */}
      {lists && withoutAnAdministrator(lists.onboarded).length > 0 && (
        <section className="alert alert--danger" aria-label="Tenants without an administrator">
          <strong>
            {withoutAnAdministrator(lists.onboarded).length} tenant(s) reported no administrator
          </strong>
          <p>
            Nobody can get into these. Open one and invite an administrator; the check runs again every
            six hours and the chip clears by itself once somebody can.
          </p>
          <ul className="rows">
            {withoutAnAdministrator(lists.onboarded).map((t) => (
              <li key={t.id}>
                <Link to={`/tenants/${t.id}`}>{t.subdomain}</Link> · {t.domain} · {t.stage}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Said out loud rather than left to be inferred from an absent chip: a tenant nothing has
          asked about is not a tenant known to be fine, and silence would read as the second. */}
      {lists && neverChecked(lists.onboarded) > 0 && (
        <p className="muted">
          {neverChecked(lists.onboarded)} tenant(s) have not been checked for an administrator yet —
          the check runs a few minutes after this manager starts, and every six hours after that.
        </p>
      )}

      <div className="tabs" role="tablist" aria-label="Tenants view">
        <button
          type="button"
          role="tab"
          id="tab-recon"
          aria-selected={tab === "live"}
          aria-controls="panel-recon"
          className={tab === "live" ? "tab tab--active" : "tab"}
          onClick={() => setTab("live")}
        >
          Reconciliation
        </button>
        <button
          type="button"
          role="tab"
          id="tab-runs"
          aria-selected={tab === "runs"}
          aria-controls="panel-runs"
          className={tab === "runs" ? "tab tab--active" : "tab"}
          onClick={() => setTab("runs")}
        >
          Runs
        </button>
      </div>

      <div role="tabpanel" id="panel-recon" aria-labelledby="tab-recon" hidden={tab !== "live"}>
        {!lists ? (
          <div className="loading">
            <span className="spinner" aria-hidden="true" />
            Loading tenants…
          </div>
        ) : lists.onboarded.length === 0 ? (
          <div className="empty">
            <p>No active tenants.</p>
            <Link className="btn btn--primary" to="/tenants/create">
              Create the first one
            </Link>
          </div>
        ) : (
          <ul className="cards">
            {lists.onboarded.map((t) => {
              // A tenant whose create-tenant run never finished. It is LISTED —
              // that is the whole point of recording the row before deploying — but it must not read as
              // live: its own badge token, the notice spelling out what the state means, and no
              // "Invite / resend admin" button, because that route now refuses a provisioning tenant
              // server-side and offering a button that always 400s is worse than offering none.
              const unfinished = t.status === "provisioning";
              // Whether a purge may be offered at all comes from the ONE shared rule (tenantRows.ts) and
              // not from the flag above, so every purge trigger in the product — this card, the settled
              // list below, the tenant detail page — is gated by the same answer the purge route gives.
              const offer = tenantRowOffer(t.status);
              return (
                <li key={t.id} className="card servercard">
                  <div className="card__head">
                    <strong className="servercard__name">{t.subdomain}</strong>
                    <TenantStatusBadge status={t.status} suspended={t.suspended} />
                  </div>
                  {/* No revision: the row holds none. The registration states no revision either, so the
                      one answer about what a tenant runs comes from the live card below, which reads it
                      off the base Application. */}
                  <div className="servercard__target">
                    {t.domain} · {t.stage}
                  </div>
                  <div className="servercard__chips">
                    <span className="chip">{t.guid}</span>
                    <span className="chip">{t.provenance}</span>
                    {trioChips(t).map((c) => (
                      <span className="chip" key={c}>
                        {c}
                      </span>
                    ))}
                    {/* What the administrator check last found. A tenant no check has reached shows
                        NOTHING here rather than a reassuring chip — tenantAdmin.ts decides that, and
                        the panel above says how many those are. */}
                    {(() => {
                      const badge = adminBadge(t, Date.now());
                      return badge === null ? null : (
                        <span className={badge.modifier ? `chip ${badge.modifier}` : "chip"} title={badge.detail}>
                          {badge.label}
                        </span>
                      );
                    })()}
                  </div>

                  {unfinished && (
                    <UnfinishedTenantNotice next="The live checks below say how far it got. Finish the run, or remove the tenant to clear whatever it left behind.">
                      {offer.purgeable && (
                        <button type="button" className="btn btn--danger" onClick={() => setPurgeFor(purgeTarget(t))}>
                          Purge…
                        </button>
                      )}
                    </UnfinishedTenantNotice>
                  )}

                  <TenantLive tenantId={t.id} />

                  <div className="actions">
                    <Link className="btn btn--primary" to={`/tenants/${t.id}`}>
                      Open <IconChevronRight />
                    </Link>
                    {t.lastRunId && (
                      <Link className="btn" to={`/runs/${t.lastRunId}`}>
                        Last run →
                      </Link>
                    )}
                    {!unfinished && (
                      <button type="button" className="btn" onClick={() => setInviteFor(t)}>
                        Invite / resend admin
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* The OFFBOARDED tenants (the row kept for history). They are off the cards above
            because there is nothing live to reconcile, but they are NOT done with: an offboard un-deploys
            a tenant and deliberately KEEPS its cluster state, so purge is the only run kind that reaps it and
            the purge route accepts exactly this row state (server tenant-live-guard.ts). This list is what
            makes such a tenant reachable from the inventory at all — the orphan scan above reads GitOps
            pointers, and every removal git-rm's the pointer as its FIRST step, so that scan can never
            return one. A compact row list, rendered only when there are such rows, so the tenants that
            still run keep the page. PURGED tenants are NOT here: they carry their own status, land in
            `lists.unlisted` and are shown nowhere on this page — the panel is for
            tenants that still have cluster state worth reaping, which a deprovisioned one does not. */}
        {lists !== null && lists.settled.length > 0 && (
          <section className="panel">
            <header className="panel__head">
              <h3 className="panel__title">Offboarded tenants</h3>
              <span className="panel__count">{lists.settled.length}</span>
            </header>
            <p className="note">
              These tenants are un-deployed and their rows are kept for history. An offboard deliberately KEEPS everything the
              tenant is — its namespace, its Tenant CR, its Vault path, its object-storage bucket and credential and its Mongo
              databases — so it stays re-onboardable, and <strong>purge</strong> is the run kind that reaps exactly that, which is why it
              is offered here and runs AFTER the offboard. A tenant that has already been purged is not on this list: it is recorded
              purged and leaves the page entirely, since there is nothing left to reap. Re-running a removal is safe either way —
              every step reaps only what is still there — and a tenant&apos;s last run names what it actually deleted.
            </p>
            <ul className="rows">
              {lists.settled.map((t) => (
                <li key={t.id}>
                  <div className="row">
                    <TenantStatusBadge status={t.status} />
                    <span className="row__title">{t.subdomain}</span>
                    <span className="row__meta">
                      {t.guid} · {t.stage} · {t.domain}
                    </span>
                    <span className="row__end">
                      <Link className="btn" to={`/tenants/${t.id}`}>
                        Open <IconChevronRight />
                      </Link>
                      {tenantRowOffer(t.status).purgeable && (
                        <button type="button" className="btn btn--danger" onClick={() => setPurgeFor(purgeTarget(t))}>
                          Purge…
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {inviteFor && <InviteAdminDialog tenant={inviteFor} onClose={() => setInviteFor(null)} />}
      </div>

      <div role="tabpanel" id="panel-runs" aria-labelledby="tab-runs" hidden={tab !== "runs"}>
        <SectionRuns kinds={TENANT_RUN_KINDS} empty="No tenant runs yet — create a tenant to start one." />
      </div>

      {purgeFor && (
        <PurgeTenantDialog
          target={purgeFor}
          onCancel={() => setPurgeFor(null)}
          onConfirm={() => {
            const t = purgeFor;
            setPurgeFor(null);
            void purge(t);
          }}
        />
      )}
    </section>
  );
}
