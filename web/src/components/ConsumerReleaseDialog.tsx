import { useEffect, useState } from "react";
import { getConsumerReleaseOffer } from "../api.ts";
import type { ConsumerReleaseOfferView } from "../../../shared/api-types-onboard.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Plan putting a release of a standing app on its stage again (#299) — how it goes back to an
 *  earlier release, or forward to a later one that stands. The list is the repository's releases as
 *  the plan reads them, newest first; the one that runs is marked, and so is every one minted before
 *  it, which makes choosing it a downgrade. Nothing is built: the release that stands is put back. */
export function ConsumerReleaseDialog(props: { name: string; appId: string; onCancel: () => void; onConfirm: (tag: string) => void }) {
  const [offer, setOffer] = useState<ConsumerReleaseOfferView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState<string>("");

  const { appId } = props;
  useEffect(() => {
    let alive = true;
    getConsumerReleaseOffer(appId)
      .then((r) => { if (alive) setOffer(r); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [appId]);

  const chosen = offer?.releases.find((r) => r.tag === tag);
  return (
    <ConfirmDialog
      title={`Put a release of "${props.name}" on its stage?`}
      confirmLabel={chosen?.older ? "Plan downgrade" : "Plan release"}
      onCancel={props.onCancel}
      onConfirm={() => { if (tag) props.onConfirm(tag); }}
    >
      <p>
        This <strong>plans</strong> a run and opens it. The release that stands is put on{" "}
        {offer ? <strong>{offer.stage}</strong> : "its stage"} again, nothing is built, and the run waits until it is delivered.{" "}
        {offer && (offer.running ? <>It runs <strong>{offer.running}</strong> now.</> : "No release of its repository runs there now.")}
      </p>
      {error && <p className="error">{error}</p>}
      {offer === null && !error && <p className="muted">Reading the repository's releases…</p>}
      {offer && offer.releases.length === 0 && <p className="muted">Its repository carries no release.</p>}
      {offer && offer.releases.map((r) => (
        <label className="field field--row" key={r.tag}>
          <input type="radio" name="release" value={r.tag} disabled={r.tag === offer.running} checked={tag === r.tag} onChange={() => setTag(r.tag)} />
          <span>
            <strong>{r.tag}</strong>
            {r.tag === offer.running && <span className="muted"> — runs now</span>}
            {r.older && <span className="muted"> — older: a downgrade</span>}
          </span>
        </label>
      ))}
    </ConfirmDialog>
  );
}
