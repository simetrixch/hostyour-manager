<!-- The rules for this repository, read before writing a line in it and before reviewing one.
     They live here rather than in a central directory because they govern THIS code: a rule
     that has to be mirrored onto a machine before it takes effect is a rule that silently does
     not apply on the machine nobody mirrored. -->

# hostyour-manager

Onboards consumers and tenants onto a `hostyour-cloud` installation: the namespace, the Vault path,
the databases, the build pipeline, the identity provider's client, the registrations. Every one of
those is a mutation on a real cluster, a real git repository or a real secret store, and any of them
can fail after the previous three succeeded.

That is what shapes this codebase, and it is the reason for almost every rule below.

## Stack baseline

TypeScript on Node with `tsx`, Express for HTTP, Drizzle over PostgreSQL, Vitest for tests, React
for the operator's web pages. No framework decides the architecture — the boundaries below do, and
`depcruise` fails the build when one is crossed.

## The one non-negotiable: a run is a sequence of undoable steps

An onboarding is not a function that either returns or throws. It is a **run**: a recorded sequence
of steps, each of which states how to take itself back, and the undo is **armed before the first
mutation, never after**. A step that creates a Vault path registers its deletion before it writes,
because the process can die between the write and the registration and that gap is exactly where an
orphan is born.

Read `server/executor/` before writing a run. It is domain-agnostic on purpose — `depcruise`
enforces that it imports no domain — so a new kind of onboarding is a new set of steps and not a new
executor.

## The boundaries, and they are checked

`npm run lint:boundaries` runs `depcruise` and these are its rules, each one a defect that happened:

| rule | what it forbids |
|---|---|
| `shared-is-pure` | `shared/` holds types and imports nothing from `server/` or `web/` — it is the wire contract both sides read |
| `domains-no-crosstalk` | a domain never imports another. `inventory` is the one read exception, because everything needs to know what a cluster is |
| `adapters-own-io-libs` | `ssh2`, the kube client and `openid-client` may only be imported inside `adapters/`. Everything else talks to a PORT |
| `routes-are-thin` | a route may depend on an adapter's port — the injected abstraction — and never on its implementation |
| `executor-knows-no-domain` | the run executor is domain-agnostic |
| `kernel-is-bottom` | `kernel/` imports nothing of ours |
| `only-executor-touches-runs-schema` · `only-store-writes-creds` · `only-access-writes-operators` · `only-audit-writer` | exactly one module writes each of these tables. A second writer is how two truths appear in one column |
| `no-unreachable-modules` | code nothing reaches is deleted, not kept |

## Ports and adapters

`server/adapters/<thing>/port.ts` is the interface, `<thing>.ts` the real implementation,
`testing/fake.ts` the fake. Fourteen of them today: git, github, kube, helm, vault, oidc, ssh, dns,
registry, activation, build-plane, gate-runner, http-probe, github-consumer.

**The fake is shipped beside the port, not written per test.** A fake that each test builds its own
way is fourteen slightly different beliefs about what the real thing does.

**Every port is injected.** No module reaches for a singleton, a global or a service locator; wiring
happens in `server/boot/`. That is what makes a run testable without a cluster.

## Errors

A failure a caller must handle is a **value** — a discriminated union at the boundary, so the
compiler forces every case. An exception is for what nobody can act on. A run step that fails names
what it was doing and what it left behind, because that string is what an operator reads at 2am and
it is the difference between a retry and a guess.

## Secrets

A credential never enters a log, a run record or an error message. `server/security/` holds the
redaction, and the record's own test asserts that a seeded secret does not appear in the serialized
stream — asserted, not intended.

A credential the operator supplies is validated for the scopes it needs **before any mutation**, and
the refusal names every missing scope at once. Half an onboarding is worse than none.

## Tests

`npx vitest run` — **191 files, 2015 tests**. That number is a fact about this repository, and a
change that moves it without saying why is a change that has not been reviewed.

- a test asserts behaviour, never the shape of an implementation
- a counter-probe belongs beside any test that could pass by measuring nothing: prove the assertion
  can fail, or it proves nothing
- a run's failure paths are tested as carefully as its success path, because the failure path is the
  one that runs on the worst day

## Before it is done

```
npm run check      # typecheck, eslint, boundaries, stylelint, the web build
npx vitest run     # 191 files, 2015 tests, 4 skipped
```

Both clean, or it is not done.

## What this must never hard-code

No installation's domain, no customer's name, no cluster's FQDN. Those arrive as configuration and
as values on a run. `example.invalid` is the placeholder, `example.com` is the illustration, and a
real domain in this tree is a defect that ships to every future installation.

## License

Elastic License 2.0, Simetrix GmbH — see `LICENSE.md`. Contributions are welcome and the copyright
question is settled before the code is written: by opening a pull request you grant Simetrix GmbH
the right to use your contribution under any terms, including a commercial license.
