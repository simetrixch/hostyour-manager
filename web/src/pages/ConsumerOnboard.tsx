import { useState, useEffect, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { ChannelStagesView, OnboardPrefillView } from "../../../shared/api-types-onboard.ts";
import type { Stage } from "../../../shared/enums.ts";
import { listOnboardTargets, getChannelStages, onboardConsumer, prefillOnboard, recordOwnerCredential, type OnboardTargetView } from "../api.ts";
import { OwnerCredentialStep } from "../components/OwnerCredentialStep.tsx";
import { DEFAULT_UNIT_SIZE, UNIT_SIZE, type UnitSize } from "#unit/shared/unit-size.ts";

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
  const [form, setForm] = useState({ consumerName: "", repoURL: "", channel: "", stage: "", clusterId: "", owner: "", chartPath: "deploy/chart", size: DEFAULT_UNIT_SIZE as string });
  // Deployable (the manifest declares a chart → pick a cluster) vs build-only (no chart → the stage
  // alone says where the one triggered release run puts the release). The server checks the choice
  // against the manifest's own shape.
  const [buildOnly, setBuildOnly] = useState(false);
  const [targets, setTargets] = useState<OnboardTargetView[] | null>(null);
  // The channel table, read from the config route — platform/values-common.yaml global.channelStages
  // verbatim. Which channels exist and which stages each admits comes from HERE, never a local copy.
  const [channels, setChannels] = useState<ChannelStagesView["channelStages"] | null>(null);
  // What the repository itself said when it was read (POST /api/consumers/prefill): the version and
  // the channel, each with its source, so the hint under the field names where the number came from.
  const [prefill, setPrefill] = useState<OnboardPrefillView | null>(null);
  /** The URL `prefill` answers for — a blur on an unchanged URL reads nothing again. */
  const [readURL, setReadURL] = useState("");
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

  // The check under the repository field: the owner's identity lists the repository's release
  // tags once and is not kept; what comes back is the version the onboarding will release, the place
  // it was read from, and which identity it is (#220). It runs when the URL field is left as well
  // (#242): every consumer is a foreign repository, so the owner's PAT — asked for by this check where
  // none is recorded — is wanted as soon as the URL names the owner, not after a further click.
  async function readRepository(): Promise<void> {
    if (!canRead) return;
    setReading(true);
    setError(null);
    try {
      const view = await prefillOnboard({ repoURL: form.repoURL.trim() });
      setPrefill(view);
      setReadURL(form.repoURL.trim());
      setForm((f) => ({ ...f, channel: view.channel, stage: "" }));
    } catch (err) {
      setError(msg(err));
    } finally {
      setReading(false);
    }
  }

  // THE PACKAGES READER IS ASKED FOR WHERE THE CHECK DEMANDS IT (#237): recorded as the owner's, then
  // the repository is read again so the step disappears and the onboarding can be submitted.
  const readerMissing = prefill?.packagesReader !== undefined && prefill.packagesReader.recorded === null;
  const recordPackagesReader = async (owner: string, token: string): Promise<void> => {
    await recordOwnerCredential(owner, "packages-reader", token);
    setPrefill(await prefillOnboard({ repoURL: form.repoURL.trim() }));
  };
  // THE REPOSITORY PAT IS ASKED FOR WHERE THE APP DOES NOT REACH (#238): the check answers no
  // identity and names the owner; recorded, the repository is read again with it.
  const patMissing = prefill?.identity === "none" && prefill.repositoryPat !== undefined && prefill.repositoryPat.recorded === null;
  const recordRepositoryPat = async (owner: string, token: string): Promise<void> => {
    await recordOwnerCredential(owner, "repository-pat", token);
    setPrefill(await prefillOnboard({ repoURL: form.repoURL.trim() }));
  };

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
        channel: form.channel as "alpha" | "beta" | "stable",
        stage: form.stage as Stage,
        ...(buildOnly ? {} : { clusterId: form.clusterId }),
        owner: form.owner.trim(),
        ...(form.chartPath.trim() ? { chartPath: form.chartPath.trim() } : {}),
        size: form.size as UnitSize,
      });
      nav(`/runs/${runId}`); // the Run screen streams the live gate report + the approve card
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  }

  const noTargets = targets !== null && activeTargets.length === 0;
  const targetChosen = buildOnly || form.clusterId !== "";
  const canRead = form.repoURL.trim() !== "" && !reading && !busy;
  /** Leaving the URL field reads the repository, unless the URL is the one already read. */
  const onRepoBlur = (): void => {
    if (prefill !== null && form.repoURL.trim() === readURL) return;
    void readRepository();
  };
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
            <input value={form.repoURL} onChange={onRepo} onBlur={onRepoBlur} placeholder="https://github.com/acme/app.git" required />
            <span className="field__hint">
              The repository name IS the unit: the manifest&apos;s name, the chart&apos;s name and the consumer name below must all
              equal it (G1).
            </span>
          </label>
          <div className="field">
            <span className="field__label">Check the repository</span>
            <button type="button" className="btn" disabled={!canRead} onClick={() => void readRepository()}>
              {reading ? "Checking…" : "Check the repository"}
            </button>
            <span className="field__hint">
              A check, not a step of the onboarding: lists the repository&apos;s release tags with the identity the
              onboarding will run with — the owner&apos;s, by the owner of the URL: the platform&apos;s GitHub App where it
              reaches the repository, else the owner&apos;s repository PAT — so that identity is proven to read the repository,
              and shows the version the onboarding will release under Version. It runs when the URL field is left, and again on
              this button. Where the App does not reach the repository, the owner&apos;s repository PAT is asked for below, once;
              where the repository installs private npm packages, the owner&apos;s packages reader likewise. Nothing is cloned
              and nothing is kept.
              {prefill ? ` Identity: ${prefill.identity === "github-app" ? "the platform's GitHub App" : prefill.identity === "pat" ? "the owner's repository PAT" : "none yet — the owner's repository PAT is asked for below"}.` : ""}
            </span>
          </div>
          {patMissing && prefill?.repositoryPat && (
            <OwnerCredentialStep owner={prefill.repositoryPat.owner} need={{ kind: "repository-pat" }} onRecord={recordRepositoryPat} subject="The repository" />
          )}
          {readerMissing && prefill?.packagesReader && (
            <OwnerCredentialStep owner={prefill.packagesReader.owner} need={{ kind: "packages-reader", scopes: prefill.packagesReader.scopes }} onRecord={recordPackagesReader} subject="The repository" />
          )}
          <label className="field">
            <span className="field__label">Consumer name</span>
            <input value={form.consumerName} onChange={onName} placeholder="acme" pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" required />
            <span className="field__hint">
              Lowercase DNS label — the chart name and the registration directory; the namespace is <code>{namespace}</code>.
              Defaults to the repo name, editable.
            </span>
          </label>
          <div className="field">
            <span className="field__label">Version</span>
            <span className="field__hint">
              {prefill?.version ? (
                <>
                  <code>{prefill.version}</code> — {prefill.versionSource}.{" "}
                </>
              ) : null}
              Not typed: the Manager reads the next number after the repository&apos;s release tags when the
              onboarding is planned, and the repo&apos;s release script mints{" "}
              <code>{"<version>-<channel>-<timestamp>"}</code> from it, so what the gates validated is what the
              release builds.
            </span>
          </div>
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
              <span className="field__label">Size</span>
              <select value={form.size} onChange={set("size")} required>
                {UNIT_SIZE.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span className="field__hint">
                The ceiling the unit&apos;s namespace gets — your answer, never the manifest&apos;s. A unit that brings database units
                of its own (postgresql among its services, or a mongodb mode other than shared) may not stand at {DEFAULT_UNIT_SIZE}:
                gate G24 refuses it. What each size means on this installation is the size table.
              </span>
            </label>
          )}
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
              readerMissing ||
              patMissing ||
              (!buildOnly && noTargets) ||
              !form.consumerName ||
              !form.repoURL ||
              !form.channel ||
              !form.stage ||
              !targetChosen ||
              !form.owner
            }
          >
            {busy ? "Validating…" : "Validate & plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
