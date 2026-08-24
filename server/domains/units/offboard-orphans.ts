// The orphan scan of BOTH consumer removal run kinds — the LAST measurement offboard and purge make,
// between their deletes and the row flip, answering one question: is anything of this consumer still
// standing that nothing else will ever take away?
//
// WHAT AN ORPHAN IS HERE. Almost everything a consumer owns on a cluster is rendered by its chart, so
// removing the registration is enough — ArgoCD prunes the Application and everything under it. The
// exceptions are the objects the MANAGER wrote imperatively, outside any chart, either because the
// unit's own AppProject forbids them (appproject.ts blacklists Role and RoleBinding, and an
// Application can create neither an AppProject nor a cluster-scoped policy) or because no
// chart-rendered ExternalSecret could ever carry their value (repo-credential.ts). Those four — the
// isolation AppProject, the ArgoCD repository Secret, the admission policy with its binding, and the
// build grants — belong to no Application, so no prune reaps them and the only thing that removes
// them is the delete step that owns each one. Two of those four steps are fail-SOFT
// (delete-repo-credential and delete-build-rbac): they log the fault and let the teardown continue,
// so a run can reach its end having reported success over a Secret or a Role that is still there.
// Together with the two GitOps-side things the run removes itself — this stage's registration and the
// public DNS record of this stage — that set is what is read back here, from the cluster, the
// registration branch and the DNS provider, rather than from the run's own account of what it did.
//
// WHAT IS DELIBERATELY KEPT, and is therefore never a finding:
//   - the apps row. A settled consumer row is kept for the history and for a re-onboard.
//   - everything a SURVIVING stage of the same unit builds, releases and deploys through: the two
//     `<name>-build` grants, the repo PAT, the build webhook and the release kit. There is one of each
//     per UNIT, not one per stage (lifecycle.ts unitStaysRegistered), so a one-stage offboard leaves
//     them standing on purpose — and this scan asks the same registration tree before it looks, so it
//     flags exactly the objects the same run was supposed to take.
//   - the consumer's namespace. deleteNamespace is non-blocking by contract, so the namespace is
//     normally still Terminating while this runs, and its presence would say nothing either way.
//   - the `<name>-build` namespace. The platform repo's build fan-out renders it and ArgoCD prunes it
//     when build.yaml leaves the tree — another actor's object, on another actor's clock.
//
// WHAT CANNOT BE READ BACK, and why that is not a hole:
//   - the Vault entries. The seeder is write-only by policy (adapters/vault/seeder-port.ts): it never
//     reads and never lists, so there is no read to make. Their deletes are fail-CLOSED instead, which
//     is what stands in for the second look.
//   - the build webhook and the release kit. Both are reached with the consumer's sealed clone
//     credential, and remove-repo-pat revokes it before this scan runs; their own removals are the
//     last steps that can open it.
//
// It FAILS the run rather than warning, and it runs before the row is recorded, so a leftover leaves
// the inventory row unsettled and the run retryable from this step. That is the same split the tenant
// teardown makes (tenant-teardown.ts settlePruneGuardStep): the removals stay soft about PROCEEDING,
// the RECORD does not — a row saying the consumer left is what makes a leftover unfindable.
//
// PURGE RUNS IT TOO, and that is not a nicety. purge is the run kind an operator reaches for AFTER an
// offboard failed here, and its own delete-repo-credential and delete-build-rbac are fail-soft in
// exactly the same way; a purge that flipped the row without looking would settle the very state
// offboard had just refused to settle, through the run kind meant to be the backstop.
import type { StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { AppCluster, LifecyclePorts } from "./lifecycle.ts";
import type { BuildRbacObject, BuildRbacWriter, RepoCredentialWriter } from "../../adapters/kube/port.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { consumerAdmissionPolicyName, unitApexFromChain } from "./admission-policy.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { consumerUnitHost } from "./unit-dns.ts";
import { renderBuildRbac, renderConsumerArgoSync, unitBuildNamespace } from "./build-rbac.ts";

/** What the scan reads through: the lifecycle set (the registration branch + the per-cluster kube
 *  clients) plus the three writers whose objects it looks for. The writers are optional exactly as
 *  they are on the removal run kinds, and the scan says so rather than counting an unlooked-at object as
 *  gone. */
export type OrphanScanPorts = LifecyclePorts & {
  buildRbac?: BuildRbacWriter;
  repoCredential?: RepoCredentialWriter;
  dns?: DnsProvider;
};

/** `<kind> <namespace>/<name>` — how a grant object is named in the report, and the key the presence
 *  read's answer is matched by. */
const grantRef = (o: BuildRbacObject): string => `${o.kind} ${o.namespace}/${o.name}`;

/** Read back everything this removal was supposed to take and refuse to let the row be recorded while
 *  any of it stands. `unit` is the stage being removed; the tree decides what belongs to it. `runKind`
 *  names the run in the refusal ("offboard" / "purge") so an operator reads which removal left the
 *  leftover, not which module found it. */
export async function assertNoOrphans(ctx: StepCtx, ports: OrphanScanPorts, unit: AppCluster, runKind: string): Promise<void> {
  const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(unit.clusterId);
  // ONE tree read answers both halves: whether THIS stage's registration is gone, and whether the unit
  // stands anywhere else — which is what decides whether the build-namespace grants are a leftover or
  // the thing a surviving stage releases through. Read at the moment of the decision, exactly as every
  // removal step reads it, so a resumed run measures the tree it is actually in.
  const standing = await ports.registrations.readUnitStages(unit.name);
  const elsewhere = standing.filter((stage) => stage !== unit.stage);

  const gone: string[] = [];
  const left: string[] = [];
  const unread: string[] = [];
  const look = (what: string, present: boolean): void => {
    (present ? left : gone).push(what);
  };

  look(`registration registrations/${unit.name}/${unit.stage}.yaml`, standing.includes(unit.stage));
  look(`AppProject ${argoNamespace}/${unit.name}`, await projectWriter.appProjectExists(argoNamespace, unit.name));
  const policy = consumerAdmissionPolicyName(unit.name);
  look(`admission policy ${policy}`, await clusterReader.admissionPolicyExists(policy));

  // An absent writer is not a tolerated blind spot: onboard fails loud without the very same instance,
  // so a manager wired without it never wrote the object either and there is nothing of its making
  // to find. Said in the report rather than counted as gone.
  if (ports.repoCredential) {
    const secret = consumerRepoCredentialName(unit.name);
    look(`ArgoCD repository Secret ${argoNamespace}/${secret}`, await ports.repoCredential.repoCredentialExists(argoNamespace, secret));
  } else {
    unread.push("the ArgoCD repository Secret (no repository-credential writer is wired, so this manager never wrote one)");
  }

  if (ports.buildRbac) {
    // Exactly the grants delete-build-rbac rendered for this run: the stage's own argo-sync grant alone
    // while another stage stands, all three once this is the unit's last.
    const grants = elsewhere.length > 0 ? [renderConsumerArgoSync({ name: unit.name, argoNamespace })] : renderBuildRbac({ name: unit.name, argoNamespace });
    const present = new Set((await ports.buildRbac.listBuildRbac(grants)).map(grantRef));
    for (const { role, binding } of grants) {
      for (const o of [role, binding]) {
        const ref = grantRef({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name });
        look(ref, present.has(ref));
      }
    }
  } else {
    unread.push("the build grants (no build-RBAC writer is wired, so this manager never wrote any)");
  }

  // DNS is fail-closed wherever it appears (unit-dns.ts): the removal step already failed the run when
  // no provider is wired, so a scan without one could never be the honest half of a teardown that
  // claims to have taken the address away.
  if (!ports.dns) {
    throw errValidation(
      `cannot look for a leftover DNS record of ${unit.name}: no DNS provider is wired on this manager (CLOUDFLARE_DNS_API_TOKEN unset) — the unit's address is a mandatory part of the run kind, never a silent skip`,
    );
  }
  const host = consumerUnitHost(unit.name, unitApexFromChain(await ports.registrations.readClusterValueFiles(unit.domain, unit.stage)));
  look(`DNS A ${host}`, (await ports.dns.readRecordContent({ name: host, type: "A", signal: ctx.signal })) !== null);

  if (left.length > 0) {
    throw errValidation(
      `the ${runKind} of ${unit.name} (${unit.stage}) left ${left.length} object(s) standing on ${unit.domain}: ${left.join("; ")}. ` +
        `Nothing else takes any of these away — the registration and the address are this run's own to remove, and the cluster objects were written outside any chart, so no ArgoCD prune reaches them. ` +
        `Repair them and retry this step. ` +
        `The inventory row is deliberately NOT recorded offboarded: a row saying ${unit.name} left ${unit.stage} while these stand is what makes a leftover unfindable.`,
    );
  }
  // What the scan LOOKED AT, so the step's own data answers that question — the throw above is the
  // only path on which anything stands, so recording the leftovers here could only ever be an empty
  // list, and nothing downstream reads this record: the row rests on the throw and the step order.
  ctx.checkpoint({ gone, unread });
  ctx.log(
    "meta",
    `nothing of ${unit.name} (${unit.stage}) is left standing on ${unit.domain} — read back and gone: ${gone.join(", ")}` +
      (elsewhere.length > 0
        ? `; kept on purpose because the unit still stands at ${elsewhere.join(", ")}: the ${unitBuildNamespace(unit.name)} grants, the repo PAT, the build webhook and the release kit`
        : "") +
      `; the apps row is kept as soft state` +
      (unread.length > 0 ? `; not looked at: ${unread.join("; ")}` : ""),
  );
}
