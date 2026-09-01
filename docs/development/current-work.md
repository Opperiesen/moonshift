# Current Moonshift Work

- Active feature: `001-supervised-autonomous-loop`
- Allowed task range: `T036–T046`
- Checkpoint: `US2 — Govern Sensitive and Stoppable Work`
- Status: `US2_COMPLETE`
- Branch: `codex/us2-govern-sensitive`
- US1 base: `2d68df994ea78ae1f57e2f7504bdfe002190e6ac`
- US2 implementation: `2fcdc71313f1fd333c5b965aaebaad2bbe627e9c`
- Worktree: clean after the local evidence/continuity checkpoint commit
- Last updated: `2026-09-01T02:13:56Z`

## Completed tasks

`T036–T046` — approval-bound simulated sensitive effects; immutable action digests; supervisor-only,
versioned, idempotent decisions; PostgreSQL-authoritative expiry and global capacity; distinct durable
pause, resume, stop, and cancel semantics; restart-safe reconciliation; mutually authenticated runner
transport; durable one-shot leases, fencing, pre-offer cancellation, and queryable effect ledger;
attributable audit projections; Supervise browser controls; deterministic acceptance coverage;
independent review; bounded convergence; and durable US2 evidence.

## First incomplete task

`T047` — verification rule-matrix tests. This begins User Story 3 and is intentionally outside the
completed US2 scope; do not start it until the next bounded iteration is explicitly authorized.

## Principal files changed

- `apps/control-plane/src/application/supervision/` and `apps/control-plane/src/http/supervision.ts` —
  durable approval, effect, budget, authority, and supervisor-control application paths plus HTTP API
- `apps/control-plane/src/application/projects/` and `apps/control-plane/src/model.ts` — PostgreSQL
  authority time, globally locked capacity reservations, and durable US2 state projections
- `apps/runner/src/` — mutually authenticated client/server protocol, durable lease journal, exact
  enrolled identity, revocation fencing, and queryable at-most-once fixture effect ledger
- `packages/policy/src/supervision.ts` and `apps/control-plane/src/projections/supervision-events.ts` —
  policy/control transitions and attributable, privacy-bounded audit projections
- `apps/web/src/features/supervise/` and `apps/web/src/services/project-api.ts` — immutable approval
  detail, budget/capacity display, and distinct pause/resume/stop/cancel feedback
- `tests/` and `packages/policy/src/supervision.test.ts` — policy, contract, PostgreSQL concurrency,
  crash/reconciliation, runner-security, race, and browser evidence
- `evidence/001-supervised-autonomous-loop/us2/manifest.json` — authoritative T046 evidence record
- `specs/001-supervised-autonomous-loop/tasks.md` — T036–T046 completed; T047 remains unchecked

## Verification evidence

| Command                                            | Result | Notes                                                                                                                         |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Focused runner and supervision integration         | PASS   | 2 files, 55/55 tests; approval races, restart reconciliation, mTLS, one-shot leases, cancellation fencing, and capacity       |
| `pnpm clean && pnpm validate`                      | PASS   | Pinned Node 24.20.0/pnpm 11.24.0; format, lint, boundaries, lockfile, image pins, secrets, typecheck, 75/60/79 tests          |
| `pnpm test:acceptance`                             | PASS   | 9/9 Chromium tests, including approve/apply-once, reject/expiry, and visibly distinct pause/resume/stop/cancel journeys       |
| `pnpm --filter @moonshift/web build`               | PASS   | Vite production build completed                                                                                               |
| `node scripts/generate-contract-types.mjs --check` | PASS   | Generated contract types reproduce from the approved contracts                                                                |
| Independent final review                           | PASS   | Fresh reviewer found no substantive T036–T045 findings after the durable runner-capacity projection repair                    |
| `$speckit-converge` bounded to T036–T046           | PASS   | 6 acceptance scenarios, 12 bounded functional requirements, 4 bounded success outcomes, and 5 plan decisions have no open gap |
| `git diff --check`                                 | PASS   | No whitespace errors                                                                                                          |

## Open findings

- The host exposes Node.js `26.7.0` and pnpm `11.19.0`; validation must continue through the
  pinned Node.js `24.20.0` and pnpm `11.24.0` wrapper.
- `docker` and `psql` are not on `PATH`; deterministic integration validation uses the approved
  embedded PostgreSQL 18.4 server.
- US2 performs only the controlled simulated sensitive fixture effect. It uses no real provider
  credential, unrestricted shell, external network effect, or production mutation, and makes no
  verification claim; verification behavior begins at T047.
- Independent review rounds drove repairs for lease expiry enforcement, exact mTLS identity, durable
  one-shot lease consumption, cross-instance PostgreSQL capacity, stop/completion serialization,
  restart recovery, indeterminate-effect blocking, durable pre-offer cancellation fencing, journal
  validation, and live runner-capacity projection. The final fresh review reported no substantive
  findings.

## Exact next action

US2 is complete; stop here. T047 is the first task of User Story 3 and must remain untouched until the
next explicitly authorized bounded iteration.
