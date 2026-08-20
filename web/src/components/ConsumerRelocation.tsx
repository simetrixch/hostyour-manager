import { Link } from "react-router";
import type { ReactNode } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { listOnboardTargets, type ConsumerView } from "../api.ts";
import { relocationRun, relocationLine } from "../relocationBand.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RelocationTargetDialog } from "./RelocationTargetDialog.tsx";

/** The consumer half of the relocation surface, split out of Consumers.tsx along the
 *  400-line budget: the offboarded-rows panel (whose one run kind is Restore) and the two dialogs the
 *  page opens for Back up and Move…/Restore…. All plan-then-approve: confirming only PLANS a run. */

/** Offboarded consumers (their row is kept): nothing to reconcile, ONE run kind left — Restore rebuilds the
 *  consumer from its Storage Box folder onto a chosen cluster of its stage. */
export function OffboardedConsumers(props: { rows: ConsumerView[]; runs: RunView[]; onRestore: (c: ConsumerView) => void }): ReactNode {
  if (props.rows.length === 0) return null;
  return (
    <>
      <h3 className="steps-panel__title">Offboarded consumers</h3>
      <ul className="rows">
        {props.rows.map((c) => {
          const band = relocationRun(c.id, props.runs);
          return (
            <li key={c.id}>
              <div className="row">
                <span className={`badge badge--${c.status}`}>{c.status}</span>
                <span className="row__title">{c.name}</span>
                <span className="row__meta">
                  {c.domain} · {c.stage}
                </span>
                <span className="row__end">
                  {band && <Link to={`/runs/${band.id}`}>{relocationLine(band)} →</Link>}
                  <button type="button" className="btn" onClick={() => props.onRestore(c)}>
                    Restore…
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ConsumerBackupDialog(props: { c: ConsumerView; onCancel: () => void; onConfirm: () => void }): ReactNode {
  return (
    <ConfirmDialog title={`Back up "${props.c.name}"?`} confirmLabel="Plan backup" onCancel={props.onCancel} onConfirm={props.onConfirm}>
      <p>
        This <strong>plans</strong> a backup run and opens it — you approve on the next screen. The run <strong>closes access for
        the duration of the dump</strong> (downtime, never an inconsistent copy), dumps every store into the Storage Box folder{" "}
        <span className="mono">/{props.c.name}/</span>, verifies the folder and reopens. The folder stays.
      </p>
    </ConfirmDialog>
  );
}

export function ConsumerRelocationDialog(props: { c: ConsumerView; kind: "move" | "restore"; onCancel: () => void; onConfirm: (targetClusterId: string) => void }): ReactNode {
  const { c, kind } = props;
  return (
    <RelocationTargetDialog
      title={kind === "move" ? `Move "${c.name}" to another cluster?` : `Restore "${c.name}" from its backup?`}
      kind={kind}
      confirmLabel={kind === "move" ? "Plan move" : "Plan restore"}
      stage={c.stage}
      currentClusterId={c.clusterId}
      loadTargets={listOnboardTargets}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    >
      {kind === "move" ? (
        <p>
          This <strong>plans</strong> a move and opens it — you approve on the next screen. A move is a backup, a restore into the
          target and a repoint: access closes while every store is dumped to the Storage Box, the unit deploys closed on the
          target, the data is replayed and verified, <strong>one DNS record is updated</strong> (the address stays{" "}
          <span className="mono">{c.name}</span>&apos;s own), access reopens, and the source is cleared <strong>last</strong>.
        </p>
      ) : (
        <p>
          This <strong>plans</strong> a restore and opens it — you approve on the next screen. The run rebuilds{" "}
          <span className="mono">{c.name}</span> from its Storage Box folder: the dumped registration is re-committed on the chosen
          cluster (closed), every store is replayed and verified, the DNS record is set, and access opens last.
        </p>
      )}
    </RelocationTargetDialog>
  );
}
