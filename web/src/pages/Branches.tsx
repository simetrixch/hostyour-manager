import { useEffect, useState } from "react";
import type { BranchesView, BranchDiffView, BranchView, BranchDiffFileView } from "../../../shared/api-types.ts";
import { getBranches, getBranchDiff } from "../api.ts";
import { IconChevronRight } from "../components/icons.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Fixed presentation order: the baseline first, then the manager, then the slaves, then the rest. */
const KIND_ORDER: Record<BranchView["kind"], number> = { master: 0, manager: 1, slave: 2, other: 3 };

/** The kind chip: what this branch IS to the platform (derived server-side, never guessed here). */
const KIND_CHIP: Record<BranchView["kind"], { label: string; className: string }> = {
  master: { label: "master · baseline", className: "chip" },
  manager: { label: "manager", className: "chip chip--warn" },
  slave: { label: "slave", className: "chip chip--ok" },
  other: { label: "branch", className: "chip" },
};

/** One patch line, coloured like a real diff: + green, − red, @@ hunk headers blue. GitHub's
 *  per-file patch has no ---/+++ headers, so the prefix test is unambiguous. */
function patchLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff__line diff__line--hunk";
  if (line.startsWith("+")) return "diff__line diff__line--add";
  if (line.startsWith("-")) return "diff__line diff__line--del";
  return "diff__line";
}

function DiffFileRow({ file, open, onToggle }: { file: BranchDiffFileView; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" className="diff__file" onClick={onToggle} aria-expanded={open}>
        <span className={open ? "diff__chevron diff__chevron--open" : "diff__chevron"} aria-hidden="true">
          <IconChevronRight size={14} />
        </span>
        <span className="diff__name">{file.filename}</span>
        <span className="diff__status">{file.status}</span>
        <span className="diff__stat">
          <span className="diff__add">+{file.additions}</span>
          <span className="diff__del">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.patch !== undefined ? (
          <pre className="diff__patch">
            {file.patch.split("\n").map((line, i) => (
              <div key={i} className={patchLineClass(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        ) : (
          <p className="diff__nopatch">
            GitHub sent no patch for this file (binary, too large, or capped by the server) — only the counts above are known.
          </p>
        ))}
    </li>
  );
}

/** Read-only view of every branch in the GitOps repo, diffed against master. Deleting
 *  branches deliberately does NOT live here — that is the Reset wizard's job. */
export function Branches() {
  const [data, setData] = useState<BranchesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // the one expanded branch
  const [diffs, setDiffs] = useState<Record<string, BranchDiffView>>({}); // loaded-once cache
  const [diffError, setDiffError] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<ReadonlySet<string>>(new Set()); // "<branch>:<file>"

  function load(): void {
    setError(null);
    getBranches()
      .then((d) => {
        setData(d);
        // a reset (or a push) changes shas — drop any cached diffs so we never show stale ones.
        setDiffs({});
        setOpen(null);
        setOpenFiles(new Set());
      })
      .catch((e: unknown) => setError(msg(e)));
  }

  useEffect(() => {
    let alive = true;
    getBranches()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(msg(e)));
    return () => {
      alive = false;
    };
  }, []);

  function toggleBranch(b: BranchView): void {
    if (b.kind === "master") return; // the baseline — there is nothing to compare it against
    const next = open === b.name ? null : b.name;
    setOpen(next);
    setDiffError(null);
    if (next !== null && !(next in diffs)) {
      getBranchDiff(next)
        .then((d) => setDiffs((prev) => ({ ...prev, [d.name]: d })))
        .catch((e: unknown) => setDiffError(msg(e)));
    }
  }

  function toggleFile(branch: string, filename: string): void {
    const key = `${branch}:${filename}`;
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (error)
    return (
      <section className="page">
        <header className="page__head">
          <div>
            <h2 className="page__title">Branches</h2>
          </div>
          <button type="button" className="btn" onClick={load}>
            Retry
          </button>
        </header>
        <p role="alert" className="alert alert--danger">
          Could not load the branches: {error}
        </p>
      </section>
    );
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading branches…
      </div>
    );

  const branches = [...data.branches].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Branches</h2>
          <p className="page__desc">
            Every branch in <span className="mono">{data.repo}</span>, compared against master — one install branch per
            machine. Read-only: deleting branches lives in Reset.
          </p>
        </div>
        <button type="button" className="btn" onClick={load}>
          Refresh
        </button>
      </header>

      <ul className="rows">
        {branches.map((b) => {
          const isOpen = open === b.name;
          const diff = diffs[b.name];
          const chip = KIND_CHIP[b.kind];
          return (
            <li key={b.name}>
              {b.kind === "master" ? (
                <div className="row">
                  <span className="branch__name">{b.name}</span>
                  <span className={chip.className}>{chip.label}</span>
                  <span className="row__meta">the source every install branch is compared against</span>
                </div>
              ) : (
                <button type="button" className="row row--btn" onClick={() => toggleBranch(b)} aria-expanded={isOpen}>
                  <span className="branch__name">{b.name}</span>
                  <span className={chip.className}>{chip.label}</span>
                  {b.compare && b.compare.behindBy > 0 && (
                    <span className="chip chip--warn">{b.compare.behindBy} behind master</span>
                  )}
                  <span className="row__meta">
                    {b.compare
                      ? `${b.compare.aheadBy} ahead · ${b.compare.behindBy} behind · ${b.compare.changedFiles} ${b.compare.changedFiles === 1 ? "file" : "files"} changed${b.compare.truncated ? " (300+)" : ""}`
                      : "not an install branch — compared on open"}
                  </span>
                  <span className="row__end">
                    <span className={isOpen ? "row__chevron branch__chevron--open" : "row__chevron"} aria-hidden="true">
                      <IconChevronRight />
                    </span>
                  </span>
                </button>
              )}
              {isOpen && (
                <div className="diffpanel">
                  {diffError !== null ? (
                    <p role="alert" className="alert alert--danger">
                      Could not load the diff: {diffError}
                    </p>
                  ) : !diff ? (
                    <div className="loading">
                      <span className="spinner" aria-hidden="true" />
                      Comparing master…{b.name}
                    </div>
                  ) : (
                    <>
                      <p className="diffpanel__meta">
                        <span className="mono">master…{diff.name}</span>
                        <span>
                          {diff.aheadBy} {diff.aheadBy === 1 ? "commit" : "commits"} ahead · {diff.behindBy} behind
                        </span>
                      </p>
                      {diff.truncated && (
                        <p role="alert" className="alert alert--danger">
                          GitHub capped this comparison at 300 files — the list below is incomplete.
                        </p>
                      )}
                      {diff.files.length === 0 ? (
                        <p className="diff__nopatch">No file differences — this branch is identical to master.</p>
                      ) : (
                        <ul className="difffiles">
                          {diff.files.map((f) => (
                            <DiffFileRow
                              key={f.filename}
                              file={f}
                              open={openFiles.has(`${b.name}:${f.filename}`)}
                              onToggle={() => toggleFile(b.name, f.filename)}
                            />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
