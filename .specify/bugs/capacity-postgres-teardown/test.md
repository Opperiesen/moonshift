# Bug Verification: Capacity test PostgreSQL teardown

- **Slug**: capacity-postgres-teardown
- **Tested**: 2026-09-01T23:56:38Z
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The original Ubuntu teardown failure no longer reproduces. The capacity test and every later CI step
pass on the public clean-install workflow, with all local regression checks also green.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (post-fix) | GitHub Actions run 33573046524 on Ubuntu | pass | `pnpm validate` completed, including the capacity teardown that previously emitted `57P01`. |
| Updated tests | `pnpm test:capacity` repeated ten times | pass | 10/10 passed with Node.js 24.20.0 and pnpm 11.24.0. |
| Regression suite | `pnpm validate` | pass | Unit, contract, integration, recovery, security, and capacity suites passed. |
| Lint / type-check | Included in `pnpm validate` | pass | Prettier, ESLint, boundaries, lockfile, compose pins, secret scan, and TypeScript passed. |

## Output Excerpts

```text
GitHub Actions run 33573046524
Run pnpm validate        success
Run pnpm test:acceptance success
```

```text
Test Files 1 passed (1)
Tests 1 passed (1)
```

## Residual Risks

- None identified for the embedded PostgreSQL teardown path. Unexpected error codes and errors
  outside the explicit stop phase still fail the test.

## Recommendation

Close the bug — verified against the original public Ubuntu reproduction and the complete local
regression suite.
