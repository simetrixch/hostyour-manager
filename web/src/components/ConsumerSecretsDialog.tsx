import { useEffect, useState } from "react";
import { getConsumerSecretOffer } from "../api.ts";
import type { ConsumerSecretOfferView } from "../../../shared/api-types-onboard.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { changesSecrets, secretStateLabel, toggleMint } from "../consumerSecrets.ts";

/** The Secrets dialog of a standing consumer: every key its manifest declares, one row each, with what
 *  the Manager's book knows of its value and the one thing that can be done with it. A key the
 *  operator supplies takes its new value here; a key the Manager mints can be ticked to mint it new.
 *  The values go on to the run's approve form in memory only (heldSecrets.ts), and approving there
 *  writes them. */
export function ConsumerSecretsDialog(props: { name: string; appId: string; onCancel: () => void; onConfirm: (mint: string[], values: Record<string, string>) => void }) {
  const [offer, setOffer] = useState<ConsumerSecretOfferView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mint, setMint] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});

  const { appId } = props;
  useEffect(() => {
    let alive = true;
    getConsumerSecretOffer(appId)
      .then((r) => { if (alive) setOffer(r); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [appId]);

  return (
    <ConfirmDialog
      title={`Secrets of "${props.name}"`}
      confirmLabel="Plan the change"
      confirmDisabled={!changesSecrets(values, mint)}
      onCancel={props.onCancel}
      onConfirm={() => props.onConfirm(mint, values)}
    >
      {error && <p className="error">{error}</p>}
      {offer === null && !error && <p className="muted">Reading the manifest…</p>}
      {offer && offer.keys.length === 0 && <p>Its manifest declares no secret.</p>}
      {offer && offer.keys.length > 0 && (
        <>
          <div className="table__wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {offer.keys.map((k) => (
                <tr key={k.key}>
                  <td>
                    <strong className="mono">{k.key}</strong>
                    {k.description && <div className="muted">{k.description}</div>}
                  </td>
                  <td>{secretStateLabel(k)}</td>
                  <td>
                    {k.fromStore !== undefined ? (
                      <span className="muted">from the installation&apos;s store ({k.fromStore})</span>
                    ) : k.kind === undefined ? (
                      <input
                        type="password"
                        className="input"
                        autoComplete="off"
                        aria-label={`New value of ${k.key}`}
                        placeholder="new value (empty keeps it)"
                        value={values[k.key] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
                      />
                    ) : (
                      <label className="field field--row" title={k.mintRefused}>
                        <input type="checkbox" disabled={k.mintRefused !== undefined} checked={mint.includes(k.key)} onChange={(e) => setMint((m) => toggleMint(offer.keys, m, k.key, e.target.checked))} />
                        <span>mint new ({k.kind}){k.mintRefused ? " — not here" : ""}</span>
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {mint.length > 0 && (
            <p className="alert alert--warn">
              Minting new replaces {mint.join(", ")}: whatever reads the old value breaks until it is updated.
            </p>
          )}
          <p className="muted">
            Unknown means the consumer was onboarded before the Manager kept a book of the keys it writes. The values go to the next
            screen in this page&rsquo;s memory only; it shows the plan, and approving there writes them.
          </p>
        </>
      )}
    </ConfirmDialog>
  );
}
