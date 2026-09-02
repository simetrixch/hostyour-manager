import { describe, it, expect } from "vitest";
import { serveIdentity, requireServeCommand } from "./defs/ansiwise-run.kit.ts";

// WHAT A MACHINE IS, SAID TO THE BINARY THAT SERVES IT.
//
// A program declares which machines it applies to and the engine holds a run against that. The
// serving binary defaults `--role` to `master` and `--fqdn` to the empty text, so a serve started
// without them makes every machine claim to be a master carrying no domain. That is not a wrong
// label an operator later notices: the engine THROWS on the mismatch out of Runner.run, so the run's
// process dies before it writes one event, no record is left, and the caller waits on an event
// stream that will never carry anything. Measured on the first slave this platform deployed —
// `emit-cluster-credentials applies to slave, and this machine is master`, well into the
// deployment, because every program before it applies to both parts.

describe("serveIdentity — the two facts a serve cannot default", () => {
  it("says the role and the domain, in the form the binary takes", () => {
    expect(serveIdentity({ role: "slave", fqdn: "apps4.digitacloud.app" }))
      .toBe("--role slave --fqdn apps4.digitacloud.app");
  });

  it("carries a role of two parts as it stands, because that is what the machine is", () => {
    // A machine can hold both parts; the engine reads the role's parts and a program naming either
    // applies. Splitting or shortening it here would be this module deciding what a machine is.
    expect(serveIdentity({ role: "master+slave", fqdn: "apps3.digitacloud.app" }))
      .toBe("--role master+slave --fqdn apps3.digitacloud.app");
  });

  it("says the role alone for a host that carries no cluster, because a repair reaches such hosts", () => {
    // cluster-tailnet-disconnect and cluster-tailnet-reconnect state in their own words that they
    // need no cluster row: they put a membership back on a host that may have none. Demanding a
    // domain there would refuse exactly the hosts those runs exist for, and the binary's own default
    // for it — the empty text — is what every such run has always been given.
    expect(serveIdentity({ role: "slave", fqdn: "" })).toBe("--role slave");
  });

  it("PLANTED DEFECT: a value that is not one plain word is refused, never quoted", () => {
    // The result is written into a shell line on the machine. A quoter here would make this module
    // a shell composer, which is the thing place-ansiwise.ts spells out that it must never become.
    for (const bad of ["slave; rm -rf /", "apps4 apps4", "$(id)", "a`b`"]) {
      expect(() => serveIdentity({ role: bad, fqdn: "apps4.example" }), bad).toThrow(/not one plain word/);
      expect(() => serveIdentity({ role: "slave", fqdn: bad }), bad).toThrow(/not one plain word/);
      expect(() => serveIdentity({ role: "", fqdn: "apps4.example" })).toThrow(/not one plain word/); // a role is never absent
    }
  });
});

describe("requireServeCommand — whose statement the role is", () => {
  it("takes the configured command as it stands", () => {
    const cmd = "cd /srv/ansiwise-catalog && ~/ansiwise-rest serve --programs /srv/ansiwise-catalog/ansiwise/programs";
    expect(requireServeCommand({ ansiwiseServeCommand: cmd })).toBe(cmd);
  });

  it("PLANTED DEFECT: refuses a configured command that states the role itself", () => {
    // One command serves every machine this manager reaches, and what a machine IS differs per
    // machine. A role in the configuration would be right for one machine and silently wrong for
    // every other — and the one it is wrong for fails fifteen steps into a deployment.
    for (const bad of ["... serve --role master", "... serve --fqdn=x.example", "... serve --role=slave --programs p"]) {
      expect(() => requireServeCommand({ ansiwiseServeCommand: bad }), bad).toThrow(/not the installation's to state/);
    }
  });

  it("refuses an absent command by naming what it is for", () => {
    expect(() => requireServeCommand({})).toThrow(/ANSIWISE_SERVE_COMMAND is not configured/);
  });
});
