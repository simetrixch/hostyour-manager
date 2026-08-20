import type { TailnetRunKindOffer } from "../tailnetState.ts";

// The three tailnet repair run kinds on a server's card. Props-only, like ClusterReleaseForm: WHICH of
// them this server may be offered is decided by tailnetRunKindOffer (tailnetState.ts, a pure module a
// test can reach), and what each one does is decided by the run it plans — this renders buttons.
//
// Each run kind reaches the host on its PUBLIC address, which is why the titles say so: an operator who
// presses "Leave tailnet" has to know the host stays reachable afterwards, or the button reads as a
// one-way door.

export function TailnetActions(props: {
  offer: TailnetRunKindOffer;
  onDisconnect: () => void;
  onReconnect: () => void;
  onRejoin: () => void;
}) {
  const { offer, onDisconnect, onReconnect, onRejoin } = props;
  return (
    <>
      {offer.disconnect && (
        <button
          type="button"
          className="btn"
          onClick={onDisconnect}
          title="Take this host off the private network. The run reaches it on its public address, and it keeps answering there afterwards."
        >
          Leave tailnet
        </button>
      )}
      {offer.reconnect && (
        <button
          type="button"
          className="btn"
          onClick={onReconnect}
          title="Put this host back on the private network with the credential it already holds. Nothing is minted and the master is not touched."
        >
          Reconnect tailnet
        </button>
      )}
      {offer.rejoin && (
        <button
          type="button"
          className="btn"
          onClick={onRejoin}
          title="Log this host out and join it again with a credential minted on the master — for a host that holds none, or whose node was deleted at the coordinator."
        >
          Rejoin tailnet
        </button>
      )}
    </>
  );
}
