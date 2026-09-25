// Asking a Prometheus-compatible query API one instant query, as a port the run steps depend on.
//
// WHY THIS EXISTS AT ALL. The deploy-slave run ends with a soft probe that asks one question — is
// the new slave's obs-agent pushing? Asking it by exec'ing into the Prometheus container on the
// master and running promtool against localhost is the alternative, and `pods/exec` hands the run
// that pod's own ServiceAccount token and its filesystem on a cluster that carries pods whose
// ServiceAccount is cluster-admin. The same question is answered by a plain HTTP GET with no
// Kubernetes right at all.
//
// THE PORT KNOWS THE TOOL AND NOT THE APPLICATION. What is here is the query API's own grammar — an
// instant query, and what a Prometheus-shaped answer contains. Which SERIES is worth asking about,
// and what it means that there is none, belongs to the step that asks. A port that knew about
// slaves and obs-agents would be useless to anything else that has the same API in front of it.

/** What the query API said.
 *
 *  TWO KINDS AND NOT THREE, and the third one is the caller's. `answered` carries how many series
 *  came back, so "none yet" and "there they are" are one outcome at two values rather than two
 *  outcomes — a machine that is not pushing yet and one that is differ in degree. `unanswered` is
 *  every way the question did not get an answer at all: nothing listening, a name that no longer
 *  resolves, a body that is not a Prometheus answer, or the API refusing the query in its own words.
 *  They are one kind because they are one ACTION — somebody goes and looks at the query API — and
 *  `detail` says which of them it was.
 *
 *  A THIRD OUTCOME EXISTS AND IS NOT HERE: a manager that was never given an address. That is the
 *  ABSENCE of this port, decided where the ports are built, and it must stay distinguishable from an
 *  address that answered nothing — an address never given and a Service that was renamed are
 *  different faults with different fixes. */
export type InstantAnswer =
  | { kind: "answered"; series: number }
  | { kind: "unanswered"; detail: string };

export interface MetricsQuery {
  /** Ask `query` as an instant query and report what came back.
   *
   *  NEVER THROWS. The one caller is a SOFT check whose whole design is that it degrades to a note,
   *  so a failure is a value it can read and report rather than an exception that would have to be
   *  caught at every call site to be turned back into one (CLAUDE.md, Errors). */
  instant(query: string, opts: { signal?: AbortSignal }): Promise<InstantAnswer>;
}
