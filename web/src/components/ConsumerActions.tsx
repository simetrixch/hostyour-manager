import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ConsumerView } from "../api.ts";
import type { LifecycleAction } from "./ConsumerLifecycleDialog.tsx";

/** WHAT AN OPERATOR MAY DO TO ONE CONSUMER, and under which status each act is offered. Its own
 *  component because the page owns the state and the hand-off, and this owns the gating: every
 *  button here is either a dialog the page opens or a run the page plans, and which of them a
 *  consumer standing, suspended or offboarded admits is one rule, in one place.
 *
 *  Nothing here acts: every handler is the page's, so a button can only open or plan — and the Run
 *  screen, never this card, is where a run is approved. */
export function ConsumerActions(props: {
  consumer: ConsumerView;
  onLifecycle: (action: LifecycleAction) => void;
  onSetSize: () => void;
  onSetSecrets: () => void;
  onBackup: () => void;
  onMove: () => void;
  onOffboard: () => void;
}): ReactNode {
  const c = props.consumer;
  const standing = c.status !== "offboarded";
  return (
    <div className="actions">
      {c.status === "active" && (
        <button type="button" className="btn" onClick={() => props.onLifecycle("suspend")}>
          Suspend
        </button>
      )}
      {c.status === "suspended" && (
        <button type="button" className="btn btn--primary" onClick={() => props.onLifecycle("resume")}>
          Resume
        </button>
      )}
      {/* Both offered whatever the status: a ceiling is a property of the namespace and a suspended
          consumer still owns one (sizing it before resuming is the sane order), and its secrets stand
          in Vault whether or not a pod reads them. */}
      {standing && (
        <button type="button" className="btn" onClick={props.onSetSize}>
          Set size…
        </button>
      )}
      {/* The onboarding seeds a consumer's secrets ONCE (create-only), so this is the one path that
          changes one afterwards, or supplies a key the manifest gained since (#245). It plans the
          run; the Run screen's approve card is where the values are typed, each with what its
          manifest says it is — filling one changes it, leaving it keeps it. */}
      {standing && (
        <button type="button" className="btn" onClick={props.onSetSecrets}>
          Secrets…
        </button>
      )}
      {/* Only on a RUNNING consumer: a suspended one renders no pod, so there is nothing holding a
          stale value and nothing to roll. */}
      {c.status === "active" && (
        <button type="button" className="btn" onClick={() => props.onLifecycle("restart-workloads")}>
          Restart workloads
        </button>
      )}
      <button type="button" className="btn" onClick={props.onBackup}>
        Back up
      </button>
      {c.status === "active" && (
        <button type="button" className="btn" onClick={props.onMove}>
          Move…
        </button>
      )}
      {standing && (
        <button type="button" className="btn btn--danger" onClick={props.onOffboard}>
          Offboard
        </button>
      )}
      {c.lastRunId && (
        <Link className="btn" to={`/runs/${c.lastRunId}`}>
          Last run →
        </Link>
      )}
    </div>
  );
}
