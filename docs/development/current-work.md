# Current Moonshift Work

- Active feature: `001-supervised-autonomous-loop`
- Allowed task range: `T069–T075`
- Checkpoint: `US5 — Inspect a Complete Result and Audit Trail`
- Status: `US5_COMPLETE`
- Branch: `codex/us5-results-audit`
- US4 base: `c47727ac3a9ead1dca243ff22cc5175c10d31b6f`
- US5 implementation: `6239deb2a8d63e51b2d793c0c0348f2044356fe3`
- Worktree: clean after the local evidence/continuity checkpoint commit
- Last updated: `2026-09-01T18:28:16Z`

## Completed tasks

`T069–T075` — complete linked Result records; exact connection, backend, model, execution, and
revision provenance; durable execution/checkpoint history; bijective supervision-audit projection
with dual audit/project identities and sequences; durable cursor hydration, gap/conflict reload, and
event deduplication; accessible browser history and truthful terminal states; authenticated loopback
CLI summary/JSON inspection with safe export; PostgreSQL restart coverage; deterministic contract,
integration, recovery, and browser evidence; independent review; bounded convergence; and durable
US5 evidence.

## First incomplete task

`T076` — hardening negative security tests. This begins Phase 8 and is intentionally outside the
completed US5 scope; do not start it until the next bounded iteration is explicitly authorized.

## Principal files changed

- `apps/control-plane/src/projections/result-detail.ts` — complete linked Result read model,
  provenance, blockers/recovery, and fail-closed audit mapping
- `apps/control-plane/src/application/projects/result-history.ts` and project repositories — durable
  execution/checkpoint history across state transitions and PostgreSQL restart
- `apps/web/src/services/project-events.ts` and `apps/web/src/features/observe/Observe.tsx` — persisted
  cursor hydration, ordered replay, deduplication, and projection reload on expiry, gaps, or conflicts
- `apps/web/src/features/results/Results.tsx` — accessible complete result record, provenance,
  approvals, execution/checkpoint/effect history, recovery, blockers, and audit timeline
- `apps/cli/src/commands/project-inspect.ts` — strict shared-contract supervisor inspection and safe
  summary/JSON export from a loopback endpoint
- `packages/contracts/` and `specs/001-supervised-autonomous-loop/contracts/http-api.openapi.yaml` —
  strict ResultView validation and complete public result/audit contract
- `tests/integration/`, `tests/recovery/control-plane-restart.test.ts`, and
  `tests/acceptance/results-audit.spec.ts` — linked records, audit identity, reconnect, CLI, restart,
  accessibility, blockers, and state-truthfulness evidence
- `evidence/001-supervised-autonomous-loop/us5/manifest.json` — authoritative T075 evidence record
- `specs/001-supervised-autonomous-loop/tasks.md` — T069–T075 completed; T076 remains unchecked

## Verification evidence

| Command                                            | Result | Notes                                                                                                                                                                 |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused US5 suite                                  | PASS   | 5 files/46 tests; linked records, complete audit, reconnect/replay, CLI contract/export, and PostgreSQL restart history                                               |
| Focused recovery suite                             | PASS   | 4 files/28 tests; restart, runtime loss, effect boundaries, fencing, reconciliation, backend switch, and result-history persistence                                   |
| `pnpm clean && pnpm validate`                      | PASS   | Pinned Node 24.20.0/pnpm 11.24.0; format, lint, boundaries, lockfile, image pins, secrets, typecheck, 91 unit/71 contract/142 integration tests                       |
| `pnpm test:acceptance`                             | PASS   | 23/23 Chromium tests; complete Results reconnect/reload, actual terminal states, recovery progress, and blockers                                                      |
| `pnpm --filter @moonshift/web build`               | PASS   | Vite production build completed                                                                                                                                       |
| `pnpm contracts:generate`                          | PASS   | Contract derivatives generated successfully                                                                                                                           |
| `node scripts/generate-contract-types.mjs --check` | PASS   | Generated contract types reproduce from approved contracts                                                                                                            |
| Independent final review                           | PASS   | Fresh post-repair reviewer found no substantive T069–T075 findings                                                                                                    |
| `$speckit-converge` bounded to T069–T075           | PASS   | 3 US5 scenarios, FR-034–FR-036, SC-008/SC-010/SC-011, plan, constitution, tasks, implementation, tests, and evidence align; no task appended; T076+ was not evaluated |
| `git diff --check`                                 | PASS   | No whitespace errors                                                                                                                                                  |

## Open findings

- The host exposes Node.js `26.7.0` and pnpm `11.19.0`; validation must continue through the pinned
  Node.js `24.20.0` and pnpm `11.24.0` wrapper.
- `docker` and `psql` are not on `PATH`; deterministic integration validation uses the approved
  embedded PostgreSQL 18.4 server.
- US5 inspects controlled fixture state only. It uses no real provider credential, unrestricted
  shell, external network effect, remote Git mutation, or production mutation.
- The CLI accepts only a loopback HTTP endpoint, obtains its supervisor session from
  `MOONSHIFT_SESSION_COOKIE`, never exposes a cookie argument, and creates exports exclusively with
  owner-only mode `0600`.
- Result audit projection fails closed when a durable supervision audit record cannot be assigned to
  a unique compatible project-event carrier; it never fabricates an audit or evidence execution ID.
- Independent review drove repairs for complete material-action audit mapping, exact dual audit/event
  identity, terminal execution timing, durable reconnect hydration, working-directory-independent
  contract loading, strict CLI response validation, and PostgreSQL history coverage. The final fresh
  review reported no substantive findings.

## Exact next action

US5 is complete; stop here. T076 begins hardening and must remain untouched until the next explicitly
authorized bounded iteration.
