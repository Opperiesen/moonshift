# Current Moonshift Work

- Active feature: `001-supervised-autonomous-loop`
- Allowed task range: `T025–T035`
- Checkpoint: `US1 — Start and Observe a Bounded Project`
- Status: `US1_COMPLETE`
- Branch: `codex/us1-start-observe`
- Foundation base: `19b3ef7f4a761741e0cd1c5247516c025c1f9ea3`
- US1 implementation: `3ce748fce83c4ba599ff5b89789bfc93ffd0783c`
- Worktree: clean after the local evidence/continuity checkpoint commit
- Last updated: `2026-08-31T23:06:32Z`

## Completed tasks

`T025–T035` — authenticated loopback project API, bounded default organization and delegation,
PostgreSQL-backed atomic project bootstrap, fixture scheduling and capacity reasons, minimized context,
ordered durable events and live SSE recovery, accessible Projects/Observe browser views, deterministic
acceptance coverage, independent review, and durable US1 evidence.

## First incomplete task

`T036` — supervision policy/domain tests. This begins User Story 2 and is intentionally outside the
completed US1 scope; do not start it until the next bounded iteration is explicitly authorized.

## Principal files changed

- `apps/control-plane/` — PostgreSQL/in-memory repository ports, project application service,
  scheduler, HTTP/session routes, projections, typed models, and production/fixture assembly
- `apps/web/` — Vite/React Projects and Observe views with authenticated submission, live SSE replay,
  expired-cursor reload, reconnect states, presence, organization, task, and capacity summaries
- `packages/domain/src/project-organization.ts` — default council, bounded channels, complete
  delegation, and specialist archival rules
- `packages/persistence/src/migrations/002_start_observe.sql` and migration manifest — durable project
  snapshots, ordered events, retention watermark, and upgrade coverage
- `tests/contract/projects-api.test.ts`, `tests/integration/start-observe.test.ts`, and
  `tests/acceptance/start-observe.spec.ts` — API, PostgreSQL, scheduling, concurrency, SSE, and browser
  journey evidence
- `evidence/001-supervised-autonomous-loop/us1/manifest.json` — authoritative T035 evidence record
- `specs/001-supervised-autonomous-loop/tasks.md` — T025–T035 completed; T036 remains unchecked

## Verification evidence

| Command                                            | Result | Notes                                                                                                                   |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Startup Spec Kit/checklist audit                   | PASS   | Active feature resolved; 138/138 actual checklist entries passed across nine files                                      |
| `node scripts/generate-contract-types.mjs --check` | PASS   | Generated contract types reproduce from the approved OpenAPI source                                                     |
| `pnpm clean && pnpm validate`                      | PASS   | Pinned Node 24.20.0/pnpm 11.24.0; format, lint, boundaries, lockfile, image pins, secrets, typecheck, 61/56/60 tests    |
| `pnpm test:acceptance`                             | PASS   | 6/6 Chromium tests, including valid/rejected flows, presence, capacity, live delivery, and automatic cursor recovery    |
| `pnpm --filter @moonshift/web build`               | PASS   | Vite production build completed                                                                                         |
| Independent final review                           | PASS   | Fresh reviewer found no substantive US1 findings; targeted independent 4 unit, 7 contract, and 7 integration tests pass |
| `$speckit-converge` bounded to T025–T035           | PASS   | No remaining US1 work appended; all 11 tasks checked and T036 remains untouched                                         |
| `git diff --check`                                 | PASS   | No whitespace errors                                                                                                    |

## Open findings

- The host exposes Node.js `26.7.0` and pnpm `11.19.0`; validation must continue through the pinned
  Node.js `24.20.0` and pnpm `11.24.0` wrapper.
- `docker` and `psql` are not on `PATH`; deterministic integration validation uses the approved
  embedded PostgreSQL 18.4 server.
- US1 deliberately stops at the fake backend tool-intent/approval boundary. It performs no sensitive
  effect and makes no verification claim; approval/control behavior begins at T036.
- Review rounds drove repairs for transactionally durable capacity and idempotency, PostgreSQL
  retention and replay races, persistent SSE/reset recovery, actual-loopback and bootstrap TTL
  enforcement, raw request bounds, the default four-specialist ceiling, PostgreSQL-clock temporal
  authority, delegated runtime propagation, safe retention caps, bounded channel policy, and a
  PostgreSQL-backed HTTP assembly. The final fresh review reported no substantive findings.

## Exact next action

US1 is complete; stop here. T036 is the first task of User Story 2 and must remain untouched until the
next explicitly authorized bounded iteration.
