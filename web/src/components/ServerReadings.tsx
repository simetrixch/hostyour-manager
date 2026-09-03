import { Link } from "react-router";
import type { ServerView } from "../../../shared/api-types.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import { tailnetChip } from "../tailnetState.ts";
import { passwordLoginChip, passwordLoginRunKindOffer } from "../passwordLoginState.ts";
import { authorizedKeysChip, authorizedKeysRunKindOffer } from "../authorizedKeysState.ts";
import { PasswordLoginActions } from "./PasswordLoginActions.tsx";
import { MachineIdentity } from "./MachineIdentity.tsx";

// Everything a server's card says about the machine ITSELF, as opposed to its position in the slave
// lifecycle: three READINGS beside the status badge — is it on the private network, does its sshd
// take a password, and who is in its authorized_keys — the run kinds that act on the last two, and
// beneath them the identity this manager has recorded for the machine.
//
// This block sits OUTSIDE the lifecycle stepper on the page, because the master belongs in it too:
// it is an internet-facing machine with an sshd and an authorized_keys like any other, while the
// lifecycle renders for slaves only.
//
// Each reading is a SNAPSHOT one run took, never a live probe, and each sentence says when. The ages
// are computed at render time and nothing re-renders on a timer, so `now` is passed in rather than
// read here — a test can then pin it. The identity below is not one of them: it is what this manager
// holds the machine to, and it changes only when a person says the machine was rebuilt.

export function ServerReadings(props: {
  server: ServerView;
  now: number;
  onDisablePasswordLogin: () => void;
  onEnablePasswordLogin: () => void;
  onReadAuthorizedKeys: () => void;
  onRestateMachineIdentity: (fingerprint: string) => Promise<boolean>;
}) {
  const { server, now, onDisablePasswordLogin, onEnablePasswordLogin, onReadAuthorizedKeys, onRestateMachineIdentity } = props;
  const tn = tailnetChip(server, now);
  const pl = passwordLoginChip(server, now);
  const ak = authorizedKeysChip(server, now);
  const plOffer = passwordLoginRunKindOffer(server);
  const akOffer = authorizedKeysRunKindOffer(server);
  const readings = [tn, pl, ak];
  return (
    <>
      <div className="servercard__chips">
        <span className="chip">
          {server.role}
          {isMasterRole(server.role) ? " · this manager" : ""}
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
      <MachineIdentity server={server} onRestate={onRestateMachineIdentity} />
      {(plOffer.disable || plOffer.enable || akOffer.read) && (
        <div className="actions">
          <PasswordLoginActions offer={plOffer} onDisable={onDisablePasswordLogin} onEnable={onEnablePasswordLogin} />
          {akOffer.read && (
            <button
              type="button"
              className="btn"
              onClick={onReadAuthorizedKeys}
              title="Read this host's ~/.ssh/authorized_keys and change nothing. Every key line is fingerprinted and named as this manager's own, an operator key placed under a label, or one placed by nothing here."
            >
              Read authorized keys
            </button>
          )}
        </div>
      )}
    </>
  );
}
