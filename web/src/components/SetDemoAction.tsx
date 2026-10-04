import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export function SetDemoAction(props: { busy: boolean; onSet: (demo: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [demo, setDemo] = useState(true);
  return <>
    <button type="button" className="btn" disabled={props.busy} onClick={() => setOpen(true)}>Demo mode…</button>
    {open && <ConfirmDialog title="Set the tenant's demo mode" confirmLabel={`Set demo ${demo ? "on" : "off"}`} onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); props.onSet(demo); }}>
      <label className="checkbox-field"><input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} /><span className="field__label">Demo tenant</span></label>
      <p>This setting applies to every member. When enabled, the product offers demo login and its demo data reset behavior. Review and approve the run before it takes effect.</p>
    </ConfirmDialog>}
  </>;
}
