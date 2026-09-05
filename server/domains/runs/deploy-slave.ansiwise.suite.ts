import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import type { AnsiwiseClient } from "../../adapters/ansiwise/ansiwise-http.ts";
import type { ServeFixture } from "../../adapters/ansiwise/testing/serve-fixture.ts";
import { isServe } from "./ansiwise-serve.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { readServerTailnet } from "../../../shared/tailnet.ts";
import { readServerAuthorizedKeys } from "../../../shared/operator-keys.ts";
import { serverCredFlags } from "../inventory/write.ts";
import {
  STEP_NAMES, REDEPLOY_STEP_NAMES, PARAMS, EMIT_ARGOCD_TOKEN, EMIT_REVIEWER_TOKEN, EMIT_CREDS_JSON,
  ELEVATION_PASSWORD, SLAVE_ID, MINT_AUTHKEY, IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY,
  TAILNET_PROBE_JOINED, FIXTURE_REGISTRY_HOST, pullDocumentFor, type Harness,
} from "./deploy-slave.fixture.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import {
  elevationOnly, expectProven, expectAbsent, machineWroteDown,
  deployWorld, liveSlaveWorld, recordWindow, startedRuns, settled,
} from "./ansiwise-serve.fixture.ts";

// DEPLOYING A SLAVE, END TO END, and re-deploying one that already is: the four journeys that drive
// the whole composed list against the REAL `ansiwise-rest serve`. First contact stands at the head of
// that list — establishing the key this manager reaches a machine with is a state this run kind
// brings about, not an act somebody performs beforehand — so what it leaves is read here, off the
// machine and off the row.
//
// WHICH MACHINE THE GREEN JOURNEY STARTS FROM, stated because it is what these readings are worth.
// The MACHINE carries nothing this platform put there: the image's own key in its authorized_keys, a
// clock nobody set to synchronise, a daemon that takes any password, and no standing passwordless-root
// grant (deploy-slave.first-contact.fixture.ts firstContactDefaults). The ROW already holds the sealed
// ssh_key credential (deploy-slave.fixture.ts makeHarness), so `openDoor` takes its key branch and the
// password door is never the one opened here. The branch where this manager holds no credential at all
// is held one level down, over an SSH factory that records which credential was offered
// (manager-key.test.ts) and over the wire, against a real server and a real client
// (executor/context.door.test.ts).
//
// IT IS NOT A TEST FILE OF ITS OWN, for the reason redeploy.ansiwise.test.ts states for itself: the
// engine's run root is per-DRIVE and a serve fixture's close() removes the whole of it, so a second
// file starting a second fixture would delete the first file's records mid-run. This registers into
// the ONE file that starts the fixture, which is also why `serve` arrives as an accessor — that file
// binds it in beforeAll, after this module's describe is registered.

/** The password sealed beside a server row before the machine account's password became a run
 *  secret. `purge-bootstrap-password` destroys it, and the redaction assertion looks for it in the
 *  persisted surface — so it is deliberately unmistakable, the way ELEVATION_PASSWORD is: a value
 *  that could occur by accident would make both statements weaker than they read. */
const BOOTSTRAP_PASSWORD = "bootstrap-password-SECRET-0009";

/** What a client that was never logged in reports: the binary is there — the base install puts it
 *  there before anything of this platform runs — and it names no network, no address and no
 *  coordinator, because it holds none. That is the machine a reset at the hosting provider hands
 *  back, and the reading `join-if-absent` decides on. */
const TAILNET_PROBE_NOT_JOINED = [
  "TAILNET client present",
  "TAILNET version 1.80.2",
  "TAILNET backend NeedsLogin",
].join("\n");

/** What a step wrote down about what it FOUND — its own checkpoint's data, which is where a
 *  measure-then-act step records the reading its act was decided on. */
const found = (h: Harness, runId: string, step: string): Record<string, unknown> =>
  (JSON.parse(stepColumn(h.db, runId, step, "checkpoint_json") ?? "{}") as { data?: Record<string, unknown> }).data ?? {};

export function deploySlaveSuite(serve: () => ServeFixture, observer: () => AnsiwiseClient): void {
  describe("deploying a slave, and re-deploying one that already is", () => {
    it("INNOCENT CASE (deploy-slave): the whole run kind runs green — every program dry-proven then run on the machines' own records, one address everywhere, the tokens nowhere", { timeout: 300_000 }, async () => {
      const h = await deployWorld(serve());
      // A password sealed beside the row while that was still how a machine was reached. It is a way
      // in that survives whatever the daemon is told, so it is the second of the two doors this run
      // shuts, and it has to stand here for its destruction below to be a measurement.
      await h.store.seal({
        kind: "other", label: "bootstrap password for s1", plaintext: Buffer.from(BOOTSTRAP_PASSWORD),
        fingerprint: "bootstrap-password", serverId: SLAVE_ID,
      });

      const r = await h.executor.plan("cluster-deploy-slave", PARAMS);
      expect(r.plan.steps.map((s) => s.name)).toEqual(STEP_NAMES);
      await h.executor.approve(r.runId, elevationOnly());
      await h.executor.settle(r.runId);
      expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

      // The machines' OWN records: dry + run per program, every one green — the registration on the
      // master's surface, the machine layer, the join and the emit on the slave's. NO BRANCH PROGRAM
      // is among them: a pure slave has no install branch, and its map is the manager's own write
      // onto the books.
      expectProven(serve(), h.db, r.runId, await observer().runs(), [
        "deploy-host", "deploy-cluster", "deploy-platform-services",
        "tailnet-mint-join-key", "tailnet-rejoin", "emit-cluster-credentials", "register-slave",
      ]);

      // WHICH surface each conversation went over: two on the master (mint, register), five on the
      // slave (host, cluster, gitops, rejoin, emit).
      const master = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
      const slave = h.hosts.log.filter((l) => l.host === "10.1.1.11").map((l) => l.command);
      expect(master.filter(isServe)).toHaveLength(2);
      expect(slave.filter(isServe)).toHaveLength(5);
      // WHAT EACH MACHINE WAS TOLD IT IS, which is the fact a serve cannot default. Without it the
      // slave's serve claims `master`, and emit-cluster-credentials — the first program in this run
      // kind declared for a slave — is thrown out of Runner.run before it writes one event, leaving
      // the caller on a stream that never carries anything. The role is the inventory row's, sent as
      // it stands: a row naming both parts is sent whole, because the engine reads a role's PARTS and
      // a program declared for either one applies (appliesTo, ansiwise-core program.dart).
      for (const [cmds, want] of [[slave, "--role slave"], [master, "--role master --fqdn m1.example.com"]] as const) for (const c of cmds.filter(isServe)) expect(c, c).toContain(want);
      // THE STAGE TRAVELS WITH THE DOMAIN wherever the CLUSTER ROW states both. This master carries
      // no such row, so its domain is the fallback (servers.host) and there is no stage to state;
      // the slave's own two conversations name its cluster and carry its stage with it.
      for (const c of slave.filter(isServe)) expect(/ --fqdn \S+/.test(c), c).toBe(/ --stage \S+/.test(c));
      expect(slave.filter(isServe).some((c) => c.includes("--fqdn s1.example.com --stage prod"))).toBe(true);

      // THE ONE-ADDRESS LAW, on the record: the map the run committed carries the same spelling the
      // emit and the register were given as their answer — the fixture's api_server_url/ca_data rows
      // are what judged those, so the green register run above IS the proof the answers matched.
      const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath("s1.example.com")) ?? "";
      for (const want of ["  master: m1.example.com", "booksCluster: m1.example.com", "  apiHost: 100.64.0.11", "  apiPort: 16443", "role: slave", "  catalogUrl: https://github.com/acme/acme-catalog.git"]) {
        expect(map).toContain(want);
      }

      // The credentials file was read over the session and removed; same for the join key.
      expect(slave.some((c) => c === "cat /tmp/ansiwise-cluster-credentials")).toBe(true);
      expect(slave.some((c) => c === "rm -f /tmp/ansiwise-cluster-credentials")).toBe(true);
      expect(master.some((c) => c === "cat /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);
      expect(master.some((c) => c === "rm -f /tmp/ansiwise-tailnet-join-key-s1")).toBe(true);

      // register's terminal choreography: cluster ACTIVE with a valid plane carrying the emitted
      // kube facts and the sealed credential ids; server healthy, with the join's own reading.
      const cluster = h.db.db.select().from(clusters).where(eq(clusters.domain, "s1.example.com")).get();
      expect(cluster?.status).toBe("active");
      const bearer = await h.store.list({ serverId: SLAVE_ID, kind: "kubeconfig" });
      const reviewer = await h.store.list({ serverId: SLAVE_ID, kind: "other" });
      const plane = ClusterPlaneV0.parse(cluster?.planeJson);
      expect(plane.kube).toEqual({ server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==" });
      expect(plane.credentialIds).toEqual({ clusterBearer: bearer[0]?.id, reviewerJwt: reviewer[0]?.id });
      const server = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
      expect(server?.status).toBe("healthy");
      expect(server?.tailnetState).toBe("joined");
      expect(readServerTailnet(server?.tailnetJson).kind).toBe("v0");

      // WHAT FIRST CONTACT LEFT ON THE MACHINE. Establishing the key this manager reaches a box with
      // is the head of this run kind's list rather than an act somebody performs beforehand, so the
      // one run that goes green end to end is where its outcome is read — off the machine, and off
      // the row, not off the steps' own exit codes.
      //
      // The key line stands in authorized_keys and nothing else was appended; the row is stamped with
      // the login that key proved; both password doors are shut, the daemon's and the one sealed
      // beside the row; and the machine granted this manager no standing passwordless-root rule for
      // any of it, so every root command of every step raised itself with the password the approve
      // carried.
      expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY]);
      expect(server?.adoptedAt).toBeInstanceOf(Date);
      expect(h.hosts.passwordLogin).toBe("no");
      expect(server?.passwordLoginState).toBe("off");
      expect((await serverCredFlags(h.store)).get(SLAVE_ID)?.hasPassword).toBe(false);
      expect(h.hosts.adopted).toBe(false);

      // AND THE READING TAKEN THE MOMENT THE KEY WENT ON. The image ships with the provisioning key of
      // whoever ordered the machine — a working way in this manager did not place and cannot remove —
      // and a machine nobody has looked at is exactly where such a key goes unseen. The lines are
      // classified by the fingerprints this manager has sealed and never by the marker comment, which
      // anyone with a shell on the box could type.
      expect(server?.authorizedKeysState).toBe("unaccounted");
      const keys = readServerAuthorizedKeys(server?.authorizedKeysJson);
      expect(keys.kind).toBe("v0");
      if (keys.kind === "v0") {
        expect(keys.facts.runId).toBe(r.runId);
        expect(keys.facts.keys.map((k) => k.kind)).toEqual(["foreign", "manager"]);
        expect(keys.facts.keys[0]?.comment).toBe("someone@example.com");
      }

      // REDACTION: the two bearer tokens, the join key and the machine account's own password appear
      // NOWHERE in the persisted run surface (every table except the sealed credential store, plus the
      // run log). The password is the one an operator typed on the approve card: it raises every root
      // command of this run and opened its first login, and it is held in memory for the run's length
      // and written down nowhere.
      const tables = h.db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'credentials'")
        .all() as { name: string }[];
      let dump = JSON.stringify(readEvents(h.db.db, r.runId));
      for (const t of tables) dump += JSON.stringify(h.db.sqlite.prepare(`SELECT * FROM ${t.name}`).all());
      expect(dump).not.toContain(EMIT_ARGOCD_TOKEN);
      expect(dump).not.toContain(EMIT_REVIEWER_TOKEN);
      expect(dump).not.toContain(MINT_AUTHKEY);
      expect(dump).not.toContain(ELEVATION_PASSWORD);
      expect(dump).not.toContain(BOOTSTRAP_PASSWORD);

      // THE REGISTRY PULL CREDENTIAL REACHED THE MACHINE AND TOUCHED NO DISK ON IT. It is the one
      // value a cluster keeping no books cannot read off a file of its own, and it now travels as a
      // declared-secret ANSWER of deploy-cluster rather than as a file this manager writes and takes
      // away again. Three places are read, and each is a place it used to be able to stand:
      //   - no file was PUT on any machine carrying it, which is what the removed steps did;
      //   - no command sent to any machine carries it, so nothing echoed it into a file either;
      //   - the machine's OWN run root does not carry it, because deploy-cluster declares the
      //     answer `secret` and the engine redacts a declared secret in every record it writes —
      //     which is exactly what a file-sourced value can never be.
      // The value the manager composes is the fixture harness's own pull document narrowed to the
      // address BOTH cluster maps name, so this compares the same bytes the run sent.
      const pullDocument = pullDocumentFor(FIXTURE_REGISTRY_HOST);
      const wroteDown = machineWroteDown(serve());
      expect(h.hosts.files.map((f) => `${f.path} ${f.content}`).join("\n")).not.toContain(pullDocument);
      expect(h.hosts.log.map((l) => l.command).join("\n")).not.toContain(pullDocument);
      expect(wroteDown).not.toContain(pullDocument);
      expect(dump).not.toContain(pullDocument);
      // AND IT DID ARRIVE, which is the half an absence assertion cannot state on its own: the
      // fixture's deploy-cluster declares `registry_pull_dockerconfigjson` REQUIRED and judges its
      // shape with a step of its own, so the green deploy-cluster record asserted above is the proof
      // that the machine was handed this document and not nothing.
    });

    it("PLANTED DEFECT (deploy-slave): a TAMPERED credentials file goes red on the machine's own dry run of register-slave — nothing is registered, and the tokens still leak nowhere", { timeout: 300_000 }, async () => {
      const h = await deployWorld(serve());
      // The defect sits in the FILE contract: the slave hands back an authority the master must not
      // trust. The fixture's ca_data row is the machine-side judge.
      h.hosts.credsOut = EMIT_CREDS_JSON.replace("TFMtQ0EtREFUQQ==", "VEFNUEVSRUQ=");

      const runId = await settled(h, "cluster-deploy-slave", PARAMS, elevationOnly());
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      expect(stepColumn(h.db, runId, "create-mgmt", "error")).toMatch(/DRY run of register-slave on the master is not green/);
      // The emit itself is green — the defect is in what it handed over — and the registration
      // never ran: not one run-mode register-slave record on the machine.
      const all = await observer().runs();
      expectProven(serve(), h.db, runId, all, ["emit-cluster-credentials"]);
      expect(recordWindow(all, startedRuns(h.db, runId)).filter((x) => x.program === "register-slave" && x.mode === "run")).toHaveLength(0);
      // The tampered file's tokens still appear nowhere in the persisted surface.
      const dump = JSON.stringify(readEvents(h.db.db, runId));
      expect(dump).not.toContain(EMIT_ARGOCD_TOKEN);
      expect(dump).not.toContain(EMIT_REVIEWER_TOKEN);
    });

    it("PLANTED DEFECT (deploy-slave): a manager holding no pull configuration STOPS at deploy-cluster — no machine run of it starts, and no cluster is installed without its mirror", { timeout: 300_000 }, async () => {
      // THE DEGRADATION THIS RUN KIND MAY NOT PRODUCE. A cluster that keeps no books reads the
      // registry pull credential off no file of its own, and the machine's own row for it is
      // SATISFIED when the credential is simply absent: it warns, writes no mirror, and the cluster
      // then pulls every image from the rate-limited public path with nothing anywhere saying so.
      // So the value not being there is a refusal on this side, before deploy-cluster is asked to
      // do anything — the same shape as the answer being composed and the machine's own catalogue
      // declaring no such answer, which composeAnswers would otherwise drop in silence.
      const h = await deployWorld(serve(), { withoutCarriedValues: true });

      const runId = await settled(h, "cluster-deploy-slave", PARAMS, elevationOnly());
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      expect(stepColumn(h.db, runId, "run-deploy-cluster", "error")).toMatch(/no pull configuration of its own/);
      // deploy-host ran; deploy-cluster was never asked, in either mode.
      const all = await observer().runs();
      expectProven(serve(), h.db, runId, all, ["deploy-host"]);
      expectAbsent(h.db, runId, all, ["deploy-cluster", "deploy-platform-services"]);
    });

    it("abort-with-cleanup (deploy-slave): the map's slave part goes FIRST, then the remove-slave program on the master's record — and the marking cleanup finds nothing left, while the machine stays reachable", { timeout: 300_000 }, async () => {
      const h = await deployWorld(serve());
      h.hosts.credsOut = EMIT_CREDS_JSON.replace("TFMtQ0EtREFUQQ==", "VEFNUEVSRUQ="); // park at create-mgmt with every cleanup armed
      const runId = await settled(h, "cluster-deploy-slave", PARAMS, elevationOnly());
      expect(getRun(h.db.db, runId)?.status).toBe("failed");

      // Each arming step persisted exactly its own cleanup name (__cleanups)...
      for (const [step, name] of [
        ["mark-slave", "remove-slave-marking"],
        ["rejoin", "remove-slave"],
      ] as const) {
        const cp = JSON.parse(stepColumn(h.db, runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
        expect(cp.__cleanups, step).toEqual([name]);
      }
      // ...AND THE THREE STEPS THAT USED TO ARM ONE NOW ARM NOTHING. Each of them acts on the
      // SLAVE, and a half-finished run on the slave is finished by running the run again — so a
      // compensation there either takes away what the retry needs (the key line, the shut password
      // door) or undoes what the retry redoes anyway (the snap).
      for (const step of ["install-key", "disable-password-login", "run-deploy-cluster"] as const) {
        const cp = JSON.parse(stepColumn(h.db, runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
        expect(cp.__cleanups, step).toBeUndefined();
      }

      const logMark = h.hosts.log.length;
      // THE CLEANUP IS HELD TO THE SAME ROUTE AS THE RUN. The machine grants nothing without a
      // password (FirstContactScript.adopted defaults to false, and it stays false here), so
      // remove-slave — which drives a program on the master's own surface — reaches root the only
      // way anything here does: with the run's own elevation password, which the scripted machine
      // refuses without. That is why the abort re-supplies it: a failed run's secrets were wiped with
      // the run, exactly as a retry re-supplies them.
      await h.executor.abortWithCleanup(runId, elevationOnly());
      await h.executor.settle(runId);

      const run = getRun(h.db.db, runId);
      expect(run?.status).toBe("cancelled");
      const cleanupSteps = run?.steps.filter((s) => s.name.startsWith("cleanup:")) ?? [];
      expect(cleanupSteps.map((s) => s.name)).toEqual([
        "cleanup:remove-slave", "cleanup:remove-slave-marking",
      ]); // reverse registration order — the map cleanup was armed FIRST (mark-slave), so it runs LAST
      expect(cleanupSteps.every((s) => s.status === "ok")).toBe(true);

      // WHAT THE ABORT LEAVES THE MACHINE AS, read off the machine, which is where it is a fact: the
      // daemon still takes no password and this manager's own key line still stands beside the
      // image's provisioning key. That is the state every later run kind of this manager needs and
      // the state this run's own retry starts from — reachable by this manager and by nobody else.
      expect(h.hosts.passwordLogin).toBe("no");
      expect(h.hosts.authorizedKeys).toContain(IMAGE_KEY_LINE);
      expect(h.hosts.authorizedKeys).toHaveLength(2);

      // The map keeps the cluster's identity and loses ONLY the slave part — dropped by the
      // remove-slave cleanup itself, FIRST (the program's own contract), so the marking cleanup
      // afterwards found nothing left to drop.
      const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath("s1.example.com")) ?? "";
      expect(map).toContain("role: slave");
      expect(map).toContain("  buildPlane: m1.example.com");
      // booksCluster goes WITH the slave part: a map still carrying the selector key without the
      // endpoint would make the generated Application error instead of disappear.
      for (const gone of ["master:", "booksCluster:", "apiHost:", "apiPort:"]) expect(map).not.toContain(gone);

      // The removal itself is a machine act, dry-proven then run on the master's own record...
      expectProven(serve(), h.db, runId, await observer().runs(), ["remove-slave"]);
      // ...and NOTHING was sent to the slave: the abort's whole surface is the master's books.
      const tail = h.hosts.log.slice(logMark);
      expect(tail.filter((l) => l.host === "10.1.1.11")).toEqual([]);
    });

    it("INNOCENT CASE (redeploy, slave arm): the live slave is re-reconciled over the programs — no branch cut, no join, a fresh emit re-points the registration, and nothing is armed", { timeout: 300_000 }, async () => {
      const h = await liveSlaveWorld(serve());

      const r = await h.executor.plan("cluster-redeploy", { serverId: SLAVE_ID });
      expect(r.plan.steps.map((s) => s.name)).toEqual(REDEPLOY_STEP_NAMES);
      expect(r.plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
      // AND NOT ONE ANSWER BESIDE IT, on this arm as on the master one: what the machine-layer
      // programs declare past the inventory stands in this slave's own cluster map, and
      // slaveMachineAnswers reads it there.
      expect(r.plan.requiredInputs).toBeUndefined();
      await h.executor.approve(r.runId, elevationOnly());
      await h.executor.settle(r.runId);
      expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

      // The machine layer and the handshake re-ran, each dry-proven; the join did not, on either
      // machine's records.
      const all = await observer().runs();
      expectProven(serve(), h.db, r.runId, all, ["deploy-host", "deploy-cluster", "deploy-platform-services", "emit-cluster-credentials", "register-slave"]);
      expectAbsent(h.db, r.runId, all, ["tailnet-mint-join-key", "tailnet-rejoin"]);

      // AND WHAT DECIDED THE SECOND OF THOSE, because it is a MEASUREMENT here and not a step left
      // out of the list: `join-if-absent` read the machine's own client, found it running on the
      // private network, and joined nothing. The reading is the whole of the safety — a join
      // discards the node key as its first act, so it would hand this live slave a fresh address
      // that the cluster map and the master's reconciler are still pointing away from, and mint a
      // credential at the coordinator that nothing can un-mint.
      expect(found(h, r.runId, "join-if-absent")).toEqual({ measured: "joined", joined: false });
      // The coordinator was not touched either: the node standing there is a working slave's own
      // registration, and a join is the only thing that clears one.
      expect(h.hosts.log.filter((l) => l.command.includes("nodes delete"))).toEqual([]);
      // …and the row still ends carrying a reading this run took, which is what a card shows for the
      // machine the master's ArgoCD and Vault are talking to.
      const read = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
      expect(read?.tailnetState).toBe("joined");
      expect(readServerTailnet(read?.tailnetJson).kind).toBe("v0");

      // NOT ONE COMPENSATING ACTION WAS ARMED, first contact's two included: every one of them undoes
      // a WORKING slave — and `cluster-redeploy` implements none of them at all, so a step that armed
      // one here would end an abort of this run kind on a name nothing can be resolved against.
      // Taking this manager's only way in off a live slave, or reopening a door that installation
      // deliberately shut, is what the last two would do.
      for (const step of ["install-key", "disable-password-login", "mark-slave", "run-deploy-cluster", "join-if-absent", "create-mgmt"] as const) {
        const cp = JSON.parse(stepColumn(h.db, r.runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
        expect(cp.__cleanups, step).toBeUndefined();
      }

      // AND FIRST CONTACT WROTE NOTHING. The machine came into this run already carrying this
      // manager's key and already refusing passwords, because a deployment put both there — so every
      // one of these steps measured, found its work done and said so. This is the property that lets
      // the same list run against a bare box and against a live slave: a step left out of a list is a
      // step nobody can see was considered, while a step that reports finding nothing to do is a
      // reading. Read off each step's own checkpoint, which is what it wrote down about what it found.
      expect(found(h, r.runId, "generate-key")["generated"]).toBe(false);
      expect(found(h, r.runId, "install-key")["appended"]).toBe(false);
      expect(found(h, r.runId, "enable-ntp")["ntp"]).toBe("already-on");
      expect(found(h, r.runId, "disable-password-login")["wrote"]).toBe(false);
      // …and the machine is byte for byte what it was: no second copy of the key line, and no reload
      // of a live slave's sshd for a state the step had just measured as already correct.
      expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY]);
      expect(h.hosts.log.filter((l) => l.command.includes(">> ~/.ssh/authorized_keys"))).toEqual([]);

      // The SLAVE's row stayed active + single + same ordinal (re-reconciled in place, never
      // re-inserted). The master's own row stands beside it, as boot seeds it on every installation.
      const rows = h.db.db.select().from(clusters).where(eq(clusters.serverId, SLAVE_ID)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.slaveId).toBe(1);
    });

    it("INNOCENT CASE (redeploy, slave arm, machine reset at the provider): the machine holding no address of the private network is joined, and the coordinator's answer reaches its row", { timeout: 300_000 }, async () => {
      // THE MACHINE AN OWNER ACTUALLY REDEPLOYS, and the same rows as the test above: he resets the
      // box at the hosting provider and nothing in this manager moves — the cluster stays active and
      // the server stays healthy, which is the pair that offers Redeploy and offers nothing else.
      // What comes back carries the image's own key and no line of this manager's, a daemon taking a
      // password again, a clock nobody set to synchronise — and a tailnet client on no network at
      // all. That last one is the fact no row states, and the cluster map's `apiHost` is what stands
      // on it: the master's in-cluster components dial the slave's kube-apiserver on the private
      // address the coordinator gave it (deploy-slave.kit.ts slaveApiHost), so a redeploy that joined
      // nothing would commit a map pointing at an address this machine does not hold.
      const h = await liveSlaveWorld(serve(), {
        authorizedKeys: [IMAGE_KEY_LINE],
        passwordLogin: "yes",
        ntp: "no",
        // TWO readings, because this run changes the machine between them: the client of a box that
        // was never logged in, and then the one the join left behind.
        tailnetProbeOut: [TAILNET_PROBE_NOT_JOINED, TAILNET_PROBE_JOINED],
      });

      const r = await h.executor.plan("cluster-redeploy", { serverId: SLAVE_ID });
      expect(r.plan.steps.map((s) => s.name)).toEqual(REDEPLOY_STEP_NAMES);
      await h.executor.approve(r.runId, elevationOnly());
      await h.executor.settle(r.runId);
      // The two steps this machine's whole membership stands between, by their own errors FIRST: a
      // bare status assertion would go red saying only that something did.
      expect(stepColumn(h.db, r.runId, "join-if-absent", "error") ?? "").toBe("");
      expect(stepColumn(h.db, r.runId, "declare-tailnet-address", "error") ?? "").toBe("");
      expect(getRun(h.db.db, r.runId)?.status).toBe("succeeded");

      // WHAT THE STEP READ AND WHAT IT THEN DID: the client said it was on no network, so this run
      // put the machine back on one — the mint on the master and the logout-join-certificate program
      // on the machine, each dry-proven then run on its own record.
      expect(found(h, r.runId, "join-if-absent")).toEqual({ measured: "not-joined", joined: true });
      expectProven(serve(), h.db, r.runId, await observer().runs(), ["tailnet-mint-join-key", "tailnet-rejoin"]);

      // AND THE REGISTRATION OF THE MACHINE'S EARLIER LIFE WENT FIRST. It lives in the coordinator's
      // own database on the master and survives the box being wiped, so a join that left it standing
      // would put a second node under one name — which declare-tailnet-address refuses to choose
      // between, and would refuse this whole run on.
      const master = h.hosts.log.filter((l) => l.host === "m1.example.com").map((l) => l.command);
      expect(master.some((c) => c.includes("nodes delete -i 1 --force"))).toBe(true);

      // AND THE JOIN ARMED NOTHING, although this one really acted. A deployment arms `remove-slave`
      // around its own join, and against a machine whose cluster is live that compensation takes the
      // whole management plane of a working slave down — while `cluster-redeploy` implements no
      // cleanup at all for such a name to be resolved against.
      const cp = JSON.parse(stepColumn(h.db, r.runId, "join-if-absent", "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
      expect(cp.__cleanups).toBeUndefined();

      // The row ends carrying the reading the machine gives NOW and not the one the decision was made
      // on — read-membership runs after whichever of the two acts the step above chose — and the
      // address the manager will dial is the coordinator's own statement of it.
      const server = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
      expect(server?.tailnetState).toBe("joined");
      expect(server?.tailnetHost).toBe("100.64.0.11");
      // First contact put the key back on the way in, which is what every act above travelled over.
      expect(h.hosts.authorizedKeys).toEqual([IMAGE_KEY_LINE, SLAVE_PUBLIC_KEY]);
    });

    it("PLANTED DEFECT (redeploy, slave arm): a machine that will not answer the membership probe is joined by nothing and stops the run, rather than being guessed at either way", { timeout: 300_000 }, async () => {
      // THE ONE CALLER FOR WHICH THE READING IS NOT A SOFT FACT. Everywhere else a host that will not
      // describe its client keeps its stored reading and the run carries on, because the act was
      // already decided. Here the reading IS the decision, and both ways of guessing it are
      // destructive: joining a machine that turns out to be on the network hands a live cluster a
      // fresh address and mints a credential nothing can un-mint, and joining nothing on one that is
      // off it leaves the cluster map naming an address the machine does not hold.
      const h = await liveSlaveWorld(serve(), { tailnetProbeExit: 1 });

      const runId = await settled(h, "cluster-redeploy", { serverId: SLAVE_ID }, elevationOnly());
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      expect(stepColumn(h.db, runId, "join-if-absent", "error")).toMatch(/did not answer the membership probe/);

      // NOTHING WAS MINTED AND NOTHING WAS JOINED: the refusal comes before either machine is asked
      // for anything, so the coordinator still lists exactly what it listed, credential included.
      expectAbsent(h.db, runId, await observer().runs(), ["tailnet-mint-join-key", "tailnet-rejoin"]);
      expect(h.hosts.log.filter((l) => l.command.includes("nodes delete"))).toEqual([]);
      // And the row keeps the reading it had, because a probe that did not run writes none.
      expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.tailnetState).toBe("unknown");
    });
  });
}
