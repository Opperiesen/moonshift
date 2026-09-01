# Bug Assessment: Parallel acceptance servers share Vite optimizer cache

- **Slug**: acceptance-vite-cache-race
- **Created**: 2026-09-01T23:47:56Z
- **Source**: local Playwright trace from the public-release validation
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

The full acceptance run started five programmatic Vite development servers in parallel. The first
verification page loaded an empty application root, and its trace recorded HTTP 504 `Outdated
Optimize Dep` responses for `react-dom_client.js` and `react_jsx-dev-runtime.js`. The remaining 22
tests passed after dependency optimization stabilized.

## Symptom

An acceptance page can remain blank until its 30-second timeout because concurrent Vite servers
using the same web root invalidate one another's shared dependency-optimizer cache. Every server
must have an isolated cache while retaining the same application root and backend proxy.

## Reproduction

1. Run `pnpm test:acceptance` with the default five Playwright workers after a clean or changed Vite
   dependency cache.
2. Allow the five acceptance spec files to start their Vite servers concurrently.
3. Observe a blank page and one or more HTTP 504 `Outdated Optimize Dep` module responses in a
   retained Playwright trace.

## Suspected Code Paths

- `tests/acceptance/start-observe.spec.ts` — starts a Vite server against `apps/web` without an
  isolated `cacheDir`.
- `tests/acceptance/supervise.spec.ts` — starts a concurrent Vite server with the same default cache.
- `tests/acceptance/verification.spec.ts` — the reproduced blank-page failure occurred here.
- `tests/acceptance/recovery.spec.ts` — starts another concurrent server against the same root.
- `tests/acceptance/results-audit.spec.ts` — starts another concurrent server against the same root.

## Root Cause Hypothesis

Confidence: high. Vite's dependency optimizer cache defaults under the project root's
`node_modules/.vite`. All five programmatic servers share `apps/web` as their root, so they race on
the same optimized-dependency metadata and files. The trace's exact 504 responses and the empty
React root directly demonstrate the optimizer invalidation race.

## Proposed Remediation

**Preferred**: configure a deterministic, distinct `cacheDir` under ignored
`apps/web/node_modules` for each acceptance server. This preserves dependency optimization while
preventing one test worker from invalidating another worker's module URLs.

**Alternatives**:

- Disable optimization for the acceptance servers; this changes startup behavior and is broader
  than isolating cache ownership.
- Serialize all acceptance spec files; this hides the shared-state defect and lengthens the suite.
- Rely on Playwright retries; this leaves the first attempt flaky and wastes CI time.

**Files likely to change**:

- `tests/acceptance/start-observe.spec.ts`
- `tests/acceptance/supervise.spec.ts`
- `tests/acceptance/verification.spec.ts`
- `tests/acceptance/recovery.spec.ts`
- `tests/acceptance/results-audit.spec.ts`

**Tests to add or update**:

- Repeat the complete parallel acceptance suite from a cleared Vite cache.
- Run the full repository validation and acceptance commands.

## Risks & Considerations

- Cache paths must remain ignored and scoped beneath the existing web `node_modules` directory.
- Each concurrent server needs a distinct path; sharing a renamed cache would preserve the race.
- The server root, ports, proxies, and application behavior must remain unchanged.

## Open Questions

- None.
