// THE CLUSTER MAPS THE FIXTURES STAND ON — clusters/active/<fqdn>.yaml as the two writers of that
// file leave it: the map template on a master, and the manager's own mark-slave on a slave.
//
// A FIXTURE MAP THAT CARRIES LESS THAN A REAL ONE CANNOT FAIL when the code drops something. The
// master's below stood for a while with six of the seventeen keys a real one has, and a slave
// composed from it came out with ten while every test passed — the missing ones were what its own
// programs read, and its machine layer stopped at "is not on this host" asking for the address of
// the secret store (apps4, 2026-08-29). Every key here is one a real map states.

/** THE NAMES THESE MAPS ARE WRITTEN FOR, stated HERE and read by the harness that seeds them —
 *  a map names the cluster it is about, so the name belongs beside the map and not the other way
 *  round. The harness composes its PARAMS from these. */
export const MASTER_FQDN = "m1.example.com";
export const SLAVE_FQDN = "s1.example.com";
export const FIXTURE_STAGE = "prod";

/** A slave's cluster map as mark-slave leaves it on the books branch — identity plus the slave
 *  part that makes the master's slaves ApplicationSet able to dial it. Seeded by tests that start
 *  from a slave that ALREADY IS one (redeploy, release's slave arm); a fresh deploy writes its own. */
export const SLAVE_MARKING_YAML = [
  `stage: ${FIXTURE_STAGE}`,
  "role: slave",
  "booksCluster: m1.example.com",
  "",
  "global:",
  `  domain: ${SLAVE_FQDN}`,
  "  buildPlane: m1.example.com",
  "  master: m1.example.com",
  "  apiHost: 100.64.0.11",
  "  apiPort: 16443",
].join("\n") + "\n";

/** The MASTER's own cluster map: written when the master installed itself. mark-slave reads it to
 *  compose the SLAVE's map — a slave belongs to the same installation, so its build plane, unit
 *  apex, platform domain, alert recipients and catalog repository are the master's. */
export const MASTER_MARKING_YAML = [
  "stage: prod",
  "role: master",
  "booksCluster: m1.example.com",
  "",
  "global:",
  "  domain: m1.example.com",
  "  buildPlane: m1.example.com",
  "  unitApex: example.com",
  "  platformDomain: example.com",
  // A LIST, which is what the map template writes and what the alert route ranges over. It stood
  // here as a plain scalar, and a scalar is what the writer produced from it too — so no test could
  // see that the first rewrite of a real map turned its recipients into one mailbox that is several.
  "  alertRecipients: ['ops@example.com']",
  "  catalogUrl: https://github.com/acme/acme-catalog.git",
  // THE SAME REPOSITORY AS owner/name. A cluster cutting a SLAVE's branch reads it from the map,
  // because catalogUrl is the wrong shape for what the argocd files stamp.
  "  catalogRepo: acme/acme-catalog",
  // WHAT A REAL MASTER'S MAP CARRIES BESIDE THE NAMES ABOVE. It stood without these, and a fixture
  // that carries less than the thing it stands for cannot fail when the code drops something: a
  // slave was composed from a handful of copied fields and came out with ten of a master's
  // seventeen keys, while every test passed (2026-08-29).
  //
  // Two of them are the machine's OWN and a slave must not inherit them — the short name everything
  // per cluster carries, and the auth mount that tells two clusters of one installation apart when
  // they log in. The rest belong to the installation and must arrive untouched.
  "  clusterName: m1",
  "  letsencryptEmail: ops@example.com",
  "  letsencryptServer: https://acme-v02.api.letsencrypt.org/directory",
  "  vaultKubernetesAuthPath: kubernetes-m1",
  "  registryPullUser: puller",
  "  registryPushUser: pusher",
  // WHERE THE MACHINES OF THIS CLUSTER CAN BE REACHED. A fact about the MASTER's box, and the one
  // global key a slave must not inherit — the fence the gate sandbox draws would otherwise be drawn
  // around this machine while the slave's own address stood outside it.
  "  nodeCidrs: [203.0.113.7/32]",
  // ALL FIVE, as the map template writes them. Three of them follow the books-keeping cluster and
  // one the build plane, so a slave inherits every one unchanged — and a fixture carrying only the
  // one a single step happened to read cannot fail when the next step's address goes missing.
  "  endpoints:",
  "    registry:",
  "      host: zot.m1.example.com",
  // NO `mail` HERE ON PURPOSE. It is optional in the template — an installation running no mail
  // service has none — and release.test.ts proves the absent-optional path off this very map: the
  // answer rides nowhere rather than being invented. The present case is proven where the round
  // trip is, in cluster-marking.test.ts's FULL_MAP.
  "    vault:",
  "      url: https://vault.m1.example.com",
  "    idp:",
  "      url: https://idp.m1.example.com",
  "    tailnet:",
  "      url: https://tale.m1.example.com",
  // A MASTER HOLDS ALL THREE: it keeps the books and, here, also builds. Two of them are what a
  // slave must be told it does NOT hold.
  "  servicesLocal:",
  "    registry: true",
  "    vault: true",
  "    observability: true",
].join("\n") + "\n";
