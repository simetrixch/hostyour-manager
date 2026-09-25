import { useState, useEffect, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { Stage } from "../../../shared/enums.ts";
import { HOST_LABEL_RE } from "../../../shared/unit-host.ts";
import { DEFAULT_UNIT_SIZE, UNIT_SIZE, type UnitSize } from "../../../shared/unit-size.ts";
import { listTenantTargets, createTenant, type TenantTargetView } from "../api.ts";
import { tenantPlacement, TENANT_GUID_PLACEHOLDER } from "../tenantPlacement.ts";

/** Onboard-tenant wizard — the tenant analogue of
 *  ConsumerOnboard. Unlike a consumer it does NOT point at an external repo: a tenant's charts
 *  always live in the fixed catalog repo, so the operator only declares WHAT to fan out —
 *  a subdomain, an owner, the target cluster (any active one, whose stage the tenant takes), the
 *  size and the first administrator's mailbox. THE PLATFORM ALONE (hostyour-manager#211): the
 *  standing members auth, jobs and report, always those three and no app. Apps are added
 *  afterwards from the tenant's page, where the first one creates the tenant's own repository
 *  `<org>/<bundle>-<subdomain>` from the catalog's template, copies the app in, builds and deploys it
 *  (tenant-apps-repo, tenant-add-app). There is NO secret field (v1 seeds no secrets; charts pull
 *  from Vault via ExternalSecret) and no user seed: the first administrator comes by invitation.
 *  Submit hands off to the Run screen, where the T1..T4 fan-out gates stream gate-by-gate and the
 *  operator approves. */
export function TenantCreate() {
  const nav = useNavigate();
  const [form, setForm] = useState({ subdomain: "", owner: "", stage: "", clusterId: "", adminEmail: "", size: DEFAULT_UNIT_SIZE as string });
  const [targets, setTargets] = useState<TenantTargetView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTenantTargets()
      .then((t) => setTargets(t))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // The stage is the cluster's and no other is offered: the tenant's Vault policies and its
  // tenant-eso role are bound to the platform's stage, and the server refuses a mismatch
  // (create-tenant.run.ts resolveTenantCluster). Sent with the body so that refusal can be made.
  const chooseCluster = (e: ChangeEvent<HTMLSelectElement>) => {
    const clusterId = e.target.value;
    setForm((f) => ({ ...f, clusterId, stage: (targets ?? []).find((t) => t.id === clusterId)?.stage ?? "" }));
  };
  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { runId } = await createTenant({
        clusterId: form.clusterId,
        stage: form.stage as Stage,
        subdomain: form.subdomain.trim(),
        owner: form.owner.trim(),
        size: form.size as UnitSize,
        apps: [], // the platform alone; apps are added from the tenant's page (#211)
        seedUsers: false,
        adminEmail: form.adminEmail.trim(), // empty ⇒ buildCreateTenantBody omits it (no first-admin invite)
      });
      nav(`/runs/${runId}`); // the Run screen streams the live T1..T4 gate report + the approve card
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const activeTargets = (targets ?? []).filter((t) => t.status === "active");
  const noTargets = targets !== null && activeTargets.length === 0;
  // Where the tenant lands, derived from the chosen stage and cluster (tenantPlacement.ts). Null until
  // both are chosen, and it changes NOTHING about what is submitted.
  const placement = tenantPlacement(form.stage, form.clusterId, targets);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <span className="page__eyebrow">Tenant · step 1 of 2</span>
          <h2 className="page__title">Onboard tenant</h2>
        </div>
      </header>

      <p className="callout">
        A tenant fans one registration out to one self-contained member per service — auth, jobs and report, the
        platform every tenant has — each with its own namespace <code>&lt;guid&gt;-&lt;member&gt;-&lt;stage&gt;</code> and its
        own AppProject, all rendered from the fixed catalog repo. Apps are added afterwards from the tenant&apos;s page: the
        first one creates the tenant&apos;s own repository <code>&lt;subdomain&gt;-apps</code> from the catalog and builds it.
        The Manager renders and validates the entire fan-out (T1..T4) before anything is deployed; you approve on the next
        screen.
      </p>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}
      {noTargets && (
        <p role="alert" className="alert alert--warn">
          No active clusters to onboard a tenant on yet — deploy a slave (or bring the master up) first.
        </p>
      )}

      <form className="card wizard-card" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Subdomain</span>
            <input
              value={form.subdomain}
              onChange={set("subdomain")}
              placeholder="acme"
              pattern={HOST_LABEL_RE.source}
              required
            />
            <span className="field__hint">
              One DNS label (zero PII): the tenant&apos;s zone is <code>&lt;subdomain&gt;.&lt;stage apex&gt;</code> and every member
              stands one level below it. Never a stage word — those are the zones themselves.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Target cluster</span>
            <select value={form.clusterId} onChange={chooseCluster} required>
              <option value="" disabled>
                {targets === null ? "Loading…" : "Choose a cluster"}
              </option>
              {activeTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.domain} ({t.stage})
                </option>
              ))}
            </select>
            <span className="field__hint">
              Any active cluster; the domain is taken from it. The tenant&apos;s stage is the cluster&apos;s
              {form.stage ? <> — <code>{form.stage}</code></> : ""}: every member namespace, the registration file and the Vault path{" "}
              <code>&lt;stage&gt;/tenants/&lt;guid&gt;</code> carry it, and the Vault policies that admit that path are bound to the
              platform&apos;s stage, so no other stage is offered.
            </span>
          </label>

          {/* The placement read-out that makes the two fields above checkable instead of merely stated:
              the two identities they decide — the GitOps registration file in catalog and the member
              namespaces on the cluster. The guid is the one thing not yet known — the plan mints it — so
              it shows as the <guid> placeholder with a line saying so, rather than an example an operator
              could copy somewhere and act on. */}
          {placement && (
            <div className="field">
              <span className="field__label">Where this tenant will land</span>
              <span className="field__hint">
                Stage <code>{placement.stage}</code> on <code>{placement.domain}</code>.
              </span>
              <span className="field__hint">
                GitOps registration <code>{placement.registrationPath}</code> in catalog ·{" "}
                {placement.namespaces.length} namespaces on the cluster, one per member:{" "}
                <code>{placement.namespaces.join(", ")}</code>. Each is also the name of that member&apos;s AppProject.
              </span>
              <span className="field__hint" role="note">
                <code>{TENANT_GUID_PLACEHOLDER}</code> is a placeholder, not an identifier: the tenant's guid is assigned
                by the plan when you press Validate &amp; plan below. It is the BRACKET every member is named from —
                there is no namespace called just the guid.
              </span>
            </div>
          )}

          <label className="field">
            <span className="field__label">Owner</span>
            <input value={form.owner} onChange={set("owner")} placeholder="team-acme" required />
          </label>
          <label className="field">
            <span className="field__label">Size</span>
            <select value={form.size} onChange={set("size")} required>
              {UNIT_SIZE.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="field__hint">
              The ceiling every member namespace of this tenant gets. What each size means on this installation is the
              size table; the registration carries the figures as they stand when the plan is approved.
            </span>
          </label>
          <label className="field">
            <span className="field__label">
              Admin email <em className="field__opt">optional</em>
            </span>
            <input type="email" value={form.adminEmail} onChange={set("adminEmail")} placeholder="admin@acme.test" />
            <span className="field__hint">
              Once the tenant is live, its identity provider is invited to bootstrap this first administrator. The activation
              link is shown once on the run screen and stored nowhere. Leave blank to invite an admin later.
            </span>
          </label>
        </div>

        <div className="form-foot">
          <button type="submit" className="btn btn--primary" disabled={busy || noTargets || !form.subdomain || !form.stage || !form.clusterId || !form.owner}>
            {busy ? "Validating…" : "Validate & plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
