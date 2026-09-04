import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mergeTrunkScript } from "./deploy-slave.remote.ts";

// THE MERGE THE BRANCH CUT PERFORMS, RUN AGAINST REAL GIT.
//
// mergeTrunkScript is the one place a slave's published branch meets today's trunk, and what it does
// with a conflict is a decision about the customer's repository: inside the two trees that carry no
// decision of the branch's own it takes the trunk's version, and anywhere else it stops the run.
// Neither half can
// be read off the text — `git checkout --theirs` during a merge, what `--diff-filter=U` lists, and
// whether an aborted merge leaves the branch where it stood are git's behaviour, not this
// repository's. So the script is executed here, against repositories this test builds, rather than
// asserted as a string.
//
// The scenario is the recorded one: a branch cut from a trunk whose ApplicationSet selected by one
// role word and stamped with `slave`, meeting a trunk that has since rewritten that selector into
// two markers. git cannot know that `- slave` IS the stamped form of what now stands there, and
// stops — which is what a deploy attempt against such a trunk meets.

const SHELL = process.platform === "win32"
  ? { file: "wsl", args: ["-e", "sh", "-c"] }
  : { file: "sh", args: ["-c"] };

function shell(script: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(SHELL.file, [...SHELL.args, script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

/** A bare origin carrying `master` and a slave branch cut from an older master and stamped, plus a
 *  work checkout standing on that branch — the state prepare-checkouts leaves behind. `extra` is
 *  spliced in before the trunk's second commit, so a case can add a change of its own. */
function scenario(extra: string, merge: string): string {
  return `set -eu
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
root=$(mktemp -d)
origin=$root/origin
git init -q --bare "$origin"

# ---- the trunk, as it stood when the slave's branch was cut
seed=$root/seed
git init -q -b master "$seed"
mkdir -p "$seed/clusters/argocd/files" "$seed/clusters/bootstrap"
printf 'values:\n  - every-cluster\n  - __CLUSTER_ROLE__\n' > "$seed/clusters/argocd/files/platform-apps-appset.yaml"
printf 'name: __CLUSTER_NAME__\n' > "$seed/clusters/bootstrap/values.yaml"
printf 'the trunk\n' > "$seed/README.md"
git -C "$seed" add -A && git -C "$seed" commit -qm "trunk v1"
git -C "$seed" remote add origin "$origin" && git -C "$seed" push -q origin master

# ---- the slave's branch: cut from that trunk and STAMPED
git -C "$seed" checkout -q -b apps4.example
printf 'values:\n  - every-cluster\n  - slave\n' > "$seed/clusters/argocd/files/platform-apps-appset.yaml"
printf 'name: apps4\n' > "$seed/clusters/bootstrap/values.yaml"
mkdir -p "$seed/clusters/active"
printf 'role: slave\n' > "$seed/clusters/active/apps4.example.yaml"
git -C "$seed" add -A && git -C "$seed" commit -qm "stamp the installation"
git -C "$seed" push -q origin apps4.example

# ---- the trunk moves on: the selector becomes two slots
git -C "$seed" checkout -q master
printf 'values:\n  - every-cluster\n  - __CLUSTER_ROLE_FIRST_PART__\n  - __CLUSTER_ROLE_LAST_PART__\n' > "$seed/clusters/argocd/files/platform-apps-appset.yaml"
${extra}
git -C "$seed" add -A && git -C "$seed" commit -qm "select by part"
git -C "$seed" push -q origin master

# ---- the work checkout, standing on the published branch
work=$root/work
git clone -q "$origin" "$work"
git -C "$work" checkout -q -B apps4.example origin/apps4.example

${merge}
echo "HEAD_AFTER $(git -C "$work" rev-parse --abbrev-ref HEAD)"
echo "APPSET $(tr '\n' '|' < "$work/clusters/argocd/files/platform-apps-appset.yaml")"
echo "MAP $(tr '\n' '|' < "$work/clusters/active/apps4.example.yaml")"
echo "UNMERGED [$(git -C "$work" diff --name-only --diff-filter=U | tr '\n' ' ')]"
`;
}

const MERGE = mergeTrunkScript("$work", "origin/master");

describe("mergeTrunkScript — a published slave branch meeting today's trunk", () => {
  it("INNOCENT CASE: a conflict inside one of the two trees takes the trunk's version, and the branch keeps what only it carries", { timeout: 120_000 }, () => {
    const r = shell(scenario("", MERGE));
    expect(r.err, r.err).not.toMatch(/CONFLICT|Automatic merge failed/);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    // the stamped file is the TRUNK's, markers and all — which is the input the next step stamps
    expect(r.out).toMatch(/APPSET .*__CLUSTER_ROLE_FIRST_PART__.*__CLUSTER_ROLE_LAST_PART__/);
    // and the file only the branch carries is untouched by the resolution
    expect(r.out).toMatch(/MAP role: slave/);
    // the merge was completed, not left standing
    expect(r.out).toMatch(/UNMERGED \[\]/);
    expect(r.out).toMatch(/MERGE_RESOLVED clusters\/argocd\/files\/platform-apps-appset\.yaml/);
    expect(r.out).toMatch(/HEAD_AFTER apps4\.example/);
  });

  it("PLANTED DEFECT: a conflict OUTSIDE those trees stops the run, names the path, and changes nothing", { timeout: 120_000 }, () => {
    // The trunk starts shipping a file the branch already writes — two decisions meeting on one path,
    // and no later step re-stamps it, so nobody but a person can say which stands.
    const r = shell(scenario(
      `mkdir -p "$seed/clusters/active" && printf 'role: trunk\n' > "$seed/clusters/active/apps4.example.yaml"`,
      MERGE,
    ));
    expect(r.code).toBe(6);
    expect(r.err).toContain("clusters/active/apps4.example.yaml");
    expect(r.err).toContain("only a person can say which stands");
    expect(r.err).toContain("Nothing was changed.");
    expect(r.out).not.toMatch(/MERGE_RESOLVED/);
  });

  it("a trunk that touches nothing the branch stamped merges as it always did, and this adds no line to it", { timeout: 120_000 }, () => {
    // Only the README moves. There is no conflict, the fragment's body never runs, and the branch
    // carries the trunk's change — the behaviour before this resolution existed.
    const r = shell(scenario(`printf 'the trunk, later\n' > "$seed/README.md"`, MERGE)
      .replace('printf \'values:\n  - every-cluster\n  - __CLUSTER_ROLE_FIRST_PART__\n  - __CLUSTER_ROLE_LAST_PART__\n\' > "$seed/clusters/argocd/files/platform-apps-appset.yaml"\n', ""));
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).not.toMatch(/MERGE_RESOLVED/);
    expect(r.out).toMatch(/APPSET values:\|  - every-cluster\|  - slave\|/);
  });
});
