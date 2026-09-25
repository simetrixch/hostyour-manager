import type { TailnetRunKindOffer } from "../tailnetState.ts";
import { TailnetActions } from "./TailnetActions.tsx";

// What the card of a machine carrying the MASTER part says and offers.
//
// It is its own row and not the block beside it, because that block is the SLAVE lifecycle: its
// stages and every sentence in LIFECYCLE (pages/Servers.tsx) are written about a machine on its way
// to becoming a slave, and a master is not on that way. Showing it there would have the card state
// something untrue about the machine the whole installation runs on.
//
// THE STATE LINE IS THE FIRST THING IT CARRIES, and it stands where the lifecycle's state line
// stands on every other card: which parts this machine carries, on which branch and at which stage
// (masterParts.ts). A master carries both parts from its own installation (hostyour-cloud#232), so
// no act about them is offered here.
//
// The TAILNET run kinds act on the cluster the machine already IS: they put its membership of the
// private network back, which a master needs like any other machine — its in-cluster components dial
// every slave's kube-apiserver over that network, and a master that is not a member cannot reach the
// address its slaves are registered under.
//
// The DISCONNECT is not among them, and that line is drawn once — in the plan
// (server/domains/runs/defs/tailnet.kit.ts) and read here through tailnetRunKindOffer, never stated
// a second time. A card that offered less than the plan admits would leave a repair reachable only
// by somebody who knows the API.

export function MasterActions(props: {
  parts: string | null;
  offer: TailnetRunKindOffer;
  onRead: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onRejoin: () => void;
}) {
  const { parts, offer, onRead, onDisconnect, onReconnect, onRejoin } = props;
  const anyAction = offer.read || offer.disconnect || offer.reconnect || offer.rejoin;
  if (!parts && !anyAction) return null;
  return (
    <>
      {parts && <p className="servercard__state">{parts}</p>}
      {anyAction && (
        <div className="actions">
          <TailnetActions
            offer={offer}
            onRead={onRead}
            onDisconnect={onDisconnect}
            onReconnect={onReconnect}
            onRejoin={onRejoin}
          />
        </div>
      )}
    </>
  );
}
