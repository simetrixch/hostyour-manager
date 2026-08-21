import type { HostsScript } from "./deploy-slave.fixture.ts";

// THE SCRIPTED MACHINE'S PLACEMENT HALF: what it answers the place-ansiwise probe, and what the
// placing script does to it. It reads and writes the SAME HostsScript the rest of the scripted
// machine does — a machine with two states would let a placement leave one of them behind — and it
// lives here because place-ansiwise is four placements over one machine and the fixture for it is
// as long as they are.
//
// EVERY EFFECT IS READ OFF THE SCRIPT THE STEP UPLOADED, never off what the step meant to do. A
// placement that composed its script without a section changes nothing here either, which is what
// makes an idempotence assertion about the mechanism rather than about the fixture.

/** The DIRECTORIES the scripted machine carries. The probe asks about paths, so the machine answers
 *  about paths: a probe that looked for the programs in the platform checkout — the shape that made
 *  the first version of place-ansiwise refuse on every real machine — finds nothing there, instead of
 *  being handed the field it meant to read. */
function machineDirs(f: HostsScript): string[] {
  return [
    ...(f.platformCheckout ? ["/srv/hostyour-cloud/.git"] : []),
    ...(f.catalogCheckout ? ["/srv/ansiwise-catalog/.git"] : []),
    ...(f.programs ? ["/srv/ansiwise-catalog/ansiwise/programs"] : []),
  ];
}

/** What `systemctl show -p ExecStart ansiwise.service` writes on the scripted machine. The whole
 *  line, not the two fields the manager reads out of it: a probe that took a shortcut through this
 *  would be answered in its own words instead of the service manager's. */
function execStartLine(f: HostsScript): string {
  if (f.serviceExecVersion === undefined) return "ExecStart=";
  const file = `/usr/local/bin/ansiwise-${f.serviceExecVersion}`;
  const listen = f.serviceExecListen === undefined ? "" : `--listen ${f.serviceExecListen} `;
  return `ExecStart={ path=${file} ; argv[]=${file} serve ${listen}` +
    "--service-token-file /etc/ansiwise/service-token --programs /srv/ansiwise-catalog/ansiwise/programs " +
    "--config ansiwise.yaml --runs /var/lib/ansiwise/runs ; ignore_errors=no ; pid=0 }";
}

/** What the placement probe reads off the scripted machine, answered off the probe script the step
 *  UPLOADED: every `[ -d "<path>" ]` line of it is decided against the directories above, under the
 *  name that line echoes. A probe naming no directory at all is refused rather than answered with a
 *  machine that carries nothing — that answer would place over a working installation. */
export function placementProbeOut(f: HostsScript, host: string, path: string): string {
  const script = f.files.filter((x) => x.host === host && x.path === path).at(-1)?.content ?? "";
  const dirs = machineDirs(f);
  const asked = [...script.matchAll(/^\[ -d "([^"]+)" \] && echo "([A-Z]+) present"/gm)];
  if (asked.length === 0) throw new Error(`the probe script at ${path} asks about no directory — the fixture cannot answer it`);
  return [
    `BINARY ${f.placedBinary ?? "absent"}`,
    ...asked.map((m) => `${m[2]} ${dirs.includes(m[1] ?? "") ? "present" : "absent"}`),
    // The two facts the service manager answers, and they are answered separately for the reason
    // the probe asks separately: a unit that is enabled and dead and one that runs and is not
    // enabled are two different machines, and neither is the one the placement is asked to leave.
    f.serviceEnabled ? "SERVICE enabled" : "SERVICE not-enabled",
    f.serviceActive ? "SERVICE active" : "SERVICE not-active",
    // The unit's own command, in the shape the service manager writes it: `path=` is the file it
    // would execute and `argv[]=` the whole line, `ExecStart=` alone for a unit it does not know.
    `SERVICE_EXEC ${execStartLine(f)}`,
    ...f.missingCommands.map((c) => `MISSING ${c}`),
    "PROBED",
  ].join("\n");
}

/** The placing script's effect on the scripted machine, applied from the script the step UPLOADED —
 *  which is the only place that says what this run of it places. A script the step composed without
 *  a section therefore changes nothing here either, the way the real one does not. */
export function applyPlacement(f: HostsScript, host: string): { out: string; code: number } {
  const script = f.files.filter((x) => x.host === host && x.path.includes("dc-place-ansiwise-")).at(-1)?.content ?? "";
  const out: string[] = [];
  if (script.includes("apt-get install")) f.missingCommands = [];
  const version = /^echo "PLACED_BINARY (\S+)"$/m.exec(script)?.[1];
  if (version !== undefined) {
    f.placedBinary = version;
    out.push(`PLACED_BINARY ${version}`);
  }
  if (script.includes("PLACED_CATALOG")) {
    f.catalogCheckout = true;
    f.programs = f.programsAfterClone;
    out.push("PLACED_CATALOG abc1234");
  }
  if (script.includes("PLACED_PLATFORM")) {
    f.platformCheckout = true;
    out.push("PLACED_PLATFORM abc1234");
  }
  // The service part, and it can end the script: the machine refuses BEFORE running install-service
  // when the file the token is read out of is not there, exactly as the real script does — its
  // `sudo -n test -r` is what those two lines are. So nothing after it runs and PLACED is never
  // written, which is the shape a caller reads its refusal off.
  if (script.includes("PLACED_SERVICE")) {
    if (!f.serviceTokenFile) return { out: "NO_SERVICE_TOKEN", code: 1 };
    // The unit install-service writes, composed out of the invocation the script carries: the
    // VERSIONED file it is run as, and the address on its own --listen.
    const wasActive = f.serviceActive;
    f.serviceExecVersion = /"\/usr\/local\/bin\/ansiwise-(\S+)" install-service/.exec(script)?.[1];
    f.serviceExecListen = /--listen "([^"]*)"/.exec(script)?.[1];
    f.serviceEnabled = true;
    f.serviceActive = f.serviceStartsAfterInstall;
    // `systemctl enable --now` starts a unit that is not running and does NOTHING to one that is, so
    // a rewritten command reaches the running process only through a restart. Both are read off the
    // uploaded script, the way every other effect here is.
    if (!wasActive || script.includes("systemctl restart ansiwise.service")) {
      f.serviceRunningVersion = f.serviceActive ? f.serviceExecVersion : undefined;
    }
    out.push("PLACED_SERVICE");
  }
  out.push("PLACED");
  return { out: out.join("\n"), code: 0 };
}
