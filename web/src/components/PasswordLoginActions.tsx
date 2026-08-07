import type { PasswordLoginVerbOffer } from "../passwordLoginState.ts";

// The two password-login verbs on a server's card. Props-only, like TailnetActions: WHICH of them
// this server may be offered is decided by passwordLoginVerbOffer (passwordLoginState.ts, a pure
// module a test can reach), and what each one does is decided by the run it plans — this renders
// buttons.
//
// "Turn off" is the ordinary button and "Turn on" is the danger one, which is the opposite of how a
// pair like this usually reads. It is the right way round here: an adopted server needs no password
// login, so opening the door again is the deliberate act, and the run screen still asks for an
// approval before either happens.

export function PasswordLoginActions(props: {
  offer: PasswordLoginVerbOffer;
  onDisable: () => void;
  onEnable: () => void;
}) {
  const { offer, onDisable, onEnable } = props;
  return (
    <>
      {offer.disable && (
        <button
          type="button"
          className="btn"
          onClick={onDisable}
          title="Stop this host's sshd taking passwords, and destroy the bootstrap password stored for it. The run proves key login works first, and reads the result back out of sshd -T."
        >
          Turn password login off
        </button>
      )}
      {offer.enable && (
        <button
          type="button"
          className="btn btn--danger"
          onClick={onEnable}
          title="Let this host's sshd take passwords again — for a repair. Anyone who can reach its SSH port can then try one."
        >
          Turn password login on
        </button>
      )}
    </>
  );
}
