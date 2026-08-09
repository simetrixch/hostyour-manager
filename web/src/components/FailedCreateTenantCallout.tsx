import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { PurgeTenantTarget, RunTenantStateView } from "../../../shared/api-types.ts";
import { purgeTenant } from "../api.ts";
import { runTenantPurgeTarget } from "../runScreen.ts";
import { PurgeTenantDialog } from "./PurgeTenantDialog.tsx";
import { TenantStatusBadge, UnfinishedTenantNotice } from "./TenantStatusBadge.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a FAILED create-tenant run left behind, rendered by RunDetail for exactly
 *  that case and nothing else — the tenant-specific concern lives HERE so the run screen itself stays
 *  kind-agnostic (the same factoring as OnboardApproveForm).
 *
 *  WHY this exists: a failed create-tenant CAN leave the tenant standing in GitOps and on the cluster —
 *  a fan-out, an isolation AppProject, a namespace, a Tenant CR — and purge is the only verb that removes
 *  ALL of it, because it is keyed on the MINTED guid rather than on an inventory row. The operator is
 *  already looking at the run that failed, and this run's own frozen params carry that guid, so the offer
 *  belongs right here instead of sending them to hunt through the Tenants page. It is also the only place
 *  the guid survives when no pointer was ever written (a failure between apply-appproject and
 *  write-pointer), which the Tenants-page pointer scan structurally cannot see.
 *
 *  The state arrives RESOLVED, as props: the run screen owns the one GET, because its action bar gates
 *  "Abort (cleanup)" on the same answer these words are written from — an abort un-deploys this very
 *  tenant — and two independent reads could have the bar offering a cleanup while the copy below it says
 *  the tenant is live. `tenant === null` with no `error` is therefore the lookup still running.
 *
 *  WHY IT DOES NOT DECIDE FROM "the run failed": that says nothing about the TENANT. `activate` (the
 *  first-admin invite) is deliberately create-tenant's LAST step, placed after record-inventory so a
 *  failed invite never rolls back a live deployment — and an HTTP 503 from a freshly started tenant
 *  example-auth is a known live condition. A run that failed only there sits behind a tenant whose fan-out
 *  synced, whose namespace smoke-checked and whose rows record-inventory already settled to "active": it
 *  is SERVING. Claiming there that the tenant "may still exist" and is "listed as unfinished" would be
 *  false on both counts, and the button beside that copy plans the one verb that deletes the Tenant CR
 *  and thereby drops the live tenant's Mongo databases and its Vault path. So the server resolves the
 *  tenants ROW (GET /api/tenants/runs/:runId/tenant-state) and this renders ONE branch per state, each
 *  carrying its own words AND its own actions — the offer exists only where purge is genuinely the
 *  remedy (no row at all, or a row still "provisioning"), which is the same gate the Tenants list and the
 *  tenant detail page already apply.
 *
 *  Every state says something out loud — the lookup running, a lookup failure, the honest "this run
 *  created nothing" answer, and each of the six tenant states. There is ONE branch per member of
 *  RunTenantStateView and no catch-all: the chain's last arm narrows to a single state, so a member added
 *  to the union with a shape of its own fails the typecheck HERE instead of being swept into whichever arm
 *  happens to be last and having that arm's `row` read off it — which is precisely how "not-deployed"
 *  landed in the offboarded arm and threw on a state that carries no row. A member shaped like an existing
 *  one still type-checks in the last arm, so the branches are also a discipline: the two SETTLED states,
 *  "offboarded" and "purged", carry the same `row` and are told apart by explicit tests because they mean
 *  opposite things about what survived. That union is now declared ONCE
 *  (shared/api-types.ts) and returned by the server's resolveRunTenantState, so "the server sent a state
 *  this file has never heard of" is no longer reachable. WHICH tenant may be purged is
 *  not decided here either but in the shared rule (runScreen.ts runTenantPurgeTarget), the same one the
 *  action bar's abort confirmation names its tenant from. Confirming a purge only PLANS it (our own
 *  dialog, never a native confirm()); the operator approves it on the run screen this then opens. */
export function FailedCreateTenantCallout({ tenant, error }: { tenant: RunTenantStateView | null; error: string | null }): ReactNode {
  const navigate = useNavigate();
  // A failed purge PLAN, kept apart from the lookup: the state is still known, so the callout stays and
  // the failure is reported above it instead of erasing what the operator was reading.
  const [planError, setPlanError] = useState<string | null>(null);
  const [purgeFor, setPurgeFor] = useState<PurgeTenantTarget | null>(null);

  /** Plan the tenant-purge and open ITS run screen — the same plan-then-approve hand-off every other
   *  lifecycle action makes; nothing is deleted until that approval. */
  function plan(target: PurgeTenantTarget): void {
    setPlanError(null);
    purgeTenant({ guid: target.guid, stage: target.stage, clusterId: target.clusterId })
      .then(({ runId: purgeRunId }) => navigate(`/runs/${purgeRunId}`))
      .catch((e: unknown) => setPlanError(msg(e)));
  }

  // The LOOKUP failure — terminal for this callout: with no state read there is nothing honest to say
  // about the tenant, so it replaces the callout rather than sitting above a guess. (The action bar above
  // refuses its abort on the same input, for the same reason.)
  if (error !== null) {
    return (
      <div className="actionbar">
        <span className="actionbar__text">
          <strong>Could not read this run&apos;s tenant.</strong> {error}
        </span>
      </div>
    );
  }
  if (tenant === null) {
    return (
      <div className="actionbar">
        <span className="actionbar__text">
          <span className="spinner" aria-hidden="true" /> Working out what this failed create-tenant left behind…
        </span>
      </div>
    );
  }

  /** The purge trigger, offered ONLY from the two branches below that are genuinely purgeable. */
  const purgeButton = (target: PurgeTenantTarget): ReactNode => (
    <button type="button" className="btn btn--danger" onClick={() => setPurgeFor(target)}>
      Purge tenant…
    </button>
  );
  // The tenant this screen still has standing, from the SHARED rule — never a per-branch decision, so
  // this button and the abort confirmation above it can never disagree about whether a tenant is there.
  const purgeable = runTenantPurgeTarget(tenant);

  return (
    <>
      {planError !== null && (
        <p role="alert" className="alert alert--danger">
          The purge could not be planned: {planError}
        </p>
      )}

      {tenant.state === "none" ? (
        <div className="actionbar">
          <span className="actionbar__text">Nothing to purge — {tenant.reason}</span>
        </div>
      ) : tenant.state === "not-deployed" ? (
        // The run was REFUSED at its own precondition: attest-target is create-tenant's step 0 and
        // record-provisional, the first step that touches anything, comes after it — so the plan minted
        // and froze this guid, and then nothing was written to GitOps, nothing fanned out and no row was
        // recorded. It is the opposite truth from "orphan" above, which also has no row: telling this
        // operator the tenant "may still exist" would send them purging a tenant that was never created.
        <div className="actionbar">
          <span className="actionbar__text">
            <strong>This create-tenant was refused before it deployed anything.</strong> Its target attestation —{" "}
            <code>attest-target</code>, the first step and the only one ahead of every mutation — failed, so tenant{" "}
            <code>{tenant.target.guid}</code> ({tenant.target.subdomain}) was never written to GitOps, never fanned out and was
            never recorded in the inventory. There is nothing out there to remove, which is why no purge is offered here. Fix what
            that step reported and retry it, or delete this run.
          </span>
        </div>
      ) : tenant.state === "orphan" ? (
        // No tenants row carries this guid, so the tenant is on NO list in the product and no row-keyed
        // action can reach it — this run is the only place its identity survives.
        <div className="actionbar">
          <span className="actionbar__text">
            <strong>This create-tenant failed after it had started deploying, and nothing recorded the tenant.</strong> Tenant{" "}
            <code>{tenant.target.guid}</code> ({tenant.target.subdomain}) may still exist in GitOps and on the cluster — its
            fan-out, its isolation AppProject, its namespace and its Tenant CR — but no inventory row carries it, so it appears in
            no list on the Tenants page and no other action can reach it. Purge force-removes that whole footprint by guid,
            including the parts an offboard leaves standing.
          </span>
          {purgeable && purgeButton(purgeable)}
        </div>
      ) : tenant.state === "unfinished" ? (
        // The row is "provisioning": record-provisional wrote it and this run never settled it. Same
        // words as the Tenants list and the tenant detail page — only the evidence pointer differs.
        <UnfinishedTenantNotice next="The steps below say how far it got. Retry the failed step above to finish it, or purge the tenant to clear whatever it left behind.">
          {purgeable && purgeButton(purgeable)}
        </UnfinishedTenantNotice>
      ) : tenant.state === "live" ? (
        // record-inventory settled the tenant and its app rows, which happens only after the whole
        // fan-out synced and the namespace smoke-checked — so the failure is at a LATER step and the
        // tenant is serving. No purge is offered here: it would deprovision a live tenant.
        <div className="actionbar">
          <span className="actionbar__text">
            <strong>The tenant this run created is live — do not remove it.</strong> Tenant <code>{tenant.target.guid}</code> (
            {tenant.target.subdomain}) is recorded <TenantStatusBadge status={tenant.row.status} suspended={tenant.row.suspended} />{" "}
            in the inventory: <code>record-inventory</code> settled the tenant and its app rows, which happens only once the whole
            fan-out is Synced and the namespace has been smoke-checked. The step that failed here comes after that —{" "}
            <code>activate</code>, the first-admin invite, is deliberately the last step so a failed invite never rolls back a live
            deployment. Retry the failed step above, or open the tenant to resend the admin invite.
          </span>
          <Link className="btn" to={`/tenants/${tenant.row.tenantId}`}>
            Open the tenant →
          </Link>
        </div>
      ) : tenant.state === "offboarded" ? (
        // The row is settled offboarded: the tenant was UN-DEPLOYED after this run, so THIS screen
        // has no removal to offer — one already ran. It does NOT follow that nothing SURVIVED it: an
        // offboard keeps the tenant's whole cluster footprint on purpose, and the purge that reaps it is
        // still ahead. That purge is aimed from the tenant page (tenantRows.ts calls an offboarded row
        // purgeable), never from here — this screen belongs to the run that CREATED the tenant, and the
        // removal it needs was already decided elsewhere. The orphan scan is no answer to "what is left"
        // either: EVERY removal path git-rm's the pointer as its FIRST step and settles the row as its
        // LAST, so a scan that reads pointers can never return this guid, however much of it still stands.
        <div className="actionbar">
          <span className="actionbar__text">
            <strong>The tenant this run created has since been offboarded.</strong> Tenant <code>{tenant.target.guid}</code> (
            {tenant.target.subdomain}) is recorded <TenantStatusBadge status={tenant.row.status} suspended={tenant.row.suspended} />{" "}
            — the row is kept for history, and this screen offers no removal on it: one already ran. An offboard
            <strong> un-deploys</strong> a tenant and deliberately KEEPS everything it is — its namespace, its Tenant CR, its Vault
            path, its object-storage bucket and credential and its Mongo databases — so it stays re-onboardable. <strong>Purge</strong>{" "}
            is the verb that removes those as well, and the tenant&apos;s own page is where it is aimed. Its removal run names every
            artifact it deleted or found already absent, step by step. The orphan scan cannot answer this — it reads the GitOps
            pointers, and this tenant&apos;s pointer went with the first step of the offboard.
          </span>
          <Link className="btn" to={`/tenants/${tenant.row.tenantId}`}>
            Open the tenant →
          </Link>
        </div>
      ) : (
        // The row is settled purged — the last arm, narrowing to that one state. What a purge REAPS is
        // certain: pointer, fan-out, AppProject, namespaces, Tenant CR. What it deprovisions is not,
        // and the text must not claim otherwise: nothing reconciles a Tenant CR today, so its
        // deprovision step refuses and only settles when an operator skips it after cleaning up by
        // hand. The run is the record of which of the two happened. No removal is offered here OR on
        // the tenant page, and such a tenant is off the Tenants list entirely, so this link is one of
        // the few ways back to it.
        <div className="actionbar">
          <span className="actionbar__text">
            <strong>The tenant this run created has since been purged.</strong> Tenant <code>{tenant.target.guid}</code> (
            {tenant.target.subdomain}) is recorded <TenantStatusBadge status={tenant.row.status} suspended={tenant.row.suspended} />{" "}
            — its GitOps pointer, its fan-out, its isolation AppProject and its Tenant CR are gone, and its namespace was issued a delete (the run's log says whether one is still Terminating). Whether its
            Vault crypto path, its object-storage credential and its Mongo databases went with them is what the purge run says:
            nothing deprovisions a tenant today, so that step refuses and settles only when an operator skips it after clearing
            those by hand. The row is kept as the trace; no removal is offered on it anywhere. Open the tenant to follow the purge
            run, which names every artifact it deleted or found already absent.
          </span>
          <Link className="btn" to={`/tenants/${tenant.row.tenantId}`}>
            Open the tenant →
          </Link>
        </div>
      )}

      {purgeFor && (
        <PurgeTenantDialog
          target={purgeFor}
          onCancel={() => setPurgeFor(null)}
          onConfirm={() => {
            const t = purgeFor;
            setPurgeFor(null);
            plan(t);
          }}
        />
      )}
    </>
  );
}
