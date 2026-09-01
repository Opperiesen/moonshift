# Quickstart Validation: Execution Backend Contracts

This guide defines the end-to-end proof expected after Feature 002 implementation. It does not start
real providers and must complete with no credential or external network service.

## Prerequisites

- Clean checkout of `codex/002-execution-backend-contracts` at the implementation checkpoint.
- Node.js 24 and pnpm 11.24.0 through the repository's pinned wrapper when host defaults differ.
- Existing local PostgreSQL fixture support and artifact directory available.
- No provider/API/CLI credential environment variables supplied to the test process; external network
  is denied, no arbitrary shell capability is added, and no deployment command is part of this guide.

## Contract and generation gate

```bash
npx --yes --package=node@24 --package=pnpm@11.24.0 --call \
  'pnpm contracts:generate && pnpm format:check && pnpm typecheck && pnpm test:contract'
```

Expected:

- Feature 002 schemas validate and generated types are reproducible with no tracked diff.
- Common, family, capability, corpus/profile/report, routing, and conformance examples pass.
- Unknown versions, provider-private fields, credential-shaped fields, malformed sequences, and
  boundary violations fail closed.

## US1 — Qualify a backend before use

Run the US1-tagged contract, domain, persistence, integration, security, and acceptance cases.

Expected observable proof:

1. Two deterministic connections and their shared immutable model descriptor are discoverable.
2. Connection-specific availability remains a separate relation.
3. Current probe, auth, health, capability, and the Foundation's minimum versioned mandatory
   qualification corpus derives `QUALIFIED` for the conformant variants.
4. Stale, contradictory, unknown-version, missing-mandatory-case, and tampered variants remain
   ineligible with stable exclusion reasons.
5. The supervisor can inspect sanitized qualification provenance; no credential, private reasoning,
   provider field, or raw transcript appears.

This is the first implementation checkpoint. Stop here and record revision-bound evidence before
starting US2.

## US2 — Execute through one portable contract

Run the common execution corpus against both conformant deterministic connections and the broken
variants.

Expected observable proof:

- Normalized request/event/result/failure/usage/checkpoint meaning is equivalent across conformant
  fixtures while adapter and connection provenance remains distinct.
- Per-execution events are ordered, bounded, deduplicated, sanitized, and terminal exactly once.
- Cancellation distinguishes acknowledged, confirmed, terminal, unknown, and reconciliation states.
- Feature 001 scenarios and acceptance journey still pass through the generalized adapter port.
- The control-plane scheduler no longer imports `@moonshift/backend-fake` directly.

## US3 — Route and recover deterministically

Run fixed-snapshot routing and recovery cases containing healthy, degraded, unavailable,
nonconformant, capability-incomplete, budget-exhausted, stale, and checkpoint-incompatible candidates.

Expected observable proof:

- Identical snapshot bytes produce identical ordered candidates, exclusions, selection, and decision
  hash.
- No mandatory requirement is silently downgraded.
- A stale route is rejected at start and replaced by a successor decision.
- A valid compatible checkpoint resumes the same task and agent through a successor execution without
  duplicate output/effect; corrupt or incompatible checkpoints block.

## US4 — Prove adapter compatibility

Run the complete versioned corpus with the same clock and seed against conformant, optional-
capability, and deliberately broken adapters.

Expected observable proof:

- Repeated reference runs yield the same case outcomes and normalized evidence hashes.
- Complete mandatory cases derive support; any failed, missing, expired, incomplete, unknown-version,
  or tampered input prevents conformance.
- Reports link exact corpus, profile, contract, adapter, connection revision, model descriptor, and
  evidence hashes.
- Test-only evidence cannot be presented as real provider/harness/runtime support.

## Full regression and recovery gate

```bash
npx --yes --package=node@24 --package=pnpm@11.24.0 --call \
  'pnpm clean && pnpm validate && pnpm test:acceptance && pnpm --filter @moonshift/web build && node scripts/generate-contract-types.mjs --check'
```

Also run the migration/backup/restore, crash/recovery, security, and bounded corpus-performance cases
named in [tasks.md](tasks.md).

Expected:

- All Feature 001 and Feature 002 deterministic suites pass from a clean checkout.
- Migration 004 and backup/restore retain exact catalog, qualification, route, usage, report hashes,
  and legacy Feature 001 evidence.
- Probe/report/route/start/cancel/resume crashes converge without duplicate logical records or effects.
- On the baseline manifest host, with one corpus worker, the manifest seed/clock, warm local processes,
  and no external network, routing stays within the 100-candidate/100-millisecond envelope and the full
  corpus stays within the 500-case/60-second envelope. These are slice gates, not capacity claims.
- No tracked file changes after generated-contract checks.

## Evidence and completion

Record revision-bound manifests for each US and the final slice. Each manifest must name contract,
profile, corpus, adapter, migration, and evaluator versions and link deterministic test, security,
recovery, backup/restore, browser, review, and convergence evidence. An adapter result or conformance
report alone never marks a Moonshift task verified.
