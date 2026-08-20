import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { RunView } from "../../../shared/api-types.ts";
import {
  getTenant, addTenantApp, removeTenantApp, offboardTenant, suspendTenant, resumeTenant, restartTenantWorkloads, purgeTenant,
  setTenantSize,
  backupTenant, restoreTenant, migrateTenant, listTenantTargets, listRuns,
  type TenantDetailView,
} from "../api.ts";
import { tenantRowOffer } from "../tenantRows.ts";
import { relocationRun, relocationLine } from "../relocationBand.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { SetSizeDialog } from "../components/SetSizeDialog.tsx";
import { TypeToConfirm } from "../components/TypeToConfirm.tsx";
import { PurgeTenantDialog } from "../components/PurgeTenantDialog.tsx";
import { RelocationTargetDialog } from "../components/RelocationTargetDialog.tsx";
import { TenantStatusBadge, UnfinishedTenantNotice } from "../components/TenantStatusBadge.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Per-tenant detail. Renders the guid × apps[] matrix as a row list, an inline
 *  add-app control that fans ONE new app into the live tenant, and the tenant-wide lifecycle actions
 *  (suspend / resume / offboard). Every action plans a Run and hands off to the generic Run screen —
 *  add-app streams the T1..T4 subset validation; remove-app and the lifecycle triggers plan
 *  synchronously. Offboard is guarded by a typed-guid confirm: it prunes the whole fan-out, so the
 *  operator must retype the guid, not just click through a dialog.
 *
 *  A tenant whose create-tenant run never finished (status "provisioning") shows
 *  the unfinished badge + notice and offers only the two run kinds that mean anything on it: OFFBOARD (the
 *  clean row-keyed way out) and PURGE (the force-removal by guid). Everything that assumes a live tenant
 *  — add-app, remove-app, suspend, resume — is hidden here AND refused by its route; the route is the
 *  guard, this is only the honest surface.
 *
 *  A SETTLED tenant — the row kept for history — swaps the whole live action surface for one bar
 *  at the foot, and WHICH bar depends on how it was settled, because the two terminal states mean opposite
 *  things:
 *   - "offboarded" keeps exactly ONE action, and that is deliberate: an offboard un-deploys a tenant and
 *     KEEPS its cluster state — the <guid> namespace, its Tenant CR, its Vault path, its object-storage
 *     credential and its Mongo databases all outlive the row — so purge is the only run kind that reaps them,
 *     and the purge route accepts precisely this row state (server tenant-live-guard.ts). That makes
 *     offboard-then-purge the one removal ORDER the routes support, and this page one of the two surfaces
 *     where the second half is reachable (the other is the offboarded list on the Tenants page): the
 *     orphan scan cannot find such a tenant, because every removal git-rm's the pointer as its first step
 *     and that scan reads pointers.
 *   - "purged" keeps NONE. The tenant is deprovisioned, so there is nothing left to reap and no run kind to
 *     offer. This page matters more for it than for any other state, not less: a purged tenant is off the
 *     Tenants list entirely, so this URL is where the operator still gets the full account of what went —
 *     which is why the bar states the deprovision plainly instead of hedging about which removal ran.
 *  WHICH run kinds a row is offered is the shared rule (tenantRowOffer, tenantRows.ts), asked once for this
 *  page and the list, so neither can offer a purge the other withholds. */
export function TenantDetail() {
  const { id } = useParams();
  const tenantId = id ?? "";
  const nav = useNavigate();
  const [tenant, setTenant] = useState<TenantDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newApp, setNewApp] = useState("");
  const [busy, setBusy] = useState(false);
  const [removeApp, setRemoveApp] = useState<string | null>(null);
  const [offboardT, setOffboardT] = useState<TenantDetailView | null>(null);
  const [purgeT, setPurgeT] = useState<TenantDetailView | null>(null);
  // The relocation dialogs: "Back up" is a plain confirm (no target); "Move…"/"Restore…"
  // pick a target cluster. Confirming only PLANS the run and opens its screen.
  const [backupT, setBackupT] = useState<TenantDetailView | null>(null);
  // The size dialog's target (null = closed) — its own state beside the confirm dialogs, because it
  // asks WHICH size where those only confirm.
  const [sizeT, setSizeT] = useState<TenantDetailView | null>(null);
  const [relocT, setRelocT] = useState<{ t: TenantDetailView; kind: "move" | "restore" } | null>(null);
  // The one shared runs list, for the relocation state band (relocationBand.ts).
  const [runs, setRuns] = useState<RunView[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    getTenant(tenantId)
      .then(setTenant)
      .catch((e: unknown) => setError(msg(e)));
    // The band is contextual, never load-bearing: a failed runs read leaves the page intact.
    listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [tenantId]);

  /** Run any lifecycle/matrix trigger, then jump to its Run screen. A single busy flag disables the
   *  whole action surface while a trigger is in flight (they all mutate the one tenant). */
  async function act(fn: () => Promise<{ runId: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await fn();
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  }

  async function submitAddApp(e: FormEvent): Promise<void> {
    e.preventDefault();
    const app = newApp.trim();
    if (!app) return;
    await act(() => addTenantApp(tenantId, app));
  }

  if (error && !tenant)
    return (
      <p role="alert" className="alert alert--danger">
        {error}
      </p>
    );
  if (!tenant)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading tenant…
      </div>
    );

  const t = tenant;
  // WHICH surface this row gets, from the ONE shared rule (tenantRows.ts): `settled` swaps the live
  // action surface for the offboarded bar at the foot, `purgeable` gates every purge trigger on the page
  // so this screen can never offer a purge the route refuses — nor withhold one the route accepts.
  const offer = tenantRowOffer(t.status);
  const settled = offer.settled;
  // Its create-tenant run recorded the row and never finished — see the component docblock.
  const unfinished = t.status === "provisioning";
  // A tenant-purge already ran to completion on this tenant. It is settled like an
  // offboarded one, so the live action surface is gone either way; what differs is the account the bar at
  // the foot gives — deprovisioned and final, versus un-deployed with a purge still ahead of it.
  const purged = t.status === "purged";

  return (
    <section className="page">
      <header className="page__head">
        <div>
          {/* The tenant's ONE identity, printed BARE: the guid is the BRACKET every member is named from
              (namespace and AppProject <guid>-<member>, server tenant-fanout.ts `memberNamespace`) and the
              last segment of the Vault path <stage>/tenants/<guid> — there is no `t-` prefix anywhere. This
              is the most prominent identifier on the page, so a decorated one is the string an operator
              copies into `kubectl get ns` or a Vault path and finds nothing under;
              the offboard/purge copy below already prints the bare guid in exactly those two places. */}
          <span className="page__eyebrow">
            <Link to="/tenants">Tenants</Link> · {t.guid}
          </span>
          <h2 className="page__title">{t.subdomain}</h2>
          {/* This page reads pure SQL and runs NO live checks of its own, so it prints no revision — it
              holds none, and neither does the tenant's registration. The live targeted-vs-deployed answer
              lives one click back on the Tenants card, where the live route reads both off the base
              Application and gives them a verdict (server/domains/onboarding/api.ts driftOf). */}
          <p className="page__desc">
            {t.domain} · {t.stage}
            {t.owner ? ` · ${t.owner}` : ""}
          </p>
        </div>
        <div className="page__actions">
          <TenantStatusBadge status={t.status} suspended={t.suspended} />
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      {/* The relocation state band: an open or failed backup/restore/move of THIS tenant
          surfaces here, off the one shared runs table, linking to its Run screen. */}
      {(() => {
        const band = relocationRun(tenantId, runs);
        return band ? (
          <p className="servercard__run">
            <Link to={`/runs/${band.id}`}>{relocationLine(band)} →</Link>
          </p>
        ) : null;
      })()}

      {unfinished && (
        // This page has no live checks of its own, so it points at the create-tenant run instead — the
        // notice takes that sentence from each screen precisely so it never cites evidence that is not there.
        <UnfinishedTenantNotice
          next={
            t.lastRunId
              ? "Open its create-tenant run to see how far it got. Finish that run, or remove the tenant to clear whatever it left behind."
              : "Its create-tenant run is no longer on record, so the only way out is to remove the tenant and clear whatever it left behind."
          }
        >
          {t.lastRunId && (
            <Link className="btn" to={`/runs/${t.lastRunId}`}>
              Open the run →
            </Link>
          )}
          {offer.purgeable && (
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setPurgeT(t)}>
              Purge…
            </button>
          )}
        </UnfinishedTenantNotice>
      )}

      <div className="servercard__chips">
        <span className="chip">{t.provenance}</span>
        {t.seedUsers && <span className="chip">seed-users</span>}
      </div>

      <h3 className="steps-panel__title">Apps</h3>
      {t.apps.length === 0 ? (
        <div className="empty">
          <p>No apps yet — this tenant runs only its mandatory trio: auth, jobs and report.</p>
        </div>
      ) : (
        <ul className="rows">
          {t.apps.map((a) => (
            <li key={a.id}>
              <div className="row">
                <TenantStatusBadge status={a.status} />
                <span className="row__title">{a.name}</span>
                <span className="row__meta">{t.guid}-{a.name}-{t.stage}</span>
                <span className="row__end">
                  {a.lastRunId && (
                    <Link className="btn" to={`/runs/${a.lastRunId}`}>
                      Last run →
                    </Link>
                  )}
                  {/* The per-app remove, gated by the SAME shared status rule as everything else on this
                      page: an app row that a remove-app or a tenant-wide removal already settled
                      ("offboarded" or "purged") has no Application left to prune. */}
                  {!settled && !unfinished && !tenantRowOffer(a.status).settled && (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setRemoveApp(a.name)}>
                      Remove
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!settled && !unfinished && (
        <form className="actions" onSubmit={submitAddApp}>
          <input
            className="input"
            value={newApp}
            onChange={(e) => setNewApp(e.target.value)}
            placeholder="new app name (e.g. web)"
            pattern="[a-z][a-z0-9-]{0,28}[a-z0-9]"
          />
          <button type="submit" className="btn btn--primary" disabled={busy || !newApp.trim()}>
            Add app
          </button>
        </form>
      )}

      {!settled && (
        <div className="actionbar">
          <span className="actionbar__text">Tenant-wide actions plan a Run and hand off to the Run screen.</span>
          {/* Suspend/resume flip a pointer an unfinished tenant may never have had — their routes refuse
              it, so the buttons are not offered either. Offboard stays: it IS the clean way out. */}
          {!unfinished && !t.suspended && (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => suspendTenant(tenantId))}>
              Suspend
            </button>
          )}
          {!unfinished && t.suspended && (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void act(() => resumeTenant(tenantId))}>
              Resume
            </button>
          )}
          {/* The last step of putting a new secret value in front of a tenant, and only that: the run
              rolls the pods of every member namespace so they read their Secrets again — it moves no
              secret itself, which is what its plan summary says before anyone approves it. Not offered
              on a suspended tenant: it renders replicas 0, so no pod holds a stale value. */}
          {!unfinished && !t.suspended && (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => restartTenantWorkloads(tenantId))}>
              Restart workloads
            </button>
          )}
          {/* Offered whatever the pause state: a ceiling is a property of the member namespaces, and a
              suspended tenant still owns them. */}
          {!unfinished && (
            <button type="button" className="btn" disabled={busy} onClick={() => setSizeT(t)}>
              Set size…
            </button>
          )}
          {!unfinished && (
            <button type="button" className="btn" disabled={busy} onClick={() => setBackupT(t)}>
              Back up
            </button>
          )}
          {!unfinished && !t.suspended && (
            <button type="button" className="btn" disabled={busy} onClick={() => setRelocT({ t, kind: "move" })}>
              Move…
            </button>
          )}
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setOffboardT(t)}>
            Offboard
          </button>
        </div>
      )}

      {removeApp && (
        <ConfirmDialog
          title={`Remove app "${removeApp}" from this tenant?`}
          confirmLabel="Remove app"
          destructive
          onCancel={() => setRemoveApp(null)}
          onConfirm={() => { const a = removeApp; setRemoveApp(null); void act(() => removeTenantApp(tenantId, a)); }}
        >
          <p>ArgoCD prunes its Application(s); the rest of the fan-out stays.</p>
        </ConfirmDialog>
      )}

      {offboardT && (
        <TypeToConfirm
          title={`Offboard tenant "${offboardT.subdomain}"?`}
          expected={offboardT.guid}
          confirmLabel="Offboard tenant"
          onCancel={() => setOffboardT(null)}
          onConfirm={() => { setOffboardT(null); void act(() => offboardTenant(tenantId)); }}
        >
          <p>
            This removes the tenant&apos;s GitOps pointer, ArgoCD prunes its WHOLE fan-out package, its{" "}
            <span className="mono">{offboardT.guid}</span> isolation AppProject is deleted, and the registry row is marked
            offboarded and kept.
          </p>
          <p>
            It stops there. Everything the tenant IS keeps standing, deliberately, so it stays re-onboardable: the{" "}
            <span className="mono">{offboardT.guid}</span> namespace, its Tenant CR, its Vault path{" "}
            <span className="mono">
              {offboardT.stage}/tenants/{offboardT.guid}
            </span>
            , its object-storage bucket and credential and its <strong>Mongo databases all SURVIVE an offboard</strong>.{" "}
            <strong>Purge</strong> is the run kind that removes those as well, and it runs <strong>after</strong> this offboard, never
            before it: a purge aimed at a tenant the inventory still records active or suspended, whose GitOps pointer still stands,
            is refused. Once this offboard has settled the row, the purge is offered here at the foot of this page and on the{" "}
            <strong>Offboarded tenants</strong> list on the Tenants page. (The orphan scan there is no route to it — it reads GitOps
            pointers, and this offboard removes the pointer in its first step.)
          </p>
        </TypeToConfirm>
      )}

      {/* The force-removal by guid, offered on the two rows tenantRowOffer calls purgeable: the UNFINISHED
          tenant (offboard is the clean path, but a create-tenant that died can leave state offboard's
          pointer-driven teardown does not reach — a Tenant CR, a namespace) and the SETTLED one below
          (an offboard leaves that same state standing ON PURPOSE, and purge is what reaps it). The ONE
          dialog states the consequence, the same one the Tenants page and the failed-run callout show —
          confirming only PLANS the run. */}
      {purgeT && (
        <PurgeTenantDialog
          target={{ guid: purgeT.guid, subdomain: purgeT.subdomain, stage: purgeT.stage, clusterId: purgeT.clusterId }}
          onCancel={() => setPurgeT(null)}
          onConfirm={() => {
            const p = purgeT;
            setPurgeT(null);
            void act(() => purgeTenant({ guid: p.guid, stage: p.stage, clusterId: p.clusterId }));
          }}
        />
      )}

      {settled && (
        // The settled tenant's ONE surface (see the component docblock). The row now records WHICH kind of
        // removal ran — "offboarded" or "purged" — so the copy states what actually
        // survived instead of naming both possibilities and letting the operator work it out. The purge
        // trigger below is gated by the shared rule, which offers it on the first and not on the second.
        <div className="actionbar">
          {purged ? (
            <span className="actionbar__text">
              <strong>This tenant was purged</strong> — the row is kept as the trace and this page is the only place it is
              still listed, since a purged tenant leaves the Tenants page. Its GitOps pointer, its fan-out, its{" "}
              <span className="mono">{t.guid}</span> isolation AppProject, its <span className="mono">{t.guid}</span> namespace and its
              Tenant CR are gone, and deleting that last one made the tenant operator remove its Vault path{" "}
              <span className="mono">
                {t.stage}/tenants/{t.guid}
              </span>
              , revoke its object-storage credential and drop its Mongo databases. Only its <strong>object-storage bucket</strong> and
              the objects in it were kept, deliberately. No removal is offered here: there is nothing left to reap. Its last run names,
              step by step, what it deleted or found already absent.
            </span>
          ) : (
            <span className="actionbar__text">
              <strong>This tenant was offboarded</strong> — it is un-deployed and the row is kept for history. An offboard
              deliberately KEEPS everything the tenant is, so it stays re-onboardable: the <span className="mono">{t.guid}</span>{" "}
              namespace, its Tenant CR, its Vault path{" "}
              <span className="mono">
                {t.stage}/tenants/{t.guid}
              </span>
              , its object-storage bucket and credential and its Mongo databases all still stand. <strong>Purge</strong> is the run kind
              that reaps exactly those, and this is where it is aimed at a tenant that is already off the Tenants cards. Its last run
              names, step by step, what it deleted or found already absent.
            </span>
          )}
          {t.lastRunId && (
            <Link className="btn" to={`/runs/${t.lastRunId}`}>
              Last run →
            </Link>
          )}
          {/* Restore is offered on the OFFBOARDED row only: an offboard kept the tenant's Vault entry
              and cluster state, so a restore rebuilds it data-identically from its Storage Box folder.
              A PURGED tenant lost its Vault path — its identity cannot be rebuilt by a restore, which
              deliberately never writes Vault. */}
          {!purged && (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setRelocT({ t, kind: "restore" })}>
              Restore…
            </button>
          )}
          {offer.purgeable && (
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setPurgeT(t)}>
              Purge…
            </button>
          )}
        </div>
      )}

      {sizeT && (
        <SetSizeDialog
          unit={sizeT.subdomain}
          kind="tenant"
          unitId={tenantId}
          scope="EACH member namespace of this tenant"
          onCancel={() => setSizeT(null)}
          onConfirm={(size) => { setSizeT(null); void act(() => setTenantSize(tenantId, size)); }}
        />
      )}

      {backupT && (
        <ConfirmDialog
          title={`Back up tenant "${backupT.subdomain}"?`}
          confirmLabel="Plan backup"
          onCancel={() => setBackupT(null)}
          onConfirm={() => {
            setBackupT(null);
            void act(() => backupTenant(tenantId));
          }}
        >
          <p>
            This <strong>plans</strong> a backup run and opens it — you approve on the next screen. The run{" "}
            <strong>closes access to the whole tenant for the duration of the dump</strong> (downtime, never an inconsistent copy),
            dumps every <span className="mono">{backupT.guid}_*</span> database, the object-storage bucket and the crypto material
            into the Storage Box folder <span className="mono">/{backupT.guid}/</span>, verifies the folder and reopens. The folder
            stays.
          </p>
        </ConfirmDialog>
      )}

      {relocT && (
        <RelocationTargetDialog
          title={relocT.kind === "move" ? `Move tenant "${relocT.t.subdomain}" to another cluster?` : `Restore tenant "${relocT.t.subdomain}" from its backup?`}
          kind={relocT.kind}
          confirmLabel={relocT.kind === "move" ? "Plan move" : "Plan restore"}
          stage={relocT.t.stage}
          currentClusterId={relocT.t.clusterId}
          loadTargets={listTenantTargets}
          onCancel={() => setRelocT(null)}
          onConfirm={(targetClusterId) => {
            const { kind } = relocT;
            setRelocT(null);
            void act(() => (kind === "move" ? migrateTenant(tenantId, targetClusterId) : restoreTenant(tenantId, targetClusterId)));
          }}
        >
          {relocT.kind === "move" ? (
            <p>
              This <strong>plans</strong> a move and opens it — you approve on the next screen. The WHOLE bracket moves under the
              unchanged guid <span className="mono">{relocT.t.guid}</span>: access closes while every store is dumped to the Storage
              Box, the fan-out deploys closed on the target, the data is replayed and verified, <strong>the one wildcard record is
              updated</strong> (addresses, sessions and the identity provider survive), access reopens, and the source is cleared{" "}
              <strong>last</strong>.
            </p>
          ) : (
            <p>
              This <strong>plans</strong> a restore and opens it — you approve on the next screen. The run rebuilds tenant{" "}
              <span className="mono">{relocT.t.guid}</span> from its Storage Box folder: every member is provisioned from the dumped
              registration, the fan-out deploys closed, every <span className="mono">{relocT.t.guid}_*</span> database and the bucket
              are replayed and verified (the crypto material stays in Vault, byte-identical), the wildcard record is set, and access
              opens last.
            </p>
          )}
        </RelocationTargetDialog>
      )}
    </section>
  );
}
