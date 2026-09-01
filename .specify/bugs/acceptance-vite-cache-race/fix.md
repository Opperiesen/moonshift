# Bug Fix: Parallel acceptance Vite cache isolation

- **Slug**: acceptance-vite-cache-race
- **Fixed**: 2026-09-01T23:49:46Z
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Each parallel acceptance Vite server now owns a distinct dependency-optimizer cache beneath the
ignored web `node_modules` directory. This prevents cross-worker cache invalidation and the resulting
504 `Outdated Optimize Dep` blank pages.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `tests/acceptance/start-observe.spec.ts` | modified | Adds a dedicated start/observe optimizer cache. |
| `tests/acceptance/supervise.spec.ts` | modified | Adds a dedicated supervision optimizer cache. |
| `tests/acceptance/verification.spec.ts` | modified | Adds a dedicated verification optimizer cache. |
| `tests/acceptance/recovery.spec.ts` | modified | Adds a dedicated recovery optimizer cache. |
| `tests/acceptance/results-audit.spec.ts` | modified | Adds a dedicated results/audit optimizer cache. |

## Tests Added or Updated

- The five existing parallel acceptance server fixtures now exercise isolated Vite caches without
  changing their roots, ports, backend proxies, or scenarios.

## Local Verification

- Commands run: repository-pinned Node.js 24.20.0 and pnpm 11.24.0 Playwright suite after moving all
  five generated caches aside before every run → 5 consecutive cold-cache runs passed, 23/23 each.
- Commands run: one additional complete acceptance run → 23/23 passed.
- Commands run: Prettier checks for all changed specs and the assessment → passed.
- Commands run: `git diff --check` → passed.
- Manual checks: the original retained trace contains 504 `Outdated Optimize Dep` responses for the
  shared default cache; no application or control-plane request failed.

## Deviations from Assessment

None.

## Follow-ups

- Run the complete repository validation and acceptance suite together.
- Verify the public Ubuntu GitHub Actions workflow from a clean install.
