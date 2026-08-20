import type { ReactNode } from "react";
import { TypeToConfirm } from "./TypeToConfirm.tsx";
import type { PurgeTenantTarget } from "../../../shared/api-types.ts";

/** Confirm a tenant PURGE (force-offboard by guid) — the tenant analogue of PurgeOrphanDialog, and the
 *  ONE place the consequence is spelled out, so the Tenants-page orphan scan and the failed-create-tenant
 *  run screen can never describe the same destructive action differently.
 *
 *  It deliberately does NOT collect the target the way the consumer dialog collects a name + cluster: a
 *  consumer name is operator-chosen (G1: name == namespace), while a tenant guid is MINTED by the
 *  create-tenant plan. A free-text guid field would therefore be an invitation to typo a foreign tenant's
 *  identity into a destructive run, so the target always arrives as a SELECTION — from the orphan scan or
 *  from the run's own frozen params — and this dialog only confirms it.
 *
 *  The arming is TypeToConfirm's: the operator retypes the exact guid before the destructive button
 *  enables, the same real-intent test the consumer purge and the offboard confirms use — and it doubles
 *  as a read-back of WHICH guid is about to be reaped. Our own dialog chrome throughout; never a native
 *  confirm(). Confirming only PLANS the run: the operator approves it on the Run screen.
 *
 *  The COPY is held to the plan summary tenant-purge.run.ts renders seconds later on that approve screen:
 *  the two surfaces describe the SAME run, so this dialog may not promise what that summary denies. It
 *  therefore states what the run actually does — a fan-out that cannot be proven pruned FAILS the run
 *  instead of settling the inventory row (the teardown's settle guard, tenant-teardown.ts
 *  settlePruneGuardStep), the target attestation and the Tenant CR delete fail closed too, and a purge
 *  aimed at a tenant the inventory calls live whose pointer still stands is refused by the shared
 *  live-tenant rule (tenant-live-guard.ts assertTenantNotLive) at BOTH of its ends — on the route before
 *  a Run exists (api.ts) and again in the run's own attest-target step once it is approved — rather than
 *  the flatter "every step is fail-soft, so it always runs through", which was true of neither the run
 *  nor the route. */
export function PurgeTenantDialog(props: { target: PurgeTenantTarget; onConfirm: () => void; onCancel: () => void }): ReactNode {
  const { target } = props;
  return (
    <TypeToConfirm
      title={`Purge tenant "${target.subdomain}"?`}
      expected={target.guid}
      confirmLabel="Plan purge"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    >
      <p>
        This force-removes the tenant&apos;s <strong>whole footprint by guid</strong> — its GitOps pointer, every ArgoCD Application of
        its fan-out, the <span className="mono">{target.guid}</span> isolation AppProject, and finally the namespace, whether or not
        the Controller has an inventory row for it.
      </p>
      <p>
        Deleting its <strong>Tenant CR</strong> is what deprovisions the tenant: the tenant operator then deletes its Vault path{" "}
        <span className="mono">
          {target.stage}/tenants/{target.guid}
        </span>
        , revokes its object-storage credential and <strong>drops its Mongo databases</strong> — <strong>NOT recoverable</strong>.
      </p>
      <p>
        The tenant&apos;s <strong>object-storage bucket and the objects in it SURVIVE this purge</strong> — they are deliberately kept,
        so the stored data is not deleted here and must be removed separately if that is what you want.
      </p>
      <p>
        Re-running a purge that stopped half-way is safe — every step reaps only what is still there. Steps can still FAIL the run,
        though. The target-cluster attestation refuses before anything is deleted at all, and the Tenant CR delete goes on only when
        the cluster answered that it deleted the CR or that there was none left to delete: any other answer — a cluster credential
        that may not delete a Tenant, an API server that cannot be reached — fails the run at that step, with the inventory row
        untouched. The last refusal is the deliberate one: after the Tenant CR and namespace deletes have fired, the purge re-reads
        the fan-out and <strong>fails rather than record the tenant removed</strong> while its Applications are still standing. A run
        that ends there has already reaped everything it could reach and has left the inventory row exactly as it was, and this run
        stays the way back to the tenant — retry that step once the master ArgoCD reports the fan-out gone, or skip it with a reason
        if you mean to settle the row anyway.
      </p>
      <p>
        What the purge never asks is whether the tenant is still in USE. A tenant the inventory records active or suspended whose
        GitOps pointer still stands is refused before it can even be planned, and refused again when this run is approved — offboard
        is the removal run kind for that one, it keeps the tenant&apos;s data, and a purge may follow it to reap what it leaves standing —
        but a serving tenant with <strong>no inventory row at all</strong> is reachable here, and it would be torn down and
        deprovisioned exactly as described above.{" "}
        <strong>Be certain this guid is the one you mean to destroy.</strong> Confirming only <strong>plans</strong> the run — you
        approve it on the next screen, and nothing changes until then.
      </p>
    </TypeToConfirm>
  );
}
