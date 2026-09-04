import type { TailnetRunKindOffer } from "../tailnetState.ts";
import type { SlavePartBlock } from "../slavePartState.ts";
import type { Stage } from "../../../shared/enums.ts";
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
// (slavePartState.ts). A card that named only the machine's status would leave the one fact this
// row exists to report — the master part alone, or both parts — readable nowhere.
//
// TAKING THE SLAVE PART is the act that adds the other part to the machine, and the offer carries the
// run's two parameters rather than a form asking for them: they are the master's own domain and
// stage, and the plan refuses any others (server/domains/runs/defs/deploy-slave.master.ts).
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
  slavePart: SlavePartBlock | null;
  offer: TailnetRunKindOffer;
  onTakeSlavePart: (own: { domain: string; stage: Stage }) => void;
  onRead: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onRejoin: () => void;
}) {
  const { slavePart, offer, onTakeSlavePart, onRead, onDisconnect, onReconnect, onRejoin } = props;
  const takeSlavePart = slavePart?.offer ?? null;
  const anyAction = takeSlavePart !== null || offer.read || offer.disconnect || offer.reconnect || offer.rejoin;
  if (!slavePart && !anyAction) return null;
  return (
    <>
      {slavePart && <p className="servercard__state">{slavePart.line}</p>}
      {anyAction && (
        <div className="actions">
          {takeSlavePart && (
            <button type="button" className="btn btn--primary" onClick={() => onTakeSlavePart(takeSlavePart)}>
              Take the slave part
            </button>
          )}
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
