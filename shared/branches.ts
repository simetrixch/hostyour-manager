// The branch classes every repository of this platform carries, and which one a reference belongs on.
// Three classes, and mixing them up is what puts one installation's state into the branch every other
// installation is cut from:
//
//   PRODUCT     `master`, the trunk. The software: charts, manifests, scripts, the channel table,
//               and the release tags. Nothing that names one installation may be produced here.
//   INSTALL     one branch per cluster, named after that cluster's FQDN. A derivation of the trunk at
//               the cluster's pinned release tag plus that machine's own settings.
//   BOOKS       what one installation KNOWS about itself: its cluster maps, its consumer
//               registrations, its tenant registrations. It stands on the install branch of the
//               cluster holding the master role, so its name is that cluster's FQDN — install.sh
//               computes it as BOOKS_BRANCH and writes the maps there. Not a constant: it is a
//               different value in every installation, which is what lets the same software be
//               onboarded in two installations at once.
//
// The books branch is therefore never spelled here. It is resolved once, where the ports are built,
// and travels bound to the repository port it belongs to (PlatformRepo.booksBranch).

/** The trunk: the branch that carries the product and nothing installation-specific. The default
 *  branch of every repository of this platform, hostyour-cloud and catalog alike. */
export const PRODUCT_BRANCH = "master";
