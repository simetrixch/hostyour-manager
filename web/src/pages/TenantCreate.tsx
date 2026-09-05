import { useState, useEffect, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { listTenantTargets, listTenantAppCatalog, createTenant, type TenantTargetView } from "../api.ts";
import { tenantPlacement, TENANT_GUID_PLACEHOLDER } from "../tenantPlacement.ts";

/** Create-tenant wizard — the tenant analogue of
 *  ConsumerOnboard. Unlike a consumer it does NOT point at an external repo: a tenant's charts
 *  always live in the fixed catalog repo, so the operator only declares WHAT to fan out —
 *  a subdomain, an owner, the target cluster and the optional per-app rows. The trio auth/jobs/report
 *  is NOT offered: every tenant has those three members, always. There is NO secret field (v1 seeds no
 *  secrets; charts pull from Vault via ExternalSecret). Submit hands off to the Run screen, where the
 *  T1..T4 fan-out gates stream gate-by-gate and the operator approves the deploy. */
export function TenantCreate() {
  const nav = useNavigate();
  const [form, setForm] = useState({ subdomain: "", owner: "", clusterId: "", adminEmail: "" });
  // The app-type catalog (null = still loading) + the operator's multi-selection. The catalog is the
  // SOLE source of app names — a checkbox can only select a values-<app>.yaml overlay that exists in
  // catalog, which is exactly what the T4 "apps resolved" gate requires (no free text).
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set());
  // Per-app seed tiers — two subsets of selectedApps. An app seeds a tier only when it is
  // BOTH selected AND in that set; deselecting an app drops it from both (now-hidden) sets.
  // referenceApps → SEED_APP_DATA_ON_BOOT (roles/nav — operator apps need it); demoApps → SEED_DEMO_DATA_ON_BOOT.
  const [referenceApps, setReferenceApps] = useState<Set<string>>(new Set());
  const [demoApps, setDemoApps] = useState<Set<string>>(new Set());
  const [seedUsers, setSeedUsers] = useState(false);
  const [targets, setTargets] = useState<TenantTargetView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTenantTargets()
      .then((t) => setTargets(t))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    // Fail-soft: a catalog error is NOT a page error — an empty catalog (unavailable, or genuinely no
    // app-types) just disables the picker with an inline note; onboarding without apps stays valid. The
    // server route is itself fail-soft, so this catch only covers a transport/parse failure.
    listTenantAppCatalog()
      .then((apps) => setCatalog(apps))
      .catch(() => setCatalog([]));
  }, []);

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleApp = (name: string) => (e: ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setSelectedApps((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
    // Deselecting an app clears BOTH seed tiers so a hidden checkbox never leaks into the payload.
    if (!checked) {
      const drop = (prev: Set<string>): Set<string> => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      };
      setReferenceApps(drop);
      setDemoApps(drop);
    }
  };
  // One toggler for either seed-tier set (reference / demo), by the app name.
  const toggleTier = (setter: typeof setReferenceApps, name: string) => (e: ChangeEvent<HTMLInputElement>) =>
    setter((prev) => {
      const next = new Set(prev);
      if (e.target.checked) next.add(name);
      else next.delete(name);
      return next;
    });

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { runId } = await createTenant({
        clusterId: form.clusterId,
        subdomain: form.subdomain.trim(),
        owner: form.owner.trim(),
        // the checked catalog app-types + their two per-app seed tiers (buildCreateTenantBody trims + de-dupes)
        apps: [...selectedApps].map((name) => ({ name, seedReference: referenceApps.has(name), seedDemo: demoApps.has(name) })),
        seedUsers,
        adminEmail: form.adminEmail.trim(), // empty ⇒ buildCreateTenantBody omits it (no first-admin invite)
      });
      nav(`/runs/${runId}`); // the Run screen streams the live T1..T4 gate report + the approve card
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const noTargets = targets !== null && targets.length === 0;
  // Where the tenant lands, derived from the chosen cluster alone (tenantPlacement.ts, which carries the
  // WHY: one cluster IS one stage, so this is a read-out and not a field). Null
  // until a cluster is chosen, and it changes NOTHING about what is submitted.
  const placement = tenantPlacement(form.clusterId, targets, [...selectedApps]);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <span className="page__eyebrow">Tenant · step 1 of 2</span>
          <h2 className="page__title">Create a tenant</h2>
        </div>
      </header>

      <p className="callout">
        A tenant fans one registration out to one self-contained member per service — auth, jobs and report always, plus
        one per app you declare — each with its own namespace <code>&lt;guid&gt;-&lt;member&gt;</code> and its own
        AppProject, all rendered from the fixed catalog repo. The Manager renders and validates the entire
        fan-out (T1..T4) before anything is deployed; you approve on the next screen.
      </p>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}
      {noTargets && (
        <p role="alert" className="alert alert--warn">
          No active clusters to create a tenant on yet — deploy a slave (or bring the master up) first.
        </p>
      )}

      <form className="card wizard-card" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Subdomain</span>
            <input
              value={form.subdomain}
              onChange={set("subdomain")}
              placeholder="acme.dev"
              pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*"
              required
            />
            <span className="field__hint">A public DNS-subdomain label (zero PII) — the tenant's public address.</span>
          </label>
          <label className="field">
            <span className="field__label">Target cluster</span>
            <select value={form.clusterId} onChange={set("clusterId")} required>
              <option value="" disabled>
                {targets === null ? "Loading…" : "Choose a cluster"}
              </option>
              {(targets ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.domain} · {t.stage}
                </option>
              ))}
            </select>
            <span className="field__hint">The stage and domain are taken from the cluster — never sent from here.</span>
          </label>

          {/* The placement read-out that makes the line above checkable instead of merely stated: the
              stage a cluster carries, and the two identities it decides — the GitOps pointer directory in
              catalog and the member namespaces on the cluster. It is a READ-OUT, never an input: there is no
              stage field to build, because one cluster IS exactly one stage (the reasoning, and the three
              places that enforce it, live in tenantPlacement.ts). The guid is the one thing not yet known
              — the plan mints it — so it shows as the <guid> placeholder with a line saying so, rather
              than an example an operator could copy somewhere and act on. */}
          {placement && (
            <div className="field">
              <span className="field__label">Where this tenant will land</span>
              <span className="field__hint">
                Stage <code>{placement.stage}</code> on <code>{placement.domain}</code> — derived from the cluster, not
                selectable: a cluster is installed as exactly one stage and every tenant run re-attests that against the
                cluster itself.
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
            <span className="field__label">
              Admin email <em className="field__opt">optional</em>
            </span>
            <input type="email" value={form.adminEmail} onChange={set("adminEmail")} placeholder="admin@acme.test" />
            <span className="field__hint">
              Once the tenant is live, its example-auth is invited to bootstrap this first administrator. The activation
              link is shown once on the run screen and stored nowhere. Leave blank to invite an admin later.
            </span>
          </label>
        </div>

        <div className="field">
          <span className="field__label">
            Apps <em className="field__opt">optional</em>
          </span>
          <span className="field__hint">
            Each app becomes a member of its own: namespace <code>&lt;guid&gt;-&lt;name&gt;</code> and Application{" "}
            <code>&lt;guid&gt;-&lt;name&gt;-&lt;stage&gt;</code>, rendered from its{" "}
            <code>charts/example-engine/values-&lt;name&gt;.yaml</code> overlay in catalog. Pick from the catalog
            below — auth/jobs/report are reserved for the mandatory trio.
          </span>
          {catalog === null ? (
            <span className="field__hint">Loading the app catalog…</span>
          ) : catalog.length === 0 ? (
            <span className="field__hint" role="note">
              App catalog unavailable — none selectable. You can still create the tenant with no apps and add them later.
            </span>
          ) : (
            catalog.map((name) => (
              <div key={name}>
                <label className="checkbox-field">
                  <input type="checkbox" checked={selectedApps.has(name)} onChange={toggleApp(name)} />
                  <span className="field__label">{name}</span>
                </label>
                {selectedApps.has(name) && (
                  <>
                    <label className="checkbox-field checkbox-field--nested">
                      <input type="checkbox" checked={referenceApps.has(name)} onChange={toggleTier(setReferenceApps, name)} />
                      <span className="field__label">Reference data (roles, navigation — operator apps like buildproject/erp need this to show anything)</span>
                    </label>
                    <label className="checkbox-field checkbox-field--nested">
                      <input type="checkbox" checked={demoApps.has(name)} onChange={toggleTier(setDemoApps, name)} />
                      <span className="field__label">Demo data (sample records, e.g. the web home page)</span>
                    </label>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className="field">
          <span className="field__label">Identity provider</span>
          <label className="checkbox-field">
            <input type="checkbox" checked={seedUsers} onChange={(e) => setSeedUsers(e.target.checked)} />
            <span className="field__label">Seed users (bootstrap the tenant's IdP with initial accounts)</span>
          </label>
        </div>

        <div className="form-foot">
          <button type="submit" className="btn btn--primary" disabled={busy || noTargets || !form.subdomain || !form.clusterId || !form.owner}>
            {busy ? "Validating…" : "Validate & plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
