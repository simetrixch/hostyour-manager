import { useEffect, useState } from "react";
import { getConsumerSecretOffer } from "../api.ts";
import type { ConsumerSecretOfferView } from "../../../shared/api-types-onboard.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Plan a change of a standing consumer's secrets (#245, #285).
 *
 *  The keys its operator answers are filled on the Run screen's approve card, each optional. The
 *  keys the Manager mints are chosen HERE, each unticked: the Manager cannot ask Vault which of them
 *  the entry already holds, and minting one it holds rotates it, so nothing is minted that nobody
 *  ticked. The list is the manifest as the plan reads it; no value is read or shown. */
export function ConsumerSecretsDialog(props: { name: string; appId: string; onCancel: () => void; onConfirm: (mint: string[]) => void }) {
  const [offer, setOffer] = useState<ConsumerSecretOfferView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mint, setMint] = useState<string[]>([]);

  const { appId } = props;
  useEffect(() => {
    let alive = true;
    getConsumerSecretOffer(appId)
      .then((r) => { if (alive) setOffer(r); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [appId]);

  const toggle = (key: string, on: boolean): void => setMint((m) => (on ? [...m, key] : m.filter((k) => k !== key)));

  return (
    <ConfirmDialog title={`Change the secrets of "${props.name}"?`} confirmLabel="Plan secrets change" onCancel={props.onCancel} onConfirm={() => props.onConfirm(mint)}>
      <p>
        This <strong>plans</strong> a run and opens it.{" "}
        {offer !== null && (offer.operatorKeys.length > 0
          ? `Its approve card asks for ${offer.operatorKeys.map((k) => k.key).join(", ")}, each optional: what you fill changes.`
          : "The consumer declares no key its operator supplies, so its approve card asks for none.")}
      </p>
      {error && <p className="error">{error}</p>}
      {offer === null && !error && <p className="muted">Reading the manifest…</p>}
      {offer && offer.generateKeys.length > 0 && (
        <>
          <p>
            Tick a key the platform generates to mint it new in the same write. Where the entry already holds it, that
            <strong> rotates</strong> it, and whatever reads the old value breaks until it is updated.
          </p>
          {offer.generateKeys.map((k) => (
            <label className="field field--row" key={k.key}>
              <input type="checkbox" checked={mint.includes(k.key)} onChange={(e) => toggle(k.key, e.target.checked)} />
              <span>
                <strong>{k.key}</strong> <span className="muted">({k.kind})</span>
              </span>
            </label>
          ))}
        </>
      )}
    </ConfirmDialog>
  );
}
