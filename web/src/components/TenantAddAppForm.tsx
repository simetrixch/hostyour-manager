import { useState, type ChangeEvent, type FormEvent } from "react";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import { appSelectionsToRequest } from "../../../shared/app-selections.ts";
import { undeployedApps } from "../tenantAppRows.ts";
import { OwnerCredentialStep } from "./OwnerCredentialStep.tsx";

/** What the control hands the page on submit: one apps[] entry in the request's shape
 *  (shared/app-selections.ts appSelectionsToRequest). */
export type TenantAddAppChoice = ReturnType<typeof appSelectionsToRequest>;

interface Props {
  /** The tenant's own catalog, or null while it loads. */
  catalog: TenantAppCatalogView | null;
  busy: boolean;
  onAdd: (choice: TenantAddAppChoice) => void;
  /** Records the owner's packages reader (the token measured and sealed server-side) and reloads
   *  the catalog, so the step below disappears once it is recorded. */
  onRecordPackagesReader: (owner: string, token: string) => Promise<void>;
}

/** The add-app control of the tenant page: the apps of the tenant's OWN bundle that are not deployed
 *  yet, one picked at a time with the selections its apps.yaml entry declares — the same offer the
 *  create-tenant wizard renders from the template's catalog, here from the tenant's. No free text:
 *  what stands in the tenant's repository is what tenant-add-app accepts (gate T4 judges against the
 *  same apps.yaml), so a name typed past the catalog would only be refused at the plan. The route's
 *  `error` and `reason` are shown as they are: an empty offer never reads as "nothing to add". */
export function TenantAddAppForm({ catalog, busy, onAdd, onRecordPackagesReader }: Props) {
  const [app, setApp] = useState("");
  const [chosen, setChosen] = useState<Record<string, boolean>>({});

  if (catalog === null) return <span className="field__hint">Loading the tenant&apos;s catalog…</span>;
  if (catalog.error)
    return (
      <p role="alert" className="alert alert--danger">
        The tenant&apos;s catalog could not be read: {catalog.error}
      </p>
    );
  if (catalog.reason)
    return (
      <span className="field__hint" role="note">
        {catalog.reason}
      </span>
    );
  const offered = undeployedApps(catalog.apps);
  if (offered.length === 0)
    return (
      <span className="field__hint" role="note">
        Every app of the bundle is deployed. A new folder reaches the bundle through the tenant-apps-repo run.
      </span>
    );
  const entry = offered.find((a) => a.name === app) ?? null;
  // THE FIRST TENANT ONBOARDING ASKS FOR THE PACKAGES READER, NONE AFTER (#233): the step stands
  // only while the template routes a scope to GitHub Packages and the owner records no reader.
  const reader = catalog.packagesReader;
  const readerMissing = reader !== undefined && reader.recorded === null;

  // Picking an app starts every selection at the default its entry declares, exactly as the wizard does.
  const choose = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = offered.find((a) => a.name === e.target.value);
    setApp(next?.name ?? "");
    setChosen(next ? Object.fromEntries(Object.entries(next.selections).map(([k, v]) => [k, v.default])) : {});
  };
  const toggle = (selection: string) => (e: ChangeEvent<HTMLInputElement>) => setChosen((prev) => ({ ...prev, [selection]: e.target.checked }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (entry) onAdd(appSelectionsToRequest(entry.name, chosen));
  };

  return (
    <>
    {readerMissing && <OwnerCredentialStep owner={reader.owner} need={{ kind: "packages-reader", scopes: reader.scopes }} onRecord={onRecordPackagesReader} subject="The bundle" />}
    <form className="field" onSubmit={submit}>
      <label className="field__label" htmlFor="tenant-add-app">
        Add app
      </label>
      <span className="field__hint">The apps of this tenant&apos;s own bundle that are not deployed yet, with the selections each one offers.</span>
      <select id="tenant-add-app" className="input" value={app} onChange={choose} disabled={busy}>
        <option value="" disabled>
          Choose an app
        </option>
        {offered.map((a) => (
          <option key={a.name} value={a.name}>
            {a.title} ({a.name})
          </option>
        ))}
      </select>
      {entry?.description && <span className="field__hint">{entry.description}</span>}
      {entry &&
        Object.entries(entry.selections).map(([selection, { title }]) => (
          <label key={selection} className="checkbox-field checkbox-field--nested">
            <input type="checkbox" checked={chosen[selection] === true} onChange={toggle(selection)} disabled={busy} />
            <span className="field__label">{title}</span>
          </label>
        ))}
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy || entry === null || readerMissing}>
          Add app
        </button>
      </div>
    </form>
    </>
  );
}
