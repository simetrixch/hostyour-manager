import type { FormEvent } from "react";
import { RELEASE_CHANNEL } from "../../../shared/release.ts";

// The cluster-release mini-form on a live server's card. The operator names TWO things and nothing
// else: the version and the channel. Which cluster the release lands on is the server's own active
// cluster row, the stage the channel is checked against is that cluster's marking, and the timestamp
// half of the tag is stamped by the run — a field for any of them here would be a second place to
// state a fact the platform already states, and a second place is a place to disagree.

export interface ClusterRelease {
  version: string;
  channel: string;
}

export function ClusterReleaseForm(props: {
  value: ClusterRelease;
  onChange: (next: ClusterRelease) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const { value, onChange, onSubmit, onCancel } = props;
  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Platform version</span>
          <input
            value={value.version}
            onChange={(e) => onChange({ ...value, version: e.target.value })}
            placeholder="1.0.0"
            pattern="(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
            required
          />
          <span className="field__hint">x.y.z — the run stamps the timestamp and mints the tag; you never name a whole tag.</span>
        </label>
        <label className="field">
          <span className="field__label">Channel</span>
          <select className="input" value={value.channel} onChange={(e) => onChange({ ...value, channel: e.target.value })}>
            {RELEASE_CHANNEL.map((ch) => (
              <option key={ch} value={ch}>
                {ch}
              </option>
            ))}
          </select>
          <span className="field__hint">
            Which stages a channel may reach is the channel table&apos;s answer, not this form&apos;s: a channel that may
            not reach this cluster&apos;s stage is refused before anything is pinned.
          </span>
        </label>
      </div>
      <div className="form-foot">
        <span className="field__hint">
          Pins the cluster map to the release, re-runs the installer over SSH, then waits for ArgoCD — always all three.
          Expect a brief kube-apiserver blip while kubelite restarts.
        </span>
        <span className="actions">
          <button type="submit" className="btn btn--primary" disabled={!value.version.trim()}>
            Plan release
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
    </form>
  );
}
