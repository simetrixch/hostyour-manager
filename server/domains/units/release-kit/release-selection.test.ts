import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { RELEASE_KIT_FILES } from "./release-kit.ts";

// WHERE A RELEASE WRITES ITS PIN, and how the two spellings decide it.
//
// A pin belongs on the branch of every cluster that RUNS the unit. The platform states that per unit
// — `runsOn` in clusters/inventories/<build>/app.yaml — and states a cluster's parts per branch —
// `role` in clusters/active/<branch>.yaml. The same two fields the platform-apps ApplicationSet
// matches to decide which workloads a cluster renders.
//
// WHAT ASKING THE OTHER QUESTION COSTS. The scripts used to ask whether the BRANCH is a master, which
// agreed with this by coincidence: measured on 2026-08-30, exactly two inventories carry a builds[]
// pin, `manager` and `gate-runner`, and both declare `runsOn: master`. The first unit that declares
// `runsOn: slave` or `every-cluster` and carries a build would have had its pin written to no slave
// branch at all, and nothing would have said so — the release reports itself on its way to the stage
// while the machines that run that unit keep the previous image.
//
// THE MATCH IS RUN, NOT READ. The two matchers are lifted out of the shipped scripts and executed by
// the real bash and the real pwsh over one table, so what is proven is what an operator's machine
// will do — and both spellings are held to the same answers, since a rule that differed between them
// would put a unit's pin on different branches depending on which shell somebody released from.

const byPath = Object.fromEntries(RELEASE_KIT_FILES.map((f) => [f.path, f.content]));
const SH = byPath["release/release.sh"]!;
const PS1 = byPath["release/release.ps1"]!;

/** How bash is reached from here. On Linux it is the shell itself; on Windows, where this suite runs
 *  today, the same shell answers inside WSL — the shape remote-syntax.test.ts uses for the same
 *  reason: an approximation of a shell would be worth less than none, because it would read as a
 *  guarantee. The script rides in on STDIN, so no path has to cross between the two operating
 *  systems. */
const BASH = process.platform === "win32"
  ? { file: "wsl", args: ["-e", "bash", "-s"] }
  : { file: "bash", args: ["-s"] };
const PWSH = { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", "-"] };

function answers(interpreter: { file: string; args: string[] }, script: string): string[] | null {
  try {
    const out = execFileSync(interpreter.file, interpreter.args, { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

const REACHABLE = {
  bash: answers(BASH, "echo reachable")?.[0] === "reachable",
  pwsh: answers(PWSH, "'reachable'")?.[0] === "reachable",
};

/** One function lifted out of a shipped script: from its opening line to the first closing brace in
 *  the first column. What is executed below is therefore the released text and never a copy of it. */
function lift(script: string, opening: string): string {
  const from = script.indexOf(opening);
  expect(from, opening).toBeGreaterThan(-1);
  const to = script.indexOf("\n}\n", from);
  expect(to, opening).toBeGreaterThan(from);
  return script.slice(from, to + 3);
}

/** Every (runsOn, role) pair the platform can put in front of the rule, and the one answer both
 *  spellings owe it. A role names every PART a cluster carries, so `master+slave` runs both parts'
 *  units; `every-cluster` belongs on all of them; and a branch with no role at all is no cluster's
 *  install branch. */
const CASES: readonly { runsOn: string; role: string; pinned: boolean }[] = [
  { runsOn: "master", role: "master", pinned: true },
  { runsOn: "master", role: "slave", pinned: false },
  { runsOn: "master", role: "master+slave", pinned: true },
  { runsOn: "slave", role: "slave", pinned: true },
  { runsOn: "slave", role: "master", pinned: false },
  { runsOn: "slave", role: "master+slave", pinned: true },
  { runsOn: "every-cluster", role: "master", pinned: true },
  { runsOn: "every-cluster", role: "slave", pinned: true },
  { runsOn: "every-cluster", role: "master+slave", pinned: true },
  // A part the role only begins with is not a part it carries: "+mastermind+" holds no "+master+".
  { runsOn: "master", role: "mastermind", pinned: false },
  { runsOn: "master", role: "", pinned: false },
];

const expected = CASES.map((c) => `${c.runsOn}|${c.role}|${c.pinned ? "yes" : "no"}`);

describe("which branches a release pins", () => {
  it("states the rule in the shipped bytes: the unit's runsOn against the branch's role", () => {
    // The field, its file, and the tree it is read off — the trunk, which is where the
    // ApplicationSet's own generator reads it.
    //
    // KEYED BY THE BUILD AND NOT BY THE UNIT, and the two are different names: this manifest's
    // `name` is hostyour-manager and its builds are manager, gate-runner and dbtools, while
    // clusters/inventories is keyed by the build. Measured on 2026-09-04: a lookup under the unit's
    // own name refused every release of this repository, because no such inventory exists.
    expect(SH).toContain('clusters/inventories/${build}/app.yaml');
    expect(SH).toContain('git -C "$PLATFORM_REPO_DIR" show "origin/master:clusters/inventories/${build}/app.yaml"');
    expect(PS1).toContain('$appYaml = "clusters/inventories/$build/app.yaml"');
    expect(PS1).toContain('git -C $platformRepoDir show "origin/master:$appYaml"');
    // Every build is asked, not the first one: a unit whose pin belongs on two kinds of cluster gets
    // it on both, and a build carrying no chart contributes nothing rather than deciding for the rest.
    expect(SH).toContain('for build in $(sed -nE');
    expect(PS1).toContain('foreach ($build in (');
    // And the question that is no longer asked: whether the branch happens to be a master.
    expect(SH).not.toContain('[ "$role" = "master" ] || continue');
    expect(PS1).not.toContain("$roleLine.Groups[1].Value.Trim() -ne 'master'");
  });

  it("refuses a unit no build of which states runsOn, BEFORE anything is minted", () => {
    // In the pre-flight, beside the push probe: a release that cannot tell where its unit runs
    // cannot tell where its pin belongs, and a refusal after the tag exists is a release nothing can
    // re-mint. Both spellings say so, and both say it before the mint.
    for (const [script, mint] of [[SH, 'git tag -a "$TAG"'], [PS1, "git tag -a $tag"]] as const) {
      const refusal = script.indexOf("that states runsOn");
      expect(refusal).toBeGreaterThan(-1);
      expect(script.indexOf(mint)).toBeGreaterThan(refusal);
    }
  });

  it("says which branches it passed over, so a pin that reached nowhere is visible in the run", () => {
    for (const script of [SH, PS1]) {
      expect(script).toContain("is no cluster's install branch - passed over");
      expect(script).toContain("part and");
      expect(script).toContain("runs on");
    }
  });

  it.skipIf(!REACHABLE.bash)("the bash matcher answers the table, run by a real bash", () => {
    if (!REACHABLE.bash) return;
    const driver = CASES.map((c) =>
      `RUNS_ON='${c.runsOn}'; if runs_here '${c.role}'; then echo '${c.runsOn}|${c.role}|yes'; else echo '${c.runsOn}|${c.role}|no'; fi`).join("\n");
    expect(answers(BASH, `${lift(SH, "runs_here() {")}\n${driver}\n`)).toEqual(expected);
  });

  it.skipIf(!REACHABLE.pwsh)("the pwsh matcher answers the SAME table, run by a real pwsh", () => {
    if (!REACHABLE.pwsh) return;
    const driver = CASES.map((c) =>
      `$runsOn = '${c.runsOn}'; if (Test-RunsHere -Role '${c.role}') { '${c.runsOn}|${c.role}|yes' } else { '${c.runsOn}|${c.role}|no' }`).join("\n");
    expect(answers(PWSH, `${lift(PS1, "function Test-RunsHere {")}\n${driver}\n`)).toEqual(expected);
  });

  it("COUNTER-PROBE: the lifted matchers are the real ones, and a table nobody answers cannot pass", () => {
    // Both assertions above run text taken out of the shipped script. If the lift missed, there
    // would be no function to call and the run would answer nothing — which is what this proves the
    // comparison would notice, since an empty answer is not the expected table.
    expect(lift(SH, "runs_here() {")).toContain("every-cluster");
    expect(lift(PS1, "function Test-RunsHere {")).toContain("every-cluster");
    expect(expected).toHaveLength(CASES.length);
    expect(answers(BASH, "true")).not.toEqual(expected);
  });
});
