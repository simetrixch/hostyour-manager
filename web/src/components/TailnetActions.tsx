import type { TailnetRunKindOffer } from "../tailnetState.ts";

// The three tailnet repair run kinds on a server's card, and the reading beside them. Props-only,
// like SlaveDeployForm: WHICH of them this server may be offered is decided by tailnetRunKindOffer
// (tailnetState.ts, a pure module a test can reach), and what each one does is decided by the run it
// plans — this renders buttons.
//
// THE READING COMES FIRST because it is the cheapest thing on the card: it changes nothing, and an
// operator who only wants to know whether the host is on the network should not have to read past two
// repairs to find that out. Before it existed the two repairs beside it were also the only refresh
// there was, so they stood lit on a host that was demonstrably a member.
//
// Each run kind reaches the host on its PUBLIC address, which is why the titles say so: an operator who
// presses "Leave tailnet" has to know the host stays reachable afterwards, or the button reads as a
// one-way door.
//
// THE TWO THAT PUT A HOST BACK NAME THE CREDENTIAL, because that is the whole difference between them
// and a title cannot carry it: a title shows on hover, and the operator deciding between these two is
// as often on a phone, where there is none. "Reconnect" and "Rejoin" are one letter apart and name the
// same act; what separates them is that one keeps the key the host holds and the other mints a fresh
// one — and only the second logs the host out and restarts the cluster on the way.

export function TailnetActions(props: {
  offer: TailnetRunKindOffer;
  onRead: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onRejoin: () => void;
}) {
  const { offer, onRead, onDisconnect, onReconnect, onRejoin } = props;
  return (
    <>
      {offer.read && (
        <button
          type="button"
          className="btn"
          onClick={onRead}
          title="Ask this host's tailnet client what it is doing and date the answer. Nothing on the host is changed: no program is run, no credential is minted and no certificate is touched."
        >
          Read the tailnet membership
        </button>
      )}
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
          title="Put this host back on the private network. The run reaches it on its public address; nothing is minted and the master is not touched."
        >
          Reconnect with the stored key
        </button>
      )}
      {offer.rejoin && (
        <button
          type="button"
          className="btn"
          onClick={onRejoin}
          title="For a host that holds no credential, or whose node was deleted at the coordinator. It is logged out first, so it is on no network for the length of the run, and the fresh address makes the cluster re-issue its serving certificate and restart."
        >
          Rejoin with a new key
        </button>
      )}
    </>
  );
}
