import type { FormEvent } from "react";
import { STAGE } from "../../../shared/enums.ts";

// The deploy-slave mini-form on an adopted server's card: props only, no fetching of its own, so
// the page keeps the one open form and the one error line. The operator names the slave's FQDN and
// its stage; everything else the run needs it reads off the inventory.
//
// `placeholderName` is only the example inside the domain field — the server's own name, so the
// operator sees the shape `<name>.<domain>` rather than a generic one.

export interface SlaveDeploy {
  domain: string;
  stage: string;
}

export function SlaveDeployForm(props: {
  value: SlaveDeploy;
  placeholderName: string;
  onChange: (next: SlaveDeploy) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const { value, placeholderName, onChange, onSubmit, onCancel } = props;
  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Slave domain</span>
          <input
            value={value.domain}
            onChange={(e) => onChange({ ...value, domain: e.target.value })}
            placeholder={`${placeholderName}.example.com`}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+"
            required
          />
          <span className="field__hint">The slave&apos;s FQDN — becomes its own install branch (one branch per slave).</span>
        </label>
        <label className="field">
          <span className="field__label">Stage</span>
          <select className="input" value={value.stage} onChange={(e) => onChange({ ...value, stage: e.target.value })}>
            {STAGE.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-foot">
        <span className="field__hint">
          Plans the run first — you approve it on the next screen (the machine&apos;s elevation password and the certificate answers are asked for there).
        </span>
        <span className="actions">
          <button type="submit" className="btn btn--primary" disabled={!value.domain.trim()}>
            Plan deployment
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
    </form>
  );
}
