// WHERE THE DEPLOY-STATE STANDS, stated once for the process. The adapter reads it (kube.ts) and the
// boot check holds it against the platform repo's own values (domains/inventory/deploy-state-name.ts),
// so a rename on either side arrives as one red line at boot instead of as a refused onboarding.
//
// The name is the platform's to choose: clusters/inventories/deploy-state/values-common.yaml writes it
// and the Manager's RBAC is resourceNames-scoped to it. What is here is this process's copy.
export const DEPLOY_STATE_CONFIGMAP = {
  namespace: "kube-system",
  name: "hostyour-deploy-state",
} as const;
