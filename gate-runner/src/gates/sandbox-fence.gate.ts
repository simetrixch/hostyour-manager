// gate-runner/src/gates/sandbox-fence.gate.ts
// G25 "sandbox fence" (hard). The one gate whose subject is the PLATFORM and not the repository
// under validation. The runner proves its own egress fence from inside before it reads or renders
// anything the repository ships (fence.ts selfProbe); when that proof does not come back green it
// runs NO check gate at all, and this row is what says so in the report.
//
// Without it the refusal is invisible. Measured on apps3 on 2026-08-26: the report carried thirteen
// valid fields, a verifying reportHash and a truthful attestation, and `gates: []` with
// `manifest: null` — a shape indistinguishable from a run whose gates all looked and found nothing.
// The Manager then composed its own gates on top and rejected the onboarding with "no build declared
// in deploy/platform.yaml" about a file that declares three, because nothing in the report said the
// gates had never run.
//
// It is a FAIL, never a warn: a run inside a fence that did not hold judged nothing, and the verdict
// must not be readable as anything a repository could fix.
import { fail } from "./result.ts";
import type { GateResult, SandboxAttestation } from "../../../shared/gates.ts";
import { sandboxFailures } from "../../../shared/gates.ts";

export const SANDBOX_FENCE_GATE_ID = "G25";
const TITLE = "sandbox fence";
const SEVERITY = "hard" as const;
const EXPECTED =
  "the runner's own egress self-probe proves the sandbox fence holds before any gate reads the repository: " +
  "every must-fail target denied against the Manager's confirmed-listening attestation, the Manager's own address denied, " +
  "and the one allowed egress reached";

/** The refusal row a run writes INSTEAD of its gates when the fence self-probe was not green.
 *  `skippedGateIds` is every sandbox gate that therefore did not run — named one by one, because a
 *  count says nothing about which parts of the repository went uninspected. */
export function sandboxFenceRefusal(sandbox: SandboxAttestation, skippedGateIds: readonly string[]): GateResult {
  const legs = sandboxFailures(sandbox);
  const skipped =
    skippedGateIds.length > 0
      ? `${skippedGateIds.join(", ")} did not run`
      : "no sandbox gate exists to run";
  return fail({
    id: SANDBOX_FENCE_GATE_ID,
    title: TITLE,
    severity: SEVERITY,
    expected: EXPECTED,
    found:
      `The sandbox fence did not hold: ${legs.join("; ")}. ` +
      `${skipped} — no gate has read this repository, and the manifest in this report is null because nothing parsed it, not because the repository lacks one.`,
    reason:
      "the sandbox is what keeps untrusted repository content away from the cluster it is being onboarded to, so a fence that is not provably holding means the repository is not read at all. " +
      "This is a fault in the platform's own validation sandbox, not a finding about the repository under validation: nothing in that repository can change this outcome, and the onboarding is refused until the sandbox's egress policy holds again.",
    detail: "the sandbox fence did not hold — no gate ran",
    evidence: [
      { source: "runner", name: "mustFailTargets", value: sandbox.mustFailTargets.join(", ").slice(0, 256) },
      ...legs.slice(0, 4).map((leg) => ({ source: "runner" as const, name: "fence", value: leg.slice(0, 256) })),
    ],
  });
}
