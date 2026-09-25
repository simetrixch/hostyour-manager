import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that approves, changes or clears the image tag one app of the tenant runs
 *  for one build, above the stage pin every tenant shares. Confirming only PLANS the run: it checks
 *  that the app's charts pin the build and that the registry holds the tag, records the approval, and
 *  waits until the app's member runs it. */
export function SetApprovedTagAction(props: {
  subdomain: string;
  approvedTags: Record<string, Record<string, string>>;
  busy: boolean;
  onSet: (app: string, build: string, tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState("");
  const [build, setBuild] = useState("");
  const [tag, setTag] = useState("");
  const approvals = Object.entries(props.approvedTags).flatMap(([a, builds]) => Object.entries(builds).map(([b, t]) => ({ app: a, build: b, tag: t })));
  const pick = (a: string, b: string, t: string) => { setApp(a); setBuild(b); setTag(t); };
  const value = { app: app.trim(), build: build.trim(), tag: tag.trim() };
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => { pick("", "", ""); setOpen(true); }}>
        Approved versions…
      </button>
      {open && (
        <ConfirmDialog
          title={`Approved versions of tenant "${props.subdomain}"`}
          confirmLabel={value.tag === "" ? "Follow the stage pin" : `Run ${value.tag}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value.app, value.build, value.tag); }}
        >
          {approvals.length === 0 ? <p>Every app follows its stage pin.</p> : (
            <ul>
              {approvals.map((a) => (
                <li key={`${a.app}/${a.build}`}>
                  <button type="button" className="btn" onClick={() => pick(a.app, a.build, a.tag)}>{a.app} / {a.build}: {a.tag}</button>
                </li>
              ))}
            </ul>
          )}
          <p><label>App <input className="input" value={app} onChange={(e) => setApp(e.target.value)} placeholder="erp" /></label></p>
          <p><label>Build <input className="input" value={build} onChange={(e) => setBuild(e.target.value)} placeholder="digita-app" /></label></p>
          <p>
            <label>
              Tag (empty follows the stage pin again){" "}
              <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="0.1.12-stable-20260925120000-abc1234" />
            </label>
          </p>
          <p>
            The app then runs this build at the tag for this tenant alone; every other tenant keeps the stage pin. The
            build must be one the app&apos;s charts pin at this stage, and the registry must hold the image at the tag.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
