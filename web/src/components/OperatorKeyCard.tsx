import type { OperatorKeyView, ServerView } from "../../../shared/api-types.ts";
import { operatorKeyMarker } from "../../../shared/operator-keys.ts";
import { operatorKeyPlacement } from "../authorizedKeysState.ts";

// ONE operator key, and where it stands on every server this controller knows. Props-only, like
// TailnetActions and PasswordLoginActions: which acts a row may offer is decided by
// operatorKeyPlacement (authorizedKeysState.ts, a pure module a test can reach), and what each one
// does is decided by the run it plans — this renders rows and buttons.
//
// One row per SERVER, one run per row. That is the whole answer to "place this key across the
// servers": a key is on a machine or it is not, per machine, and each act is its own run with its
// own log — so a host that refuses shows up as one failed run beside five that worked, instead of
// one run whose single verdict would have to be wrong about five of them.

export function OperatorKeyCard(props: {
  entry: OperatorKeyView;
  servers: ServerView[];
  onPlace: (serverId: string) => void;
  onRemove: (serverId: string) => void;
  onForget: () => void;
}) {
  const { entry, servers, onPlace, onRemove, onForget } = props;
  return (
    <li className="card servercard">
      <div className="card__head">
        <strong className="servercard__name">{entry.label}</strong>
        <span className="chip">{entry.type}</span>
      </div>
      <div className="servercard__target">{entry.fingerprint}</div>
      <p className="servercard__reading">
        Placed as a line ending <code>{operatorKeyMarker(entry.label)}</code> — the marker a removal matches, and one this
        controller&apos;s own key can never carry. On {entry.onServerIds.length} of {servers.length} server(s) as they were last read.
      </p>
      <ul className="cards cards--nested">
        {servers.map((s) => {
          const p = operatorKeyPlacement(s, entry.fingerprint);
          return (
            <li key={s.id} className="servercard__keyrow">
              <div>
                <strong>{s.name}</strong>{" "}
                <span className={p.state === "present" ? "chip chip--ok" : "chip"}>
                  {p.state === "present" ? "on the host" : p.state === "absent" ? "not on the host" : "not read"}
                </span>
                <p className="servercard__reading">{p.line}</p>
              </div>
              <div className="actions">
                {p.place && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onPlace(s.id)}
                    title="Append this key to the host's authorized_keys under its own marker. Every other line is passed through untouched, and the run reads the file back to prove it."
                  >
                    Place
                  </button>
                )}
                {p.remove && (
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => onRemove(s.id)}
                    title="Delete only the line carrying this key's marker. A host that never carried it is left alone; a copy placed by hand under another comment stays, and the run says so."
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="btn btn--danger"
          onClick={onForget}
          title="Forget this key here. It takes nothing off any machine, and it is refused while the last reading of any server still finds the key — once the row is gone, nothing can name the line to delete."
        >
          Forget this key
        </button>
      </div>
    </li>
  );
}
