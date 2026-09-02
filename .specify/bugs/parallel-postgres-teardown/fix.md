# Bug Fix: Parallel PostgreSQL fixture teardown

- **Slug**: parallel-postgres-teardown
- **Fixed**: 2026-09-02T00:01:59Z
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Every embedded PostgreSQL test fixture now uses one strict teardown helper. Pool listeners remain in
place through server shutdown, expected administrative termination is scoped to that exact phase,
and all other errors still fail the suite.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `tests/fixtures/postgres.ts` | added | Central strict pool and embedded-server teardown. |
| `tests/integration/postgres-fixture.test.ts` | added | Covers accepted and rejected lifecycle/error combinations. |
| Embedded PostgreSQL integration, recovery, and performance suites | modified | Reuse the shared teardown instead of stopping pools and servers independently. |

## Tests Added or Updated

- Direct helper tests accept only `57P01` during explicit stop, reject it before stop, reject other
  codes during stop, and verify listener cleanup.
- Existing real-PostgreSQL suites exercise the helper with one or several pools.

## Deviations from Assessment

None.

## Local Verification

- Direct helper tests: 3/3 passed, including exhaustive multi-pool close-failure collection.
- Pinned integration suite repeated ten times: 10/10 passed, 116 tests per run.
- Complete pinned `pnpm clean && pnpm validate`: passed with 91 unit, 71 contract, 117
  integration, 33 recovery, 15 security, and 1 capacity test.
- Pinned `pnpm test:acceptance`: 23/23 Chromium scenarios passed.
- `git diff --check`: passed.

## Follow-ups

- Run the public Linux CI workflow on the published commit.
