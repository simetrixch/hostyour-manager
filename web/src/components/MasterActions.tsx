import type { TailnetRunKindOffer } from "../tailnetState.ts";
import { TailnetActions } from "./TailnetActions.tsx";

// What the card of a machine carrying the MASTER part offers.
//
// It is its own row and not the block beside it, because that block is the SLAVE lifecycle: its four
// stages and every sentence in LIFECYCLE (pages/Servers.tsx) are written about a machine on its way
// to becoming a slave, and a master is not on that way. Showing it there would have the card state
// something untrue about the machine the whole installation runs on.
//
// What a master does carry is the run kinds that act on the cluster it already IS. `release` raises
// the platform version this installation stands on — the one run kind that moves that pin, and the
// way a change on the trunk reaches the machine at all. The tailnet pair puts its membership of the
// private network back, which a master needs like any other machine: its in-cluster components dial
// every slave's kube-apiserver over that network, and a master that is not a member cannot reach
// the address its slaves are registered under.
//
// The DISCONNECT is not among them, and that line is drawn once — in the plan
// (server/domains/runs/defs/tailnet.kit.ts) and read here through tailnetRunKindOffer, never stated
// a second time. A card that offered less than the plan admits would leave a repair reachable only
// by somebody who knows the API.

export function MasterActions(props: {
  showRelease: boolean;
  offer: TailnetRunKindOffer;
  onRelease: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onRejoin: () => void;
}) {
  const { showRelease, offer, onRelease, onDisconnect, onReconnect, onRejoin } = props;
  if (!showRelease && !offer.disconnect && !offer.reconnect && !offer.rejoin) return null;
  return (
    <div className="actions">
      {showRelease && (
        <button
          type="button"
          className="btn"
          onClick={onRelease}
          title="Raise the platform version this cluster stands on: pin the cluster map to the release, regenerate the install branch at it, re-run the machine layer over SSH, then wait for ArgoCD."
        >
          Release
        </button>
      )}
      <TailnetActions
        offer={offer}
        onDisconnect={onDisconnect}
        onReconnect={onReconnect}
        onRejoin={onRejoin}
      />
    </div>
  );
}
