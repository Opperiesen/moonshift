# Bug Assessment: Capacity test leaks shutdown errors on Linux

- **Slug**: capacity-postgres-teardown
- **Created**: 2026-09-02T00:00:00+02:00
- **Source**: GitHub Actions run 33571933964 failure log
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

The public Linux CI run completed the capacity assertion successfully, then Vitest reported two
unhandled PostgreSQL errors with code `57P01` and message `terminating connection due to
administrator command`. The errors originated during teardown of
`tests/performance/reference-capacity.test.ts`, causing `pnpm validate` to fail after all capacity
assertions had passed.

## Symptom

The capacity test passes functionally but fails the process on Linux because shutdown errors from
idle `pg` clients are emitted without a pool error listener while the embedded PostgreSQL process is
being stopped. Teardown should tolerate only the expected administrative-shutdown error and still
fail on any other database error.

## Reproduction

1. Run `pnpm validate` on the public Ubuntu GitHub Actions runner with Chromium installed.
2. Allow `tests/performance/reference-capacity.test.ts` to complete its capacity scenario.
3. Observe two unhandled `57P01` errors after the test passes and before Vitest exits.

## Suspected Code Paths

- `tests/performance/reference-capacity.test.ts:105` — closes the pools and immediately stops the
  embedded PostgreSQL process without handling shutdown-time pool errors.
- `embedded-postgres/dist/index.js:236` — `stop()` sends `SIGINT` to the PostgreSQL process, which
  administratively terminates any backend that has not fully exited.
- `pg-pool/index.js:51` — idle-client errors are re-emitted as pool `error` events and become
  unhandled when no listener is registered.

## Root Cause Hypothesis

Confidence: high. On Linux, the PostgreSQL backends can still be completing graceful client
termination after `Pool.end()` has resolved. The embedded fixture immediately sends `SIGINT`, so
those clients receive PostgreSQL `57P01`; `pg-pool` re-emits the errors and Vitest treats them as
uncaught. The passing test and the serialized client states (`_ending: true`, no active query)
confirm this is teardown ordering rather than an application query failure.

## Proposed Remediation

**Preferred**: register a teardown-scoped error collector on every pool before closing them and
stopping embedded PostgreSQL. Keep the listeners installed through process shutdown, then assert
that every collected error is exactly PostgreSQL `57P01`. This handles the platform scheduling
window without hiding unexpected database failures.

**Alternatives**:

- Add an arbitrary delay between `Pool.end()` and `embedded.stop()`; this is timing-dependent and
  would remain flaky on slower runners.
- Ignore all pool errors globally; this would conceal real failures and is therefore unacceptable.

**Files likely to change**:

- `tests/performance/reference-capacity.test.ts`

**Tests to add or update**:

- Update the capacity test teardown to collect and validate shutdown-time pool errors.
- Repeat `pnpm test:capacity` to exercise the teardown path multiple times.
- Run the complete `pnpm validate` and public Linux CI workflow.

## Risks & Considerations

- The handler must be scoped to teardown so runtime database errors still fail immediately.
- The assertion must reject every code other than `57P01`; no broad suppression is acceptable.
- Listeners must remain active until the embedded PostgreSQL process has fully exited.

## Open Questions

- None.
