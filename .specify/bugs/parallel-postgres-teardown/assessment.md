# Bug Assessment: Parallel PostgreSQL fixture teardown leaks shutdown errors

- **Slug**: parallel-postgres-teardown
- **Created**: 2026-09-02T00:01:59Z
- **Source**: GitHub Actions run 33573332844 failure log
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

The public Linux CI run completed all 114 integration assertions, then Vitest reported four
unhandled PostgreSQL errors with code `57P01` and message `terminating connection due to
administrator command`. The errors originated while the parallel integration workers were tearing
down embedded PostgreSQL fixtures, causing `pnpm validate` to fail.

## Symptom

Integration tests pass functionally but can fail the process on Linux because shutdown errors from
idle `pg` clients are emitted without pool error listeners while their embedded PostgreSQL process
is stopping. The same platform scheduling window had already occurred in the capacity fixture.

## Reproduction

1. Run `pnpm validate` on the public Ubuntu GitHub Actions runner.
2. Allow the integration project to complete all 114 assertions across its parallel file workers.
3. Observe unhandled `57P01` errors after the assertions pass and before Vitest exits.

## Suspected Code Paths

- `tests/integration/start-observe.test.ts` and the other embedded-PostgreSQL suites close their pool
  and immediately stop PostgreSQL without a teardown-scoped error listener.
- `tests/performance/reference-capacity.test.ts` already contains an isolated form of the required
  strict shutdown handling.

## Root Cause Hypothesis

Confidence: high. On Linux, PostgreSQL backends can still be completing graceful client termination
after `Pool.end()` resolves. The embedded fixture then stops the server, clients receive PostgreSQL
`57P01`, and `pg-pool` re-emits the error without a listener. Parallel Vitest file workers make this
scheduling window easier to hit. The passing assertions and serialized clients' ending state show
that this is teardown behavior, not an application query failure.

## Proposed Remediation

Centralize embedded PostgreSQL teardown for every affected integration, recovery, and performance
fixture. Register pool listeners before closing clients, retain them through server exit, and accept
only code `57P01` emitted during the explicit embedded-stop phase. Reject all other errors and remove
listeners afterward.

## Risks & Considerations

- Handling must remain teardown-scoped so runtime database errors still fail immediately.
- A `57P01` emitted before explicit server stop must remain a failure.
- Reuse must not weaken the exact behavior already validated by the capacity fixture.

## Open Questions

- None.
