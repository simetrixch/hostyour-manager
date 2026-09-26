import { useState } from "react";
import type { ReleaseChannel } from "../../../shared/release.ts";
import { getChannelStages } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that refreshes a tenant: its member entries re-resolved off the product's
 *  manifest, and every app of THIS tenant built at its default branch head on the channel chosen here.
 *  Only a channel whose ceiling reaches the tenant's stage is offered (global.channelStages, the
 *  release scripts' concept); the run refuses any other. The built versions are approved for this
 *  tenant alone: no stage pin moves and no other tenant changes. Confirming only PLANS the run. */
export function RefreshMembersAction(props: { stage: string; busy: boolean; onRefresh: (channel: ReleaseChannel) => void }) {
  const [channels, setChannels] = useState<ReleaseChannel[] | null>(null);
  const [channel, setChannel] = useState<ReleaseChannel | "">("");
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    try {
      const { channelStages } = await getChannelStages();
      const reaching = (Object.keys(channelStages) as ReleaseChannel[]).filter((c) => (channelStages[c] ?? []).includes(props.stage as never));
      setChannels(reaching);
      setChannel(reaching.length === 1 ? reaching[0]! : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => void open()}>
        Refresh members
      </button>
      {error && <p className="error">{error}</p>}
      {channels && (
        <ConfirmDialog
          title="Refresh this tenant onto its newest build"
          confirmLabel={channel ? `Build on ${channel} and refresh` : "Choose a channel"}
          onCancel={() => setChannels(null)}
          onConfirm={() => { if (channel) { setChannels(null); props.onRefresh(channel); } }}
        >
          <p>
            <label>
              Channel (only those that reach {props.stage}){" "}
              <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as ReleaseChannel)}>
                <option value="">—</option>
                {channels.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </p>
          <p>
            Every app of this tenant is built at its repository&apos;s default branch head on this channel and approved for
            this tenant alone; no other tenant changes. An app whose head this tenant already runs builds nothing. The
            member entries are brought to the product&apos;s manifest as well.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
