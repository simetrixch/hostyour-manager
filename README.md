# hostyour-manager

Onboards consumers and tenants onto a hostyour-cloud installation.

Creating a tenant means: a namespace with its network policy and its quota, a Vault path with the
policies and auth roles that scope it, one or more databases, a build pipeline, an identity
provider's client, a registration on the books branch, and an invitation for its first
administrator. Seven systems, in an order that matters, any of which can fail after the previous
three succeeded.

## What it is

**A run is a recorded sequence of undoable steps.** Each one registers how to take itself back
*before* it mutates anything, because a process can die between the write and the registration and
that gap is where an orphan is born. On failure the run unwinds in reverse and records what it
undid.

**Everything outside goes through an adapter** under `server/adapters/`: git, GitHub, Kubernetes,
Helm, Vault, OIDC, SSH, DNS, the registry and more, most with a fake beside them for the tests. A
boundary check fails the build when a route file (`routes.ts`, `api.ts`) reaches past a port to an
implementation, or when a domain imports another.

**A credential is checked before anything is touched.** The scopes a supplied credential must carry
are verified up front and the refusal names every missing one at once, because half an onboarding
is worse than none.

## Running the checks

```
scripts/check.sh   # typecheck, eslint, module boundaries, stylelint, the web build, every test suite
```

The tests run here before every push (the pre-push hook runs `scripts/check.sh`) and in CI
(`.github/workflows/tests.yml`). The ansiwise real-serve suites run when the ansiwise binary pair
is on the machine; without it they skip, and the script names each suite it did not run.

## License

**Elastic License 2.0.** Run it, change it, onboard your own consumers and tenants with it. What
needs a separate license from Simetrix GmbH is running onboarding as a service for third parties.

See [LICENSE.md](LICENSE.md).

### Installation domain preview

Open **Domain move** (`/installation-domain`), enter the installation's current and proposed apex, and select **Read preview**. This protected GET reads live cluster maps, every dev/test/prod consumer and tenant registration, DNS provider records, DNS book entries, IdP marks and derived cookie domains plus product cookie overrides. It does not create a run or write migration data. The full recorded fields and retained book entries are expandable.

Leave **Dry run** selected to record an `installation-domain-move` plan and approve its read-only attestation in the normal run screen. Apply is a later owner-led cutover: machine/control-plane migration must be complete, the frozen census must still match, and every displayed blocker must be resolved. External database/Vault/IdP-client migration and cross-apex session handoff remain separate acceptance gates. Old records are retained; mail records are untouched.

`installation-domain-rollback` takes the ID of a stopped, real move and derives its journal from that run. Its default is also dry run. A real rollback restores only recorded domain fields and records owned by that move, retaining unrelated edits and refusing conflicting newer writers. A dry-run move has nothing to roll back. Full installation cutover acceptance stays open until the owner-led live switch and data/session proof.
