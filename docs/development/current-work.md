# Current Moonshift Work

- Active feature: `001-supervised-autonomous-loop`
- Allowed task range: `T058–T068`
- Checkpoint: `US4 — Recover Without Losing or Duplicating Work`
- Status: `US4_COMPLETE`
- Branch: `codex/us4-recovery`
- US3 base: `65c5b8462282e277cc54c2fd3695ac4ef55b8d6d`
- US4 implementation: `dc766b2f0b92d115c45a370009005641217ad14b`
- Worktree: clean after the local evidence/continuity checkpoint commit
- Last updated: `2026-09-01T17:25:37Z`

## Completed tasks

`T058–T068` — versioned, complete, integrity-bound provider-neutral checkpoints; durable heartbeat
loss detection and monotonic fencing; stale-runtime rejection; seven-boundary effect reconciliation
with bounded `UNKNOWN` blocking; three-phase recovery outside database transactions; startup
reconstruction and queue resumption; PostgreSQL outbox claim/apply/ACK and projection catch-up;
capability-compatible continuation on the second fake connection; stable logical identities with
fresh execution authority; truthful browser recovery states; deterministic contract, integration,
restart, crash, and acceptance coverage; independent review; bounded convergence; and durable US4
evidence.

## First incomplete task

`T069` — result-projection integration tests for stable linked records, provenance, state parity,
ordered replay, projection reload, and terminal-state truthfulness. This begins User Story 5 and is
intentionally outside the completed US4 scope; do not start it until the next bounded iteration is
explicitly authorized.

## Principal files changed

- `apps/control-plane/src/application/recovery/` — checkpoint compilation and validation, recovery
  orchestration, bounded effect lookup, durable prepare/finalize phases, and actionable blocking
- `apps/control-plane/src/bootstrap/recovery.ts` — restart reconstruction, heartbeat-expiry recovery,
  paused-state preservation, queue release, and projection/outbox catch-up
- `apps/control-plane/src/scheduler/recovery.ts` and
  `apps/control-plane/src/scheduler/backend-switch.ts` — monotonic successor authority and
  capability-compatible second-backend routing
- `apps/control-plane/src/application/projects/postgres-repository.ts` and
  `apps/control-plane/src/projections/project-outbox.ts` — durable runtime/checkpoint state plus
  production outbox claim, apply, projection checkpoint, ACK, and expired-claim recovery
- `apps/control-plane/src/application/supervision/` — effect authority revocation, exact fencing-tuple
  enforcement, lookup, stable semantic keys, and approval-required replay
- `packages/contracts/` and `specs/001-supervised-autonomous-loop/contracts/` — execution checkpoint
  schema, backend continuation fields, and public recovery projection contract
- `packages/backend-fake/src/backend.ts` — conformant provider-neutral second fake continuation
- `apps/web/src/` — persisted active-project reconnection and explicit recovering, switched-backend,
  approval-required, and blocked-recovery states
- `tests/recovery/`, `tests/contract/checkpoint.test.ts`, and
  `tests/acceptance/recovery.spec.ts` — checkpoint, restart, crash-matrix, fencing, reconciliation,
  backend-switch, PostgreSQL, and browser evidence
- `evidence/001-supervised-autonomous-loop/us4/manifest.json` — authoritative T068 evidence record
- `specs/001-supervised-autonomous-loop/tasks.md` — T058–T068 completed; T069 remains unchecked

## Verification evidence

| Command                                            | Result | Notes                                                                                                                                                        |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused recovery suite                             | PASS   | 4 files/27 tests; restart, runtime loss, seven effect boundaries, fencing, reconciliation, backend switch, and no-compatible-backend blocking                |
| `pnpm clean && pnpm validate`                      | PASS   | Pinned Node 24.20.0/pnpm 11.24.0; format, lint, boundaries, lockfile, image pins, secrets, typecheck, 91 unit/71 contract/110 integration tests              |
| `pnpm test:acceptance`                             | PASS   | 19/19 Chromium tests; pause, restart, reconnect, recovery progress, switched backend, approval-required replay, and actionable blocking                      |
| `pnpm --filter @moonshift/web build`               | PASS   | Vite production build completed                                                                                                                              |
| `pnpm contracts:generate`                          | PASS   | Contract derivatives generated successfully                                                                                                                  |
| `node scripts/generate-contract-types.mjs --check` | PASS   | Generated contract types reproduce from approved contracts                                                                                                   |
| Independent final review                           | PASS   | Fresh post-repair reviewer found no substantive T058–T068 findings                                                                                           |
| `$speckit-converge` bounded to T058–T068           | PASS   | 5 US4 scenarios, FR-023–FR-029/FR-035, SC-002/SC-005/SC-008, tasks, implementation, tests, and evidence align; no task was appended; T069+ was not evaluated |
| `git diff --check`                                 | PASS   | No whitespace errors                                                                                                                                         |

## Open findings

- The host exposes Node.js `26.7.0` and pnpm `11.19.0`; validation must continue through the pinned
  Node.js `24.20.0` and pnpm `11.24.0` wrapper.
- `docker` and `psql` are not on `PATH`; deterministic integration validation uses the approved
  embedded PostgreSQL 18.4 server.
- US4 performs only controlled fixture recovery. It uses no real provider credential, unrestricted
  shell, external network effect, remote Git mutation, or production mutation.
- Recovery depends on a capability-compatible alternate connection. If one is unavailable or backend
  continuation fails, startup remains available and the project durably enters actionable
  `BLOCKED_RECOVERY` rather than receiving unsafe successor authority.
- Reconciled `NOT_APPLIED` uncertainty retains the stable semantic key but creates a fresh approval
  and effect-attempt identity before another dispatch; `APPLIED` resumes after the effect, and
  `UNKNOWN` never dispatches blindly.
- Independent reviews drove repairs for backend planning/completion separation, successful-result
  validation, normalized interruption fixtures, fresh approval after uncertain non-application,
  backend exception isolation, and no-compatible-backend startup behavior. The final fresh review
  reported no substantive findings.

## Exact next action

US4 is complete; stop here. T069 begins User Story 5 and must remain untouched until the next
explicitly authorized bounded iteration.
