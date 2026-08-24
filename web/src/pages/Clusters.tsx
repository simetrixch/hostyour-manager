import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ClustersView, ReleasesView } from "../../../shared/api-types.ts";
import { getClusters, getReleases } from "../api.ts";
import { appsEmpty, appsUnavailable, releaseChip } from "../clusterRelease.ts";
import { IconChevronRight } from "../components/icons.tsx";

export function Clusters() {
  const [clusters, setClusters] = useState<ClustersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The release surface loads BESIDE the clusters snapshot rather than inside it, so a repository
  // that is slow over every install branch's pin files does not hold the rest of the page. It buys
  // less than it looks like: the snapshot itself reads the cluster maps too, at
  // server/domains/inventory/api.ts:53, so a repository that fails outright still reaches both.
  const [releases, setReleases] = useState<ReleasesView | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getClusters()
      .then((f) => {
        if (alive) setClusters(f);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    getReleases()
      .then((r) => {
        if (alive) setReleases(r);
      })
      .catch((e: unknown) => {
        if (alive) setReleasesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error)
    return (
      <p role="alert" className="alert alert--danger">
        Could not load the clusters: {error}
      </p>
    );
  if (!clusters)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading clusters…
      </div>
    );

  // clusters.servers is the MANAGED set only (the slaves) — the master (this manager)
  // rides clusters.master and is shown, labeled, below the tiles, never counted.
  const stats: Array<[string, string | number]> = [
    ["Slaves", clusters.servers.length],
    ["Needs you", clusters.needsYou.length],
    ["Running", clusters.running.length],
    ["Keystore", clusters.storeMode],
  ];

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Clusters</h2>
          <p className="page__desc">Everything this manager manages, at a glance.</p>
        </div>
        <div className={`verdict verdict--${clusters.verdict}`}>
          <span className="verdict__label">Clusters</span>
          <span className="verdict__value">{clusters.verdict}</span>
        </div>
      </header>

      <dl className="stats">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <dt className="stat__label">{label}</dt>
            <dd className={typeof value === "number" ? "stat__value" : "stat__value stat__value--text"}>{value}</dd>
          </div>
        ))}
      </dl>

      {clusters.master && (
        <p className="clusters__master">
          Master: {clusters.master.name} (this manager)
        </p>
      )}

      <section className="panel">
        <header className="panel__head">
          <h3 className="panel__title">Releases</h3>
          {releases && <span className="panel__count">{releases.installations.length}</span>}
        </header>
        {releasesError && (
          <p role="alert" className="alert alert--danger">
            Could not read which release anything stands on: {releasesError}
          </p>
        )}
        {!releases && !releasesError && (
          <div className="loading">
            <span className="spinner" aria-hidden="true" />
            Reading the cluster maps and the install branches…
          </div>
        )}
        {releases?.installations.length === 0 && (
          <div className="empty">
            <p>No cluster is registered yet, so nothing stands on a release.</p>
          </div>
        )}
        {releases && releases.installations.length > 0 && (
          <ul className="rows">
            {releases.installations.map((i) => {
              const chip = releaseChip(i.release);
              return (
                <li key={i.branch}>
                  <div className="row">
                    <span className="row__title">{i.name}</span>
                    <span className="row__meta">
                      {i.branch} · {i.stage} · {i.role}
                    </span>
                    <span className="row__end">{chip && <span className={chip.className}>{chip.label}</span>}</span>
                  </div>
                  <div className="releases__detail">
                    {chip && <p className="releases__why">{chip.detail}</p>}
                    {i.apps === null ? (
                      <p className="releases__why">{appsUnavailable(releases, i.branch)}</p>
                    ) : i.apps.length === 0 ? (
                      <p className="releases__why">{appsEmpty(i.branch)}</p>
                    ) : (
                      <ul className="releases__apps">
                        {i.apps.map((a) => (
                          <li key={`${a.app}/${a.build}`} className="releases__app">
                            <span className="releases__app-name">{a.app === a.build ? a.app : `${a.app}/${a.build}`}</span>
                            <span className="releases__app-tag">
                              {a.image}:{a.tag}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {clusters.needsYou.length > 0 && (
        <section className="panel">
          <header className="panel__head">
            <h3 className="panel__title">Awaiting approval</h3>
            <span className="panel__count">{clusters.needsYou.length}</span>
          </header>
          <ul className="rows">
            {clusters.needsYou.map((r) => (
              <li key={r.id}>
                <Link className="row" to={`/runs/${r.id}`}>
                  <span className={`badge badge--${r.status}`}>{r.status}</span>
                  <span className="row__title">{r.kind}</span>
                  <span className="row__meta">{r.id}</span>
                  <span className="row__end">
                    <span className="row__chevron" aria-hidden="true">
                      <IconChevronRight />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
