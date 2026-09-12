import { useState, useEffect, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { ChannelStagesView, OnboardPrefillView } from "../../../shared/api-types.ts";
import type { Stage } from "../../../shared/enums.ts";
import { listOnboardTargets, getChannelStages, onboardConsumer, prefillOnboard, type OnboardTargetView } from "../api.ts";
import { RELEASE_VERSION_RE } from "../../../shared/release.ts";

/** The version grammar as an HTML `pattern` (implicitly anchored, so the RegExp's own ^/$ anchors are
 *  stripped) — the SAME regex the server enforces (shared/release.ts), never a second hand-kept copy. */
const VERSION_PATTERN = RELEASE_VERSION_RE.source.replace(/^\^/, "").replace(/\$$/, "");

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Onboard wizard: point the Manager at an external GitHub repo, name the release the run
 *  will TRIGGER (version + channel — the repo's release script mints the tag), state the unit's OWN
 *  stage, and pick where it lands: any active cluster for a unit that deploys itself, nothing more
 *  for a build-only unit. The stage is the unit's, not the cluster's: the namespace `<name>-<stage>`,
 *  the host `<label>.<stage apex>` (the manifest's `host`, or the name; prod is the apex itself), the registration `registrations/<name>/<stage>.yaml` and the
 *  Vault path all follow it, and the channel table says which stages a channel may reach. The heavy
 *  lifting (the gates, the registration, the kit injection, the triggered release cycle and its
 *  watches) is the onboard Run; this screen only gathers the request. */

/** Derive a consumer name from a repo URL: the last path segment minus a trailing `.git`, lowercased
 *  and squeezed to a DNS-1123 label (what the consumer name must be). E.g.
 *  "https://github.com/acme/app.git" → "app". */
function deriveConsumerName(repoURL: string): string {
  const last =
    repoURL
      .trim()
      .replace(/\.git\/?$/i, "")
      .replace(/\/+$/, "")
      .split("/")
      .pop() ?? "";
  return last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function ConsumerOnboard() {
  const nav = useNavigate();
  const [form, setForm] = useState({ consumerName: "", repoURL: "", version: "", channel: "", stage: "", clusterId: "", owner: "", chartPath: "deploy/chart" });
  // Deployable (the manifest declares a chart → pick a cluster) vs build-only (no chart → the stage
  // alone says where the one triggered release run puts the release). The server checks the choice
  // against the manifest's own shape.
  const [buildOnly, setBuildOnly] = useState(false);
  const [repoPat, setRepoPat] = useState("");
  const [targets, setTargets] = useState<OnboardTargetView[] | null>(null);
  // The channel table, read from the config route — platform/values-common.yaml global.channelStages
  // verbatim. Which channels exist and which stages each admits comes from HERE, never a local copy.
  const [channels, setChannels] = useState<ChannelStagesView["channelStages"] | null>(null);
  // What the repository itself said when it was read (POST /api/consumers/prefill): the version and
  // the channel, each with its source, so the hint under the field names where the number came from.
  const [prefill, setPrefill] = useState<OnboardPrefillView | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The consumer name defaults to the repo name (auto-derived) until the operator edits it by hand;
  // after that we stop overwriting their value.
  const [nameEdited, setNameEdited] = useState(false);

  useEffect(() => {
    listOnboardTargets()
      .then((t) => setTargets(t))
      .catch((e: unknown) => setError(msg(e)));
    getChannelStages()
      .then((v) => setChannels(v.channelStages))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Repo drives the consumer name until the operator overrides it; typing in the name field marks it edited.
  const onRepo = (e: ChangeEvent<HTMLInputElement>): void => {
    const repoURL = e.target.value;
    setForm((f) => ({ ...f, repoURL, ...(nameEdited ? {} : { consumerName: deriveConsumerName(repoURL) }) }));
  };
  const onName = (e: ChangeEvent<HTMLInputElement>): void => {
    setNameEdited(true);
    setForm((f) => ({ ...f, consumerName: e.target.value }));
  };

  // Read the version and the channel off the repository. The PAT goes over once, is sealed for the one
  // clone and purged again server-side; what comes back is a number and the place it was read from.
  async function readRepository(): Promise<void> {
    setReading(true);
    setError(null);
    try {
      const chartPath = form.chartPath.trim();
      const view = await prefillOnboard({ repoURL: form.repoURL.trim(), repoPat: repoPat.trim(), ...(chartPath ? { chartPath } : {}) });
      setPrefill(view);
      setForm((f) => ({ ...f, version: view.version, channel: view.channel, stage: "" }));
    } catch (err) {
      setError(msg(err));
    } finally {
      setReading(false);
    }
  }

  // The stages the chosen channel admits — the plan holds the same ceiling (assertChannelReaches) at
  // the point that writes; the wizard only offers what would pass. No channel chosen yet ⇒ nothing to offer.
  const admittedStages = form.channel ? (channels?.[form.channel as keyof NonNullable<typeof channels>] ?? []) : [];
  // Deployable form: every ACTIVE cluster — the unit's stage is its own, whatever the cluster's is.
  const activeTargets = (targets ?? []).filter((t) => t.status === "active");

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { runId } = await onboardConsumer({
        consumerName: form.consumerName.trim(),
        repoURL: form.repoURL.trim(),
        version: form.version.trim(),
        channel: form.channel as "alpha" | "beta" | "stable",
        stage: form.stage as Stage,
        ...(buildOnly ? {} : { clusterId: form.clusterId }),
        owner: form.owner.trim(),
        ...(form.chartPath.trim() ? { chartPath: form.chartPath.trim() } : {}),
        repoPat: repoPat.trim(),
      });
      nav(`/runs/${runId}`); // the Run screen streams the live gate report + the approve card
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  }

  const noTargets = targets !== null && activeTargets.length === 0;
  const targetChosen = buildOnly || form.clusterId !== "";
  const canRead = form.repoURL.trim() !== "" && repoPat.trim() !== "" && !reading && !busy;
  const namespace = form.consumerName && form.stage ? `${form.consumerName}-${form.stage}` : "<name>-<stage>";

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <span className="page__eyebrow">Onboard · step 1 of 2</span>
          <h2 className="page__title">Onboard a consumer app</h2>
        </div>
      </header>

      <p className="callout">
        Point the Manager at an external GitHub repository, read the release it states, and name the stage the unit
        stands at. The run checks the repo against the gates, writes the registration, injects the release kit and the
        webhook, and then triggers the release cycle ONCE through the injected workflow — the first deployment comes out
        of that cycle. You see every gate result and approve on the next screen before anything is written.
      </p>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}
      {noTargets && !buildOnly && (
        <p role="alert" className="alert alert--warn">
          No active clusters to onboard to yet — deploy a slave (or bring the master up) first.
        </p>
      )}

      <form className="card wizard-card" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Repository URL</span>
            <input value={form.repoURL} onChange={onRepo} placeholder="https://github.com/acme/app.git" required />
            <span className="field__hint">
              The repository name IS the unit: the manifest&apos;s name, the chart&apos;s name and the consumer name below must all
              equal it (G1).
            </span>
          </label>
          <label className="field">
            <span className="field__label">Repository PAT</span>
            <input type="password" value={repoPat} onChange={(e) => setRepoPat(e.target.value)} placeholder="github_pat_…" autoComplete="off" required />
            <span className="field__hint">
              The one GitHub PAT for this consumer (repo + workflow + admin:repo_hook + read:packages). The Manager seals it, clones
              and pushes with it, and seeds it for the unit&apos;s build — it never appears in logs or the sandbox.
            </span>
          </label>
          <div className="field">
            <span className="field__label">Read from repository</span>
            <button type="button" className="btn" disabled={!canRead} onClick={() => void readRepository()}>
              {reading ? "Reading…" : "Read version and channel"}
            </button>
            <span className="field__hint">
              Clones the repository once with the PAT and fills in the version it states (package.json, else the chart&apos;s
              appVersion) — you confirm a number instead of typing one.
            </span>
          </div>
          <label className="field">
            <span className="field__label">Consumer name</span>
            <input value={form.consumerName} onChange={onName} placeholder="acme" pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" required />
            <span className="field__hint">
              Lowercase DNS label — the chart name and the registration directory; the namespace is <code>{namespace}</code>.
              Defaults to the repo name, editable.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Version</span>
            <input value={form.version} onChange={set("version")} placeholder="0.1.0" pattern={VERSION_PATTERN} required />
            <span className="field__hint">
              {prefill ? <>Read from {prefill.versionSource}. </> : null}
              x.y.z, no leading zeros. The repo&apos;s release script mints the full tag{" "}
              <code>{"<version>-<channel>-<timestamp>"}</code> from it — or reuses the existing tag of this
              version+channel, so re-running never rebuilds.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Channel</span>
            <select value={form.channel} onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value, stage: "" }))} required>
              <option value="" disabled>
                {channels === null ? "Loading…" : "Choose a channel"}
              </option>
              {Object.entries(channels ?? {}).map(([channel, stages]) => (
                <option key={channel} value={channel}>
                  {channel} → {stages.join(", ")}
                </option>
              ))}
            </select>
            <span className="field__hint">
              {prefill ? <>Channel {prefill.channelSource}. </> : null}
              The channel is the release&apos;s maturity ceiling — the table comes from the platform&apos;s
              values file, and the plan refuses a stage the channel does not reach.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Stage</span>
            <select value={form.stage} onChange={set("stage")} required>
              <option value="" disabled>
                {form.channel === "" ? "Choose a channel first" : "Choose a stage"}
              </option>
              {admittedStages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="field__hint">
              The unit&apos;s OWN stage — its namespace, host, registration file and Vault path all carry it, whatever cluster it
              lands on. Only the stages the chosen channel admits are offered.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Form</span>
            <select value={buildOnly ? "build-only" : "deployable"} onChange={(e) => setBuildOnly(e.target.value === "build-only")}>
              <option value="deployable">Deploys itself (manifest declares a chart)</option>
              <option value="build-only">Build-only (no chart — deployed elsewhere)</option>
            </select>
            <span className="field__hint">Checked against the manifest: a repo with a chart needs a target cluster, one without gets only its build.</span>
          </label>
          {!buildOnly && (
            <label className="field">
              <span className="field__label">Target cluster</span>
              <select value={form.clusterId} onChange={set("clusterId")} required>
                <option value="" disabled>
                  {targets === null ? "Loading…" : "Choose a cluster"}
                </option>
                {activeTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.domain} (platform {t.stage})
                  </option>
                ))}
              </select>
              <span className="field__hint">Any active cluster. The stage in brackets is the platform&apos;s own, not the unit&apos;s.</span>
            </label>
          )}
          <label className="field">
            <span className="field__label">Owner</span>
            <input value={form.owner} onChange={set("owner")} placeholder="team-acme" required />
          </label>
          {!buildOnly && (
            <label className="field">
              <span className="field__label">
                Chart path <em className="field__opt">optional</em>
              </span>
              <input value={form.chartPath} onChange={set("chartPath")} placeholder="deploy/chart" />
              <span className="field__hint">Defaults to the contract&apos;s deploy/chart.</span>
            </label>
          )}
        </div>

        <div className="form-foot">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              busy ||
              reading ||
              (!buildOnly && noTargets) ||
              !form.consumerName ||
              !form.repoURL ||
              !form.version ||
              !form.channel ||
              !form.stage ||
              !targetChosen ||
              !form.owner ||
              !repoPat.trim()
            }
          >
            {busy ? "Validating…" : "Validate & plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
