import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { RunView, ServerView } from "../../../shared/api-types.ts";
import { isMasterRole } from "../../../shared/enums.ts";
import type { ServerStatus } from "../../../shared/enums.ts";
import {
  listServers, listRuns, createServer, deleteServerById, adoptServer, deploySlave, redeploySlave, releaseCluster,
  disconnectTailnet, reconnectTailnet, rejoinTailnet, disablePasswordLogin, enablePasswordLogin,
  readAuthorizedKeys,
} from "../api.ts";
import { tailnetVerbOffer } from "../tailnetState.ts";
import { addressLines } from "../serverDialAddress.ts";
import { OPEN_RUN, relevantRun, runLine } from "../serverRuns.ts";
import { IconShield } from "../components/icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { ClusterReleaseForm } from "../components/ClusterReleaseForm.tsx";
import { SlaveDeployForm } from "../components/SlaveDeployForm.tsx";
import { TailnetActions } from "../components/TailnetActions.tsx";
import { ServerReadings } from "../components/ServerReadings.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// sshUser defaults to "" (not "root"): most hardened boxes disable root SSH login, so the
// operator must name the real non-root sudo user. The placeholder
// hints it; the adopt ceremony then escalates via `sudo -S` with the one-time password.
const EMPTY = { name: "", host: "", tailnetHost: "", sshUser: "", sshPort: "22", password: "" };

/** The slave lifecycle, spelled out (console north star: the operator must see AT A GLANCE
 *  where a server stands and what the ONE next step is). Four stages; every backend status
 *  maps 1:1 onto a stepper position, a plain-language state line, and the next action. The
 *  raw status badge stays on the card — the UI never hides the backend truth; this adds the
 *  orientation around it. */
const LIFECYCLE_STAGES = ["Added", "Adopted", "Deployed", "Live"] as const;
type StageState = "done" | "active" | "todo";
const LIFECYCLE: Record<ServerStatus, { stages: readonly StageState[]; state: string; next: "adopt" | "deploy" | "clusters" | null }> = {
  bare: { stages: ["done", "active", "todo", "todo"], state: "Not adopted yet — the Controller has no SSH key on this box.", next: "adopt" },
  adopting: { stages: ["done", "active", "todo", "todo"], state: "Adoption in progress — the Controller is installing its SSH key.", next: null },
  ready: { stages: ["done", "done", "active", "todo"], state: "Adopted — ready to deploy as a slave.", next: "deploy" },
  provisioning: { stages: ["done", "done", "active", "todo"], state: "Deployment in progress — this server is becoming a slave.", next: null },
  healthy: { stages: ["done", "done", "done", "done"], state: "Live slave — deployed and healthy.", next: "clusters" },
  degraded: { stages: ["done", "done", "done", "active"], state: "Live slave — currently degraded (see Clusters).", next: "clusters" },
  draining: { stages: ["done", "done", "done", "active"], state: "Live slave — draining (being taken out of service).", next: null },
  undeployed: { stages: ["done", "active", "todo", "todo"], state: "Undeployed — adopt it again to redeploy.", next: "adopt" },
};

/** Prefill for the slave FQDN: `<name>.<master-domain>` when the master's host is an FQDN
 *  (the domain IS the install branch), else the operator types it freely. */
function suggestedDomain(name: string, all: ServerView[]): string {
  const master = all.find((s) => isMasterRole(s.role));
  const dot = master?.host.indexOf(".") ?? -1;
  return master && dot > 0 ? `${name}.${master.host.slice(dot + 1)}` : "";
}

/** Inventory CRUD: add servers with an optional stored password on
 *  one page, then adopt or delete straight from the list. The password is sealed keyfile-
 *  encrypted server-side; it never returns to the browser after it's stored. */
export function Servers() {
  const nav = useNavigate();
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  // Bumped on a successful add to REMOUNT the form. React-controlled inputs keep their
  // browser :user-invalid state after a submit, so the freshly-emptied required fields
  // would otherwise render red — looking like a phantom re-submit. A new key = fresh,
  // untouched inputs, no red.
  const [formKey, setFormKey] = useState(0);
  // The open deploy mini-form (one at a time): serverId + the two Run params.
  const [prov, setProv] = useState<{ id: string; domain: string; stage: string } | null>(null);
  // The open release mini-form (one at a time). The operator names version + channel and nothing
  // else: which cluster the release lands on, and the stage its channel is checked against, are what
  // the server's own cluster row and cluster map already state.
  const [rel, setRel] = useState<{ id: string; version: string; channel: string } | null>(null);
  // The server pending a delete confirmation (ConfirmDialog replaces window.confirm).
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  function refresh(): void {
    listServers()
      .then((r) => setServers(r.servers))
      .catch((e: unknown) => setError(msg(e)));
    // The runs list enriches each card with its open/failed run — the "what's next" pointer.
    listRuns()
      .then(setRuns)
      .catch((e: unknown) => setError(msg(e)));
  }
  useEffect(refresh, []);

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createServer({
        name: form.name.trim(),
        host: form.host.trim(),
        sshUser: form.sshUser.trim(),
        sshPort: Number(form.sshPort) || 22,
        ...(form.tailnetHost.trim() ? { tailnetHost: form.tailnetHost.trim() } : {}),
        ...(form.password ? { password: form.password } : {}),
      });
      setForm({ ...EMPTY });
      setFormKey((k) => k + 1);
      refresh();
    } catch (err) {
      setError(msg(err));
    }
    setBusy(false);
  }

  async function doAdopt(id: string): Promise<void> {
    setError(null);
    try {
      const { runId } = await adoptServer(id);
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function doDeploy(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!prov) return;
    setError(null);
    try {
      const { runId } = await deploySlave(prov.id, { stage: prov.stage, domain: prov.domain.trim() });
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  /** Plan one of the per-server verbs and hand off to its Run screen — the three tailnet repairs,
   *  the two password-login acts and the authorized-keys reading all take the same one argument and
   *  differ only in which client helper is called, so they share this. */
  async function planServerVerb(plan: () => Promise<{ runId: string }>): Promise<void> {
    setError(null);
    try {
      const { runId } = await plan();
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function doRedeploy(id: string): Promise<void> {
    setError(null);
    try {
      const { runId } = await redeploySlave(id);
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function doRelease(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!rel) return;
    setError(null);
    try {
      const { runId } = await releaseCluster(rel.id, { version: rel.version.trim(), channel: rel.channel });
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function doDelete(id: string): Promise<void> {
    setError(null);
    try {
      await deleteServerById(id);
      refresh();
    } catch (err) {
      setError(msg(err));
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Servers</h2>
          <p className="page__desc">The inventory this controller can reach over SSH.</p>
        </div>
        <div className="page__actions">
          <Link className="btn" to="/servers/keys">
            Operator keys
          </Link>
          <Link className="btn" to="/servers/adopt">
            Adoption wizard
          </Link>
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      <form key={formKey} className="card" onSubmit={add}>
        <h3 className="form-card__title">Add a server</h3>
        <div className="form-grid form-grid--servers">
          <label className="field">
            <span className="field__label">Name</span>
            <input value={form.name} onChange={set("name")} placeholder="s1" pattern="[a-z0-9][a-z0-9-]*" required />
          </label>
          <label className="field">
            <span className="field__label">Host</span>
            <input value={form.host} onChange={set("host")} placeholder="203.0.113.7" required />
          </label>
          <label className="field">
            <span className="field__label">Tailnet address <em className="field__opt">optional</em></span>
            <input value={form.tailnetHost} onChange={set("tailnetHost")} placeholder="100.64.0.11" />
          </label>
          <label className="field">
            <span className="field__label">SSH user</span>
            <input value={form.sshUser} onChange={set("sshUser")} placeholder="hostyour1" required />
          </label>
          <label className="field">
            <span className="field__label">Port</span>
            <input value={form.sshPort} onChange={set("sshPort")} placeholder="22" inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field__label">
              Password <em className="field__opt">optional</em>
            </span>
            <input value={form.password} onChange={set("password")} type="password" placeholder="stored encrypted" autoComplete="off" />
          </label>
        </div>
        <div className="form-foot">
          <span className="field__hint">
            The tailnet address is where the master dials this machine&apos;s kube-apiserver once it is a slave; empty means
            the host above goes in the cluster map instead. A stored password enables 1-click adopt; it is sealed AES-256-GCM at rest.
          </span>
          <button type="submit" className="btn btn--primary" disabled={busy || !form.name || !form.host}>
            {busy ? "Adding…" : "Add server"}
          </button>
        </div>
      </form>

      {!servers ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Loading servers…
        </div>
      ) : servers.length === 0 ? (
        <div className="empty">
          <p>No servers yet — add one above.</p>
        </div>
      ) : (
        <ul className="cards">
          {servers.map((s) => {
            // The ONE run that concerns this server (serverRuns.ts), read per CARD and not inside
            // the lifecycle block below: the lifecycle renders for slaves only, while every card
            // now carries verbs of its own — a planned password-login run on the MASTER, or a failed
            // one, would otherwise be surfaced nowhere at all, there being no global runs list.
            const run = relevantRun(s.id, runs);
            const runIsOpen = run !== undefined && OPEN_RUN.includes(run.status);
            return (
              <li key={s.id} className="card servercard">
                <div className="card__head">
                  <strong className="servercard__name">{s.name}</strong>
                  <span className={`badge badge--${s.status}`}>{s.status}</span>
                </div>
                {/* Two addresses, two jobs, said apart: where THIS controller opens its SSH
                    session, and where the master's ArgoCD, Vault, dashboard and kube client dial
                    the slave's kube-apiserver. Printing only the first is what made a wrong second
                    address read as a network fault; the second is absent on a master, which is the
                    machine doing the dialling and never the one dialled (serverDialAddress.ts). */}
                {addressLines(s).map((line) => <div key={line} className="servercard__target">{line}</div>)}
                {/* The three READINGS beside the status badge — private network, password door, and
                    who is in authorized_keys — plus the verbs that act on the last two. Their own
                    component, and rendered for the master too: none of them is a position in the
                    slave lifecycle below. */}
                <ServerReadings
                  server={s}
                  now={Date.now()}
                  onDisablePasswordLogin={() => void planServerVerb(() => disablePasswordLogin(s.id))}
                  onEnablePasswordLogin={() => void planServerVerb(() => enablePasswordLogin(s.id))}
                  onReadAuthorizedKeys={() => void planServerVerb(() => readAuthorizedKeys(s.id))}
                />
                {run && (
                  <p className="servercard__run">
                    <Link to={`/runs/${run.id}`}>{runLine(run)} →</Link>
                  </p>
                )}
                {!isMasterRole(s.role) &&
                  (() => {
                    const lc = LIFECYCLE[s.status];
                    // ONE prominent next step: an open run owns it (approve/watch); otherwise
                    // the status decides (adopt → deploy → view live).
                    const showAdopt = !runIsOpen && lc.next === "adopt";
                    const showDeploy = !runIsOpen && lc.next === "deploy" && prov?.id !== s.id;
                    const showClusters = lc.next === "clusters";
                    // A LIVE cluster carries the two verbs that act on one: redeploy rebuilds its
                    // machine layer in place at the release it already stands on, release raises that
                    // release. Both are distinct from the destructive Delete.
                    const showRedeploy = lc.next === "clusters";
                    const showRelease = lc.next === "clusters" && rel?.id !== s.id;
                    const showDelete = s.status === "bare";
                    // The tailnet repair verbs are offered on their own rule (tailnetState.ts), not
                    // on the lifecycle: they act on the host's membership of the private network,
                    // which is the second axis this card carries beside its status.
                    const tnv = tailnetVerbOffer(s, { liveCluster: lc.next === "clusters" });
                    return (
                      <>
                        <ol className="lifecycle" aria-label="Server lifecycle">
                          {LIFECYCLE_STAGES.map((label, i) => (
                            <li key={label} className={`lifecycle__stage lifecycle__stage--${lc.stages[i] ?? "todo"}`}>
                              <span className="lifecycle__dot" aria-hidden="true">
                                {lc.stages[i] === "done" ? "✓" : ""}
                              </span>
                              {label}
                            </li>
                          ))}
                        </ol>
                        <p className="servercard__state">{lc.state}</p>
                        {(showAdopt || showDeploy || showClusters || showRedeploy || showRelease || showDelete ||
                          tnv.disconnect || tnv.reconnect || tnv.rejoin) && (
                          <div className="actions">
                            {showAdopt && (
                              <button type="button" className="btn btn--primary" onClick={() => void doAdopt(s.id)}>
                                {s.hasPassword ? "Adopt this server" : "Adopt this server (enter password)"}
                              </button>
                            )}
                            {showDeploy && (
                              <button
                                type="button"
                                className="btn btn--primary"
                                onClick={() => setProv({ id: s.id, domain: suggestedDomain(s.name, servers), stage: "prod" })}
                              >
                                Deploy this slave
                              </button>
                            )}
                            {showClusters && (
                              <Link className="btn" to="/">
                                View the live slave (Clusters)
                              </Link>
                            )}
                            {showRedeploy && (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => void doRedeploy(s.id)}
                                title="Rebuild the machine layer in place (idempotent), at the release this cluster already stands on — no version change. Brief kube-apiserver blip while kubelite restarts."
                              >
                                Redeploy
                              </button>
                            )}
                            {showRelease && (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => setRel({ id: s.id, version: "", channel: "stable" })}
                                title="Raise the platform version this cluster stands on: pin the cluster map to the release, re-run the installer over SSH, then wait for ArgoCD."
                              >
                                Release
                              </button>
                            )}
                            <TailnetActions
                              offer={tnv}
                              onDisconnect={() => void planServerVerb(() => disconnectTailnet(s.id))}
                              onReconnect={() => void planServerVerb(() => reconnectTailnet(s.id))}
                              onRejoin={() => void planServerVerb(() => rejoinTailnet(s.id))}
                            />
                            {showDelete && (
                              <button type="button" className="btn btn--danger" onClick={() => setDeleteTarget({ id: s.id, name: s.name })}>
                                Delete
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                {prov?.id === s.id && (
                  <SlaveDeployForm
                    value={prov}
                    placeholderName={s.name}
                    onChange={(next) => setProv({ ...prov, ...next })}
                    onSubmit={doDeploy}
                    onCancel={() => setProv(null)}
                  />
                )}
                {rel?.id === s.id && (
                  <ClusterReleaseForm
                    value={rel}
                    onChange={(next) => setRel({ ...rel, ...next })}
                    onSubmit={doRelease}
                    onCancel={() => setRel(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="note">
        <IconShield />
        <span>
          A stored password is used once to install a dedicated SSH key, then the Controller uses the key. Passwords are
          sealed AES-256-GCM at rest (keyfile mode) — a DB dump alone won&apos;t reveal them, and a successful adoption
          destroys the stored copy and turns the server&apos;s own password login off.
        </span>
      </p>

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete server "${deleteTarget.name}"?`}
          confirmLabel="Delete server"
          destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const t = deleteTarget;
            setDeleteTarget(null);
            void doDelete(t.id);
          }}
        >
          <p>Its stored credentials are purged and it leaves the inventory.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
