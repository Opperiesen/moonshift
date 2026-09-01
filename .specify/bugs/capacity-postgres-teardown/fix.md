# Bug Fix: Capacity test PostgreSQL teardown

- **Slug**: capacity-postgres-teardown
- **Fixed**: 2026-09-01T23:45:31Z
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

The capacity fixture now observes database errors only during teardown and verifies that any such
error is the expected PostgreSQL administrative-shutdown code. This prevents Linux scheduling from
turning a successful capacity run into an unhandled-error failure without suppressing unexpected
database faults.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `tests/performance/reference-capacity.test.ts` | modified | Collects pool errors through embedded PostgreSQL shutdown and accepts only `57P01` while shutdown is active. |

## Tests Added or Updated

- `tests/performance/reference-capacity.test.ts` teardown — keeps pool listeners active through the
  embedded-process exit and asserts the exact allowed error code and lifecycle phase.

## Local Verification

- Commands run: `npx --yes -p node@24.20.0 -p pnpm@11.24.0 pnpm test:capacity -- --reporter=dot` repeated ten times → 10/10 passed.
- Commands run: `pnpm exec prettier --check tests/performance/reference-capacity.test.ts .specify/bugs/capacity-postgres-teardown/assessment.md` → passed.
- Commands run: `git diff --check` → passed.
- Manual checks: confirmed listeners are installed only after the test scenario, retained until the
  embedded PostgreSQL process exits, and reject errors outside code `57P01` or outside the stop phase.

## Deviations from Assessment

None.

## Follow-ups

- Run the complete validation suite with the repository-pinned Node.js and pnpm versions.
- Verify the original Ubuntu GitHub Actions reproduction no longer occurs.
