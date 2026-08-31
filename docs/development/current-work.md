# Current Moonshift Work

- Active feature: `001-supervised-autonomous-loop`
- Allowed task range: `T001–T024`
- Checkpoint: `Foundation`
- Status: `FOUNDATION_COMPLETE`
- Branch: `main`
- Foundation base: `be12d4b936f799b6ba5a21bd9f456d27b761b455` (Iteration 0 checkpoint)
- Foundation checkpoint: `857f0f9b0221` (`feat: establish supervised autonomy foundation`)
- Worktree: clean after local Foundation checkpoint
- Last updated: `2026-08-31T20:50:15Z`

## Completed tasks

`T001–T024` — pinned workspace and validation, executable planning contracts, domain and policy
foundations, PostgreSQL 18 persistence, owner-local artifacts, minimized context compilation, two
conformant fake connections, and a capability-minimal loopback mutual-TLS fixture runner.

## First incomplete task

`T025` — project API contract tests. This is intentionally outside the current implementation scope;
do not start it until the next bounded iteration is explicitly authorized.

## Principal files changed

- `AGENTS.md` and `docs/development/` — cross-session bootstrap, resume, fork, and handoff protocol
- root workspace/configuration, `config/validation/`, `.github/workflows/ci.yml`, and `scripts/`
- `packages/contracts/`, `packages/domain/`, `packages/policy/`, and `packages/persistence/`
- `packages/artifacts/`, `packages/context/`, `packages/backend-fake/`, and `packages/test-fixtures/`
- `apps/runner/`, `tests/contract/`, `tests/integration/`, `tests/acceptance/`, and controlled fixtures
- `specs/001-supervised-autonomous-loop/tasks.md` — T001–T024 checked only after validation

## Verification evidence

| Command                                            | Result | Notes                                                                                                                       |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Startup repository/Spec Kit/checklist audit        | PASS   | Clean `main`, Spec Kit `1.0.1`, 138/138 actual entries across nine files (16 built-in + 122 custom; prose markers excluded) |
| Pinned `pnpm install --frozen-lockfile --offline`  | PASS   | Node `v24.20.0`, pnpm `11.24.0`, lockfile supply-chain policy passed                                                        |
| `node scripts/generate-contract-types.mjs --check` | PASS   | Generated contract types reproduce from the approved OpenAPI source                                                         |
| `pnpm clean && pnpm validate`                      | PASS   | Format, lint/boundaries, lockfile/image pins, secret scan, clean typecheck, 57 unit, 49 contract, and 53 integration tests  |
| PostgreSQL integration fixture                     | PASS   | Actual PostgreSQL `18.4`; migrations, transactions, idempotency, queue claims, leases/fencing, projections                  |
| Runner integration fixture                         | PASS   | TLS 1.3 mTLS, enrollment/revocation, identity/replay/plaintext/stale-fence denial, resource eligibility                     |
| `pnpm test:acceptance`                             | PASS   | One foundation configuration smoke test; no application/user-story behavior started                                         |
| `git diff --check`                                 | PASS   | No whitespace errors                                                                                                        |
| Foundation task marker scan                        | PASS   | Exactly 24 of 24 T001–T024 tasks checked; T025 remains unchecked                                                            |

## Open findings

- The host exposes Node.js `26.7.0` and pnpm `11.19.0`; all validation must continue through the
  pinned Node.js `24.20.0` and pnpm `11.24.0` wrapper.
- `docker` and `psql` are not on `PATH`; deterministic integration validation uses the approved
  embedded PostgreSQL 18.4 server. The loopback Compose workflow remains available for equipped hosts
  and pins the official PostgreSQL 18 OCI index by immutable digest.
- Slice 001 deliberately provides no real provider, provider/user credential, arbitrary shell,
  unrestricted network, production deployment, or license decision.
- Independent review rounds exposed and drove repairs for runner process isolation, durable replay
  and revocation state, fake-scenario distinctness, atomic idempotency, recoverable claims, strict
  contract and policy bounds/time formats, durable lease-bound ExternalEffect fencing, artifact
  identity/provenance, comprehensive text-file secret scanning, durable Runner disable/reactivation,
  daemon-wide fail-closed handling for uncertain journal durability, and descriptor-based owner-local
  TLS material validation with directory-identity race detection. The final repair also made the
  configured secret patterns catch prefixed environment names and applied the same trusted-ancestry,
  pinned-inode discipline to the durable runner journal and owner-local artifact store. Binary files
  containing NUL bytes, UTF-16LE, and UTF-16BE are scanned rather than silently excluded. Durable
  effects reject reuse under a different execution, lease, or fencing token. Runner-protocol fencing
  tokens now fail closed at JavaScript's exact-integer ceiling across contracts, journals, registries,
  and PostgreSQL allocation, while runner startup verifies that its server certificate carries the
  one configured runner URI identity before creating durable state.

## Exact next action

The Foundation checkpoint is complete; stop here. T025 starts the project API/user-story
implementation and is the first task of the next explicitly authorized bounded iteration; do not
start it as Foundation follow-up work.
