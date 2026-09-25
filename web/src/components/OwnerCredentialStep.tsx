import { useState, type KeyboardEvent } from "react";

interface Props {
  /** Whose credential, as the server measured the need; rendered only while none is recorded. */
  owner: string;
  /** Which credential: the packages reader (with the scopes it must read) or the repository PAT. */
  need: { kind: "packages-reader"; scopes: string[] } | { kind: "repository-pat" };
  /** Records the token as the owner's (measured and sealed server-side); the caller reads the
   *  measurement again afterwards, so this step disappears once the credential stands. */
  onRecord: (owner: string, token: string) => Promise<void>;
  /** What is being onboarded, for the sentence: "The bundle" or "The repository". */
  subject: string;
}

/** THE ONE STEP THAT ASKS FOR AN OWNER'S CREDENTIAL — in the tenant's Add app form (#233) and in the
 *  consumer wizard (#237, #238) alike: shown only while the measurement demands it (a scope routed to
 *  GitHub Packages with no reader recorded; a repository the App does not reach with no PAT
 *  recorded); asked once per owner, shown and replaced under Settings afterwards. The token goes to
 *  the record call and nowhere else.
 *
 *  NOT A FORM (#242): the consumer wizard mounts this step inside its own form, and a submit of a
 *  nested form bubbles to the wizard's, which then posts the onboarding. Record is a plain button,
 *  and Enter in the field records as well. */
export function OwnerCredentialStep({ owner, need, onRecord, subject }: Props) {
  const [token, setToken] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    if (recording || token.trim() === "") return;
    setRecording(true);
    setError(null);
    try {
      await onRecord(owner, token);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecording(false);
    }
  };

  const label = need.kind === "packages-reader" ? `Packages reader of ${owner}` : `Repository PAT of ${owner}`;
  const hint =
    need.kind === "packages-reader"
      ? `${subject} installs private npm packages of ${need.scopes.map((s) => `@${s}`).join(", ")} from GitHub Packages, and ${owner} records no token that reads them yet. Asked once, here: a classic PAT with read:packages, or a fine-grained PAT with Packages: Read for ${owner}.`
      : `The platform's GitHub App does not reach ${subject.toLowerCase()}, and ${owner} records no repository PAT yet. Asked once, here: a classic PAT with repo, workflow and admin:repo_hook, which every repository of ${owner} is onboarded with.`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); // the wizard's form must not submit on this field
    void record();
  };

  return (
    <div className="field">
      <label className="field__label" htmlFor={`owner-credential-${need.kind}`}>
        {label}
      </label>
      <span className="field__hint">
        {hint} Measured against GitHub before it is sealed; only its fingerprint is kept, and it is shown and replaced under Settings afterwards.
      </span>
      <input id={`owner-credential-${need.kind}`} className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={onKeyDown} placeholder="ghp_… or github_pat_…" disabled={recording} />
      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn--primary" disabled={recording || token.trim() === ""} onClick={() => void record()}>
          Record
        </button>
      </div>
    </div>
  );
}
