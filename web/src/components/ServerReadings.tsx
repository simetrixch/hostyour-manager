import { Link } from "react-router";
import type { ServerView } from "../../../shared/api-types.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import { tailnetChip } from "../tailnetState.ts";
import { passwordLoginChip, passwordLoginRunKindOffer } from "../passwordLoginState.ts";
import { authorizedKeysChip, authorizedKeysRunKindOffer } from "../authorizedKeysState.ts";
import { releaseChip } from "../clusterRelease.ts";
import { PasswordLoginActions } from "./PasswordLoginActions.tsx";

// Everything a server's card says about the machine ITSELF, as opposed to its position in the slave
// lifecycle: three READINGS beside the status badge — is it on the private network, does its sshd
// take a password, and who is in its authorized_keys — the run kinds that act on the last two, and the
// platform RELEASE the cluster on this machine stands on.
//
// The release is not a fourth reading and is deliberately not worded like one. The three readings are
// snapshots a run took off the host and each says when; the release is what the cluster map declares,
// so it carries no age and names no run — it stands until a release run rewrites it.
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
  const plOffer = passwordLoginRunKindOffer(server);
  const akOffer = authorizedKeysRunKindOffer(server);
  // The release is NOT one of the readings: those are snapshots a run took off the machine, this is
  // what the cluster map declares. It is null exactly where the machine is no cluster, which is the
  // one row that has no release question at all.
  const rel = releaseChip(server.release);
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
        {rel && <span className={rel.className}>{rel.label}</span>}
        {server.hasKey && <span className="chip chip--ok">key installed</span>}
        {server.hasPassword && <span className="chip chip--ok">password on file</span>}
      </div>
      {rel && <p className="servercard__reading">{rel.detail}</p>}
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
      {(plOffer.disable || plOffer.enable || akOffer.read) && (
        <div className="actions">
          <PasswordLoginActions offer={plOffer} onDisable={onDisablePasswordLogin} onEnable={onEnablePasswordLogin} />
          {akOffer.read && (
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
