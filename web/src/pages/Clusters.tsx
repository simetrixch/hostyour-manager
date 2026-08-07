import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ClustersView } from "../../../shared/api-types.ts";
import { getClusters } from "../api.ts";
import { IconChevronRight } from "../components/icons.tsx";

export function Clusters() {
  const [clusters, setClusters] = useState<ClustersView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getClusters()
      .then((f) => {
        if (alive) setClusters(f);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
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

  // clusters.servers is the MANAGED set only (the slaves) — the master (this controller)
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
          <p className="page__desc">Everything this controller manages, at a glance.</p>
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
          Master: {clusters.master.name} (this controller)
        </p>
      )}

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
