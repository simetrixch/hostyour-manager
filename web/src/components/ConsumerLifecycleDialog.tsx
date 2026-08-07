import { suspendConsumer, resumeConsumer, restartConsumerWorkloads } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The consumer verbs that plan from a plain confirm — no target to pick, no body to fill, so one
 *  dialog serves them all. restart-workloads sits beside suspend/resume because it has that same
 *  shape, NOT because it is a lifecycle state: it changes nothing about what the consumer IS. */
export type LifecycleAction = "suspend" | "resume" | "restart-workloads";

/** The API call each verb plans. A lookup rather than a chain of comparisons, so a verb added to the
 *  union with no call behind it fails the build instead of silently planning a suspend. */
const LIFECYCLE_CALL: Record<LifecycleAction, (appId: string) => Promise<{ runId: string }>> = {
  suspend: suspendConsumer,
  resume: resumeConsumer,
  "restart-workloads": restartConsumerWorkloads,
};

/** Per verb: the dialog's title verb, its button, and what the operator is approving. The restart
 *  copy is written out rather than composed, because "restart workloads" must NOT read as "replace the
 *  secrets" — replacing one is the operator's two steps BEFORE this (write Vault, delete the target
 *  Secret), and pods coming back on the same value is exactly what happens when those were skipped. */
const LIFECYCLE_COPY: Record<LifecycleAction, { title: string; button: string; effect: string }> = {
  suspend: {
    title: "Suspend",
    button: "suspend",
    effect: "suspend it (ArgoCD prunes the workloads; the inventory row is kept).",
  },
  resume: {
    title: "Resume",
    button: "resume",
    effect: "resume it (ArgoCD re-syncs the workloads).",
  },
  "restart-workloads": {
    title: "Restart the workloads of",
    button: "restart",
    effect:
      "roll every Deployment and StatefulSet in its namespace, so the new pods read their Secrets as they stand now. " +
      "This moves no secret: writing the new value into Vault and deleting the target Secret so ESO fetches it are the two steps before this one. " +
      "Rolling, not deleting — a consumer with more than one replica keeps serving through it.",
  },
};

/** Confirm one of the no-target consumer verbs. Confirming only PLANS the run and opens it; the
 *  cluster is untouched until the operator approves on the Run screen, which is what the copy says. */
export function ConsumerLifecycleDialog(props: {
  name: string;
  action: LifecycleAction;
  onCancel: () => void;
  /** Hands back the API call, so the page keeps owning the plan-then-navigate flow it shares with
   *  every other action on it. */
  onConfirm: (call: (appId: string) => Promise<{ runId: string }>) => void;
}) {
  const copy = LIFECYCLE_COPY[props.action];
  return (
    <ConfirmDialog
      title={`${copy.title} "${props.name}"?`}
      confirmLabel={`Plan ${copy.button}`}
      onCancel={props.onCancel}
      onConfirm={() => props.onConfirm(LIFECYCLE_CALL[props.action])}
    >
      <p>
        This <strong>plans</strong> a {props.action} run for <strong>{props.name}</strong> and opens it — nothing changes on the
        cluster yet. You <strong>approve on the next screen</strong> to actually {copy.effect}
      </p>
    </ConfirmDialog>
  );
}
