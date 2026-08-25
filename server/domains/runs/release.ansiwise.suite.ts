import { describe, it, expect } from "vitest";
import { getRun } from "../../executor/read.ts";
import type { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import type { ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { AppError } from "../../kernel/errors.ts";
import { requireProgramsStep } from "./defs/ansiwise-run.kit.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import { PARAMS, MASTER_ID, SLAVE_ID } from "./deploy-slave.fixture.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import {
  uniqueEmail, elevationOnly, deploySecrets, releaseSecrets,
  liveMaster, releaseSlaveWorld, recordWindow, startedRuns, expectProven, settled, programStepCtx,
} from "./ansiwise-serve.fixture.ts";

// THE RELEASE, END TO END, over the REAL `ansiwise-rest serve` — both arms, and the step that stands in
// front of the pin.
//
// IT IS NOT A TEST FILE OF ITS OWN, and the reason is the one redeploy.ansiwise.test.ts states for
// itself: the engine's run root is per-DRIVE, and a serve fixture's close() removes the whole of it,
// so a second file starting a second fixture would delete the first file's records mid-run. These
// suites therefore register into the ONE file that starts the fixture — it imports this module and
// calls the function below inside its own describe. What is split here is the FILE (the 400-line
// doctrine, which that file had reached), never the process.
//
// `serve` and `observer` arrive as accessors because the file that owns them binds them in beforeAll,
// which happens after this module's describe has been registered.

export function releaseSuite(serve: () => ServeFixture, observer: () => AnsiwiseClient): void {
  describe("the release, over the machine's own deployment programs", () => {
    const releaseParams = { serverId: MASTER_ID, version: "1.0.0", channel: "stable" as const };

    it("INNOCENT CASE (release): programs → pin → refresh → regenerate-branch → deploy-cluster → deploy-platform-services, every program proven dry then run on the machine's own records", { timeout: 120_000 }, async () => {
      const h = await liveMaster(serve());
      const email = uniqueEmail();

      const r = await h.executor.plan("cluster-release", releaseParams);
      expect(r.plan.steps.map((s) => s.name)).toEqual([
        "attest-target", "require-programs", "set-pin", "refresh-checkout",
        "run-regenerate-branch", "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
      ]);
      await h.executor.approve(r.runId, releaseSecrets(email));
      await h.executor.settle(r.runId);
      expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

      // The pin: ONE tag, minted in the release grammar, and the map states it. This is what the
      // regeneration on a real machine reads back off the branch (the fixture program only measures —
      // the merge semantics are regenerate-branch's own rows, proven in its catalogue).
      expect(h.platformRepo.tags.size).toBe(1);
      const tag = [...h.platformRepo.tags.keys()][0] ?? "";
      expect(tag).toMatch(/^1\.0\.0-stable-\d{14}$/);
      expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath("m1.example.com"))).toContain(`release: ${tag}`);

      // The machine's OWN records: dry + run per program, every one green, all three programs.
      expectProven(h.db, r.runId, await observer().runs(), ["regenerate-branch", "deploy-cluster", "deploy-platform-services"]);

      // The machine's checkout was refreshed BEFORE the programs read it (the pin commit and the tag
      // reach the machine through that step or not at all), the conversations went over the machine's
      // serve surface, and the follow still read ArgoCD.
      const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
      expect(onMaster.some((c) => c.includes("dc-refresh-checkout-"))).toBe(true);
      // Four, not three: one per program step, plus the ONE require-programs opens to ask the
      // catalogue what it carries before anything is written.
      expect(onMaster.filter((c) => c === "ansiwise-rest serve")).toHaveLength(4);
      expect(onMaster.some((c) => c.includes("-n argocd get applications.argoproj.io"))).toBe(true);
    });

    it("INNOCENT CASE (release, SLAVE): the regeneration runs on the MASTER at the pin the master's own branch carries, the machine layer on the slave — every program proven dry then run", { timeout: 120_000 }, async () => {
      const h = await releaseSlaveWorld(serve());
      const email = uniqueEmail();

      const r = await h.executor.plan("cluster-release", { serverId: SLAVE_ID, version: "1.0.0", channel: "stable" });
      expect(r.plan.steps.map((s) => s.name)).toEqual([
        "attest-target", "require-programs", "set-pin", "prepare-regeneration",
        "run-regenerate-slave-branch", "refresh-checkout",
        "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
      ]);
      await h.executor.approve(r.runId, deploySecrets(email));
      await h.executor.settle(r.runId);
      expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

      // The pin went into the SLAVE's map, and that map stands on the MASTER's branch — which is the
      // whole reason the regeneration cannot be the slave's own act.
      expect(h.platformRepo.tags.size).toBe(1);
      const tag = [...h.platformRepo.tags.keys()][0] ?? "";
      expect(tag).toMatch(/^1\.0\.0-stable-\d{14}$/);
      expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath(PARAMS.domain))).toContain(`release: ${tag}`);

      expectProven(h.db, r.runId, await observer().runs(), ["regenerate-slave-branch", "deploy-cluster", "deploy-platform-services"]);

      // WHICH HOST DID WHAT, which is the ticket's own claim. The master stood its two checkouts and
      // held two conversations (the shared require-programs ask, then the regeneration); the slave
      // refreshed its own checkout and held three (the ask, then its two machine-layer programs).
      const onMaster = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
      const onSlave = h.hosts.log.filter((l) => l.host === "10.1.1.11").map((l) => l.command);
      expect(onMaster.some((c) => c.includes("dc-prepare-regeneration-"))).toBe(true);
      expect(onMaster.filter((c) => c === "ansiwise-rest serve")).toHaveLength(2);
      expect(onMaster.some((c) => c.includes("dc-refresh-checkout-"))).toBe(false);
      expect(onSlave.some((c) => c.includes("dc-refresh-checkout-"))).toBe(true);
      expect(onSlave.filter((c) => c === "ansiwise-rest serve")).toHaveLength(3);
      // A slave's Applications live in its own ArgoCD instance ON THE MASTER, in namespace s1.
      expect(onMaster.some((c) => c.includes("-n s1 get applications.argoproj.io"))).toBe(true);
    });

    it("PLANTED DEFECT (release): a committer identity the machine's dry run judges red fails run-regenerate-branch — no run-mode regeneration, and the two deploy programs never start", { timeout: 60_000 }, async () => {
      const h = await liveMaster(serve());

      // "not-an-email" fails the program's own ^[^@]+@[^@]+$ row — the defect is ON THE MACHINE'S
      // SIDE of the wire, and the machine's dry run is what catches it. (releaseSecrets seeds a VALID
      // letsencrypt mailbox, so only the committer identity is wrong.)
      const runId = await settled(h, "cluster-release", releaseParams, { ...releaseSecrets(uniqueEmail()), "activation-input:committer_email": Buffer.from("not-an-email") });
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      expect(stepColumn(h.db, runId, "run-regenerate-branch", "error")).toMatch(/DRY run of regenerate-branch on the machine is not green/);

      // The proof failed, so nothing after it was acted on: not one run-mode regeneration, and the
      // two deploy programs saw no run of ANY mode. The pin stands — set-pin precedes the machine
      // acts by design, and a retry of the run adopts exactly that tag instead of minting a second.
      const window = recordWindow(await observer().runs(), startedRuns(h.db, runId));
      expect(window.filter((x) => x.program === "regenerate-branch" && x.mode === "run")).toHaveLength(0);
      expect(window.filter((x) => x.program === "deploy-cluster" || x.program === "deploy-platform-services")).toHaveLength(0);
      expect(h.platformRepo.tags.size).toBe(1);
    });

    it("require-programs refuses a name the machine's catalogue does not carry, and names what it DOES offer", { timeout: 60_000 }, async () => {
      // The step a release takes BEFORE set-pin, asked over a real `ansiwise-rest serve` about a name no
      // catalogue will ever carry. The engine and the GET /programs read are real; the programs that
      // installation carries are fixturePrograms(), not digita-deploy's, so what goes red here is the
      // step's reading of the LIST — which is the part that has to hold. This is the failure the
      // ordering exists for: an installation whose checkout is older than this manager answers
      // exactly like this, and it answers here — with the tag unminted and the map untouched —
      // instead of five steps later.
      const h = await releaseSlaveWorld(serve());
      const logs: string[] = [];
      const ctx = programStepCtx(serve(), h, {
        secrets: elevationOnly(), log: (l) => logs.push(l),
        readCheckpoint: () => undefined, checkpoint: () => undefined,
      });
      const step = requireProgramsStep({ ansiwiseServeCommand: "ansiwise-rest serve" }, [{ program: "regenerate-nothing" }]);
      const err = await step.run(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      const message = (err as AppError).message;
      expect(message).toContain('"regenerate-nothing"');
      expect(message).toContain("regenerate-slave-branch"); // what the catalogue DOES offer, listed
      expect(message).toContain("pin");                      // why the question is asked this early

      // Counter-probe: the same catalogue, over the same surface, admits the name it does carry — so
      // the refusal is a reading of the LIST and not a step that refuses everything.
      const ok = requireProgramsStep({ ansiwiseServeCommand: "ansiwise-rest serve" }, [{ program: "regenerate-slave-branch" }]);
      await expect(ok.run(ctx)).resolves.toBeUndefined();
      expect(logs.some((l) => l.includes("carries regenerate-slave-branch"))).toBe(true);
    });
  });
}
