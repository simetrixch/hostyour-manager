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
npm run check      # typecheck, eslint, module boundaries, stylelint, the web build
npx vitest run     # the test suite
```

Both run locally. Nothing hosted runs them.

## License

**Elastic License 2.0.** Run it, change it, onboard your own consumers and tenants with it. What
needs a separate license from Simetrix GmbH is running onboarding as a service for third parties.

See [LICENSE.md](LICENSE.md).
