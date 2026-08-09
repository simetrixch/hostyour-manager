import { Link } from "react-router";
import type { ServerView } from "../../../shared/api-types.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import { tailnetChip } from "../tailnetState.ts";
import { passwordLoginChip, passwordLoginVerbOffer } from "../passwordLoginState.ts";
import { authorizedKeysChip, authorizedKeysVerbOffer } from "../authorizedKeysState.ts";
import { PasswordLoginActions } from "./PasswordLoginActions.tsx";

// Everything a server's card says about the machine ITSELF, as opposed to its position in the slave
// lifecycle: three READINGS beside the status badge — is it on the private network, does its sshd
// take a password, and who is in its authorized_keys — and the verbs that act on the last two.
//
// This block sits OUTSIDE the lifecycle stepper on the page, because the master belongs in it too:
// it is an internet-facing machine with an sshd and an authorized_keys like any other, while the
// lifecycle renders for slaves only.
//
// Each reading is a SNAPSHOT one run took, never a live probe, and each sentence says when. The ages
// are computed at render time and nothing re-renders on a timer, so `now` is passed in rather than
// read here — a test can then pin it.

export function ServerReadings(props: {
  server: ServerView;
  now: number;
  onDisablePasswordLogin: () => void;
  onEnablePasswordLogin: () => void;
  onReadAuthorizedKeys: () => void;
}) {
  const { server, now, onDisablePasswordLogin, onEnablePasswordLogin, onReadAuthorizedKeys } = props;
  const tn = tailnetChip(server, now);
  const pl = passwordLoginChip(server, now);
  const ak = authorizedKeysChip(server, now);
  const plv = passwordLoginVerbOffer(server);
  const akv = authorizedKeysVerbOffer(server);
  const readings = [tn, pl, ak];
  return (
    <>
      <div className="servercard__chips">
        <span className="chip">
          {server.role}
          {isMasterRole(server.role) ? " · this controller" : ""}
        </span>
        {readings.map((r) => (
          <span key={r.label} className={r.className}>
            {r.label}
          </span>
        ))}
        {server.hasKey && <span className="chip chip--ok">key installed</span>}
        {server.hasPassword && <span className="chip chip--ok">password on file</span>}
      </div>
      {readings.map((r) => (
        <p key={r.label} className="servercard__reading">
          {r.detail}
          {r.runId && (
            <>
              {" "}
              <Link to={`/runs/${r.runId}`}>Open the run that read it →</Link>
            </>
          )}
        </p>
      ))}
      {(plv.disable || plv.enable || akv.read) && (
        <div className="actions">
          <PasswordLoginActions offer={plv} onDisable={onDisablePasswordLogin} onEnable={onEnablePasswordLogin} />
          {akv.read && (
            <button
              type="button"
              className="btn"
              onClick={onReadAuthorizedKeys}
              title="Read this host's ~/.ssh/authorized_keys and change nothing. Every key line is fingerprinted and named as this controller's own, an operator key placed under a label, or one placed by nothing here."
            >
              Read authorized keys
            </button>
          )}
        </div>
      )}
    </>
  );
}
