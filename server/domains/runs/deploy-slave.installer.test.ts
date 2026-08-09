import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareBranchScript } from "./defs/deploy-slave.remote.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";

// The cross-repo contract of the automated slave path. prepare-branch runs a script on the master
// that reaches into hostyour-cloud's own scripts, and the two repos ship separately — so nothing
// forces them to agree. This test does, against the REAL scripts in the sibling checkout (ci.sh
// mounts the repos side by side, the same layout as a dev machine).
//
// What the contract IS, since it changed: install.sh knows one role, `master`, and a slave is a
// separate FQDN with its own branch and its own map. So prepare-branch no longer INVOKES install.sh
// at all. It calls set-domain.sh with the role word `slave` — whose arm is what prunes the books off
// that branch — and it SOURCES install.sh for `scaffold_inputs` alone. Both of those are things
// hostyour-cloud could take away without this repo noticing until a run dies ten minutes in.
describe("installer contract — what prepare-branch needs from hostyour-cloud", () => {
  const cloud = (name: string): string => fileURLToPath(new URL(`../../../../hostyour-cloud/${name}`, import.meta.url));
  const installSh = cloud("install.sh");
  const setDomainSh = cloud("set-domain.sh");

  const script = (): string =>
    prepareBranchScript({ stage: "prod", slaveFqdn: "s1.example.com", mapYaml: "fqdn: s1.example.com\nstage: prod\nrole: slave\n" });

  it.skipIf(!existsSync(setDomainSh))("set-domain.sh still accepts the role word `slave` — the arm that prunes the books off a slave's branch", () => {
    const text = readFileSync(setDomainSh, "utf8");
    // The role reaches set-domain.sh as the third positional argument, and its case list is what
    // accepts or refuses it. A list that lost `slave` makes every slave attach die at the first
    // command of prepare-branch — with the scratch clone already reset.
    const accepted = /case "\$\{ROLE\}" in\s*\n\s*([a-z+|]+)\)/.exec(text)?.[1] ?? "";
    expect(accepted, "set-domain.sh's role case list moved or changed shape — update the extraction").not.toBe("");
    expect(accepted.split("|"), "set-domain.sh no longer accepts `slave`, so a slave's branch cannot be cut or pruned").toContain("slave");

    expect(script()).toContain('./set-domain.sh "prod" "s1.example.com" slave');
  });

  it.skipIf(!existsSync(installSh))("install.sh stays sourceable and still defines scaffold_inputs", () => {
    const text = readFileSync(installSh, "utf8");
    // Sourcing runs the file; only the guard keeps main() from running the whole install with no
    // arguments. Lose it and prepare-branch executes an installer instead of defining a function.
    expect(text, "install.sh no longer guards main() against being sourced — prepare-branch sources it").toMatch(/if \[\[ "\$\{BASH_SOURCE\[0\]\}" == "\$\{0\}" \]\]/);
    expect(text, "install.sh no longer defines scaffold_inputs — prepare-branch calls it to fill the slave's secrets").toMatch(/^scaffold_inputs\(\)\s*\{/m);

    const s = script();
    expect(s).toContain("source ./install.sh");
    expect(s).toContain("scaffold_inputs");
  });

  it("invokes install.sh as a COMMAND nowhere — the installer knows one role, and it is not this one", () => {
    // The whole point of the rewrite. A line starting `./install.sh` would be passing a role word
    // install.sh refuses, and every argument after it.
    const lines = script().split("\n").filter((l) => /^\s*(\.\/|bash\s+\.\/)install\.sh\b/.test(l));
    expect(lines, `prepare-branch invokes install.sh: ${lines.join(" | ")}`).toEqual([]);
  });

  it("inherits the installation's values from the master's own config rather than asking again", () => {
    // A slave is part of the SAME installation. Its six values come from the master's config.<stage>,
    // which is on the machine this script runs on — not from a second round of questions, and not
    // from flags this repo would have to keep in step with install.sh.
    const s = script();
    expect(s).toContain('MASTER_CFG="$GITOPS_DIR/base/configs/config.prod"');
    expect(s, "the master's config is read by sourcing it — the way setup.sh reads it too").toContain('. "$MASTER_CFG"');
  });

  it("writes the map from the bytes the Controller composed, not from a second serializer", () => {
    const s = prepareBranchScript({ stage: "prod", slaveFqdn: "s1.example.com", mapYaml: "fqdn: s1.example.com\nrole: slave\n" });
    expect(s).toContain(`cat > "${clusterMarkingPath("s1.example.com")}" <<'DC_MAP_EOF'`);
    expect(s).toContain("fqdn: s1.example.com\nrole: slave\nDC_MAP_EOF");
  });

});
