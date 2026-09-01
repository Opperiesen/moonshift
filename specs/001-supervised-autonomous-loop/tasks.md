# Tasks: Supervised Autonomous Loop

**Input**: Design documents in `specs/001-supervised-autonomous-loop/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), and the requirements-quality checklists

**Tests**: Tests are required by the specification. In each user-story phase, create the listed tests
first, confirm that they fail for the intended reason, then implement the behavior.

**Organization**: Tasks are grouped by user story so that each story can be implemented and accepted
as a bounded increment. Task completion requires the named deterministic evidence, not only source
changes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with adjacent tasks after its stated prerequisites because it owns
  different files and does not require an unresolved shared decision.
- **[Story]**: Maps the task to one user story (`US1`–`US5`). Setup, foundation, and cross-cutting
  tasks have no story label.
- Every task names its primary file or directory. A task may update generated snapshots or evidence
  adjacent to that primary path.

## Phase 1: Setup

**Purpose**: Establish the pinned, reproducible implementation workspace without creating any real
provider integration or production deployment path.

- [x] T001 Create the pnpm workspace and package scripts in `package.json` and `pnpm-workspace.yaml`, pinning the toolchain and dependency versions from `plan.md`
- [x] T002 [P] Configure shared strict TypeScript compilation in `tsconfig.json` and `config/typescript/tsconfig.base.json`
- [x] T003 [P] Configure formatting, linting, dependency-boundary checks, and secret scanning in `eslint.config.js`, `.prettierrc.json`, and `config/validation/`
- [x] T004 [P] Configure Vitest projects and deterministic clock/UUID helpers in `vitest.config.ts` and `packages/test-fixtures/src/determinism.ts`
- [x] T005 [P] Configure Playwright browser acceptance in `playwright.config.ts` and `tests/acceptance/fixtures.ts`
- [x] T006 Create the loopback-only local PostgreSQL 18 workflow and documented resource limits in `compose.yaml` and `.env.example`
- [x] T007 Create the controlled Git fixture and deterministic scenario data in `fixtures/supervised-loop-repository/` and `packages/test-fixtures/src/scenarios/`
- [x] T008 Add local CI-equivalent validation commands, lockfile-integrity checks, and test artifact paths in `.github/workflows/ci.yml` and `scripts/validate.mjs`

**Checkpoint**: A clean checkout can install from the lockfile, start only local test dependencies,
and run empty deterministic test suites without credentials or network effects.

---

## Phase 2: Foundational Domain and Boundaries

**Purpose**: Build the owned contracts, state rules, persistence primitives, and capability-minimal
execution boundaries that block every user story.

**Critical**: No user-story implementation begins until T009–T024 pass together.

- [x] T009 [P] Add executable Draft 2020-12 and vendored official OpenAPI 3.1 schema/example validation tests for every planning contract, including exact Project/Task/Execution/Presence enum parity, round-trip coverage for every PersonaIdentity and SpecialistIdentity lifecycle state, reloadable bounded PresenceView sources, descriptor ID/version fields, satisfiable lifecycle states, and rejection of unknown/prohibited backend-event fields, in `tests/contract/planning-contracts.test.ts`
- [x] T010 Compile Moonshift-owned validators, the mandatory kind-specific bounded observation sanitizer, and reproducible non-authoritative TypeScript derivatives from the approved schemas into `packages/contracts/src/`
- [x] T011 [P] Write exhaustive legal/illegal transition and actor-authority tests for Task, TaskDependency, Execution, Approval, Project, and ExternalEffect, including acyclic dependency graphs, the serialized pause-versus-verification boundary, and distinct pause/stop/cancel/completion races, in `packages/domain/src/state-machines.test.ts`
- [x] T012 Implement opaque identities, aggregates, immutable task dependencies, commands, and explicit state machines without framework/provider imports in `packages/domain/src/`
- [x] T013 [P] Write policy tests for organization ceilings, delegation subsets, cumulative runtime versus task deadline/lease expiry/termination/archive, budgets, lineage, and actor authority in `packages/policy/src/policy.test.ts`
- [x] T014 Implement versioned policy profiles, capability grants, and deny-by-default decisions in `packages/policy/src/`
- [x] T015 Create forward-only PostgreSQL migrations, checksums, constraints, and migration locking in `packages/persistence/src/migrations/`
- [x] T016 [P] Write real-PostgreSQL integration tests for optimistic concurrency, aggregate/audit/event/outbox atomicity, unique audit identities, idempotency, queue claims, leases, fencing, and proof that only sanitized event projections persist in `tests/integration/persistence.test.ts`
- [x] T017 Implement transaction, repository, idempotency, outbox, lease, and projection checkpoint adapters in `packages/persistence/src/`
- [x] T018 [P] Write artifact-store tests for atomic writes, hashing, ownership, size limits, traversal, tampering, and missing bytes in `packages/artifacts/src/artifact-store.test.ts`
- [x] T019 Implement the owner-local content-addressed artifact port and filesystem adapter in `packages/artifacts/src/`
- [x] T020 [P] Write context compiler tests proving explicit manifests, classification, token budgets, artifact references, and exclusion of raw chat/private reasoning in `packages/context/src/context-compiler.test.ts`
- [x] T021 Implement immutable context manifests and the minimized deterministic compiler in `packages/context/src/`
- [x] T022 [P] Write minimum-fake-boundary conformance tests for stable distinct backend/connection/model-descriptor identities, two per-connection conformance relations exposing one shared descriptor ID/version, exact descriptor provenance on start/resume/event/Execution, strict sanitized observations, identical two-connection outcomes, and runner tests for mutual-TLS identity binding, forged/replayed/revoked/plaintext rejection, result/lease/fence binding, resource discovery, and fail-closed eligibility in `tests/contract/execution-backend-conformance.test.ts` and `tests/integration/runner-authentication.test.ts`
- [x] T023 Implement only the slice 001 provider-neutral minimum port, one backend-scoped separately versioned fake model descriptor, two deterministic fake connections with distinct descriptor-availability/conformance relations, fixture health/capability probes, strict observations, and scripted checkpoints in `packages/backend-fake/src/`
- [x] T024 Implement the separate fixture-only runner daemon with owner-local per-instance TLS 1.3 mutual authentication, enrollment/revocation, identity/message/result binding, replay denial, resource/enforcement discovery, lease validation, fencing, one fixture-process job, denied network, zero GPU request, and no shell or provider credentials in `apps/runner/src/`

**Checkpoint**: Domain transition, policy, contract, persistence, artifact, context, fake-backend
conformance, and runner-boundary suites all pass against disposable PostgreSQL 18. This is the first
bounded `$speckit-implement` target together with Phase 1.

---

## Phase 3: User Story 1 — Start and Observe a Bounded Project (Priority: P1) MVP

**Goal**: Accept one objective, create the default council and bounded organization, delegate to one
specialist, run the deterministic fake backend, and project ordered activity to the browser.

**Independent Test**: From fresh storage, submit one valid objective and observe exactly one project,
Product/Engineering/Quality identities, a nested channel, a bounded task, one depth-one specialist,
one fake execution, and an ordered event stream; invalid input and exhausted capacity create no
partial organization.

### Tests for User Story 1

- [x] T025 [P] [US1] Add contract tests for one-time loopback session bootstrap, health, project create/read, event replay, idempotency, validation failures, unauthorized access, and optimistic concurrency in `tests/contract/projects-api.test.ts`
- [x] T026 [P] [US1] Add domain tests for default council creation, channel limits, delegation completeness/subsets, depth one, and specialist archival conditions in `packages/domain/src/project-organization.test.ts`
- [x] T027 [P] [US1] Add real-PostgreSQL journey tests for atomic project bootstrap, scheduling, routing, context compilation, fake execution, and durable event ordering in `tests/integration/start-observe.test.ts`
- [x] T028 [P] [US1] Add browser acceptance for valid and rejected objective flows, every defined presence state and bounded source, queue reasons, live/replayed observation, and expired-cursor ProjectView reload before resubscription in `tests/acceptance/start-observe.spec.ts`

### Implementation for User Story 1

- [x] T029 [US1] Implement objective submission, atomic project/default-council bootstrap, bounded channel create/archive and task creation, and complete delegation application services in `apps/control-plane/src/application/projects/`
- [x] T030 [US1] Implement auditable selection only between the two eligible fixture connection relations for the shared descriptor ID/version, independently retain connection and descriptor provenance, and implement cognitive/runner capacity queue reasons, runtime creation, context compilation, and fake execution scheduling in `apps/control-plane/src/scheduler/`
- [x] T031 [US1] Implement one-time loopback browser session bootstrap plus project command/query routes, idempotency/version handling, actor authorization, and typed errors in `apps/control-plane/src/http/`
- [x] T032 [US1] Implement durable project-sequenced events, complete durable-source presence projection in ProjectView, expired-cursor reset/reload, cursor replay, and SSE delivery in `apps/control-plane/src/projections/project-events.ts`
- [x] T033 [P] [US1] Implement Projects objective/status states and accessible validation feedback in `apps/web/src/features/projects/`
- [x] T034 [P] [US1] Implement Observe organization tree, presence, task/dependency summary, queue reason, activity stream, and reconnect states in `apps/web/src/features/observe/`
- [x] T035 [US1] Run the independent US1 tests and record contract, persistence, browser, and event-order evidence in `evidence/001-supervised-autonomous-loop/us1/manifest.json`

**Checkpoint**: US1 is demonstrable and independently accepted; it does not yet perform a sensitive
effect or claim verification.

---

## Phase 4: User Story 2 — Govern Sensitive and Stoppable Work (Priority: P2)

**Goal**: Make sensitive fixture effects approval-bound and provide durable supervisor controls that
cannot be bypassed or raced into unsafe behavior.

**Independent Test**: Seed or create a running specialist that requests one sensitive effect; prove
approve applies it once, reject/expiry/tampering does not apply it, and stop revokes later work at a
safe boundary.

### Tests for User Story 2

- [x] T036 [P] [US2] Add policy and domain tests for tool grants, immutable action digests, supervisor-only decisions, expiry, self-approval denial, budget exhaustion, the serialized in-flight verification pause boundary, and distinct pause/stop/cancel state, lease, approval, recovery, and idempotency semantics in `packages/policy/src/supervision.test.ts`
- [x] T037 [P] [US2] Add API contract tests for approval list/item ETag acquisition and concurrent decision plus pause, resume, cancel, and stop preconditions, idempotency, authorization, and conflict outcomes in `tests/contract/supervision-api.test.ts`
- [x] T038 [P] [US2] Add integration tests for approval-before-effect, concurrent decisions, tamper rejection, pause preservation, in-flight verification finishing only during PAUSING or becoming STALE before PAUSED, deferred Project completion until resume, stop revocation, terminal cancel, resume with fresh authority, and stop/cancel/completion races with auditable outcomes in `tests/integration/supervision.test.ts`
- [x] T039 [P] [US2] Add browser acceptance for approve, reject, expiry, pause/resume, recoverable stop/resume, terminal cancel, budget, and blocked states in `tests/acceptance/supervise.spec.ts`

### Implementation for User Story 2

- [x] T040 [US2] Implement capability and budget lease evaluation plus durable tool intent and action-digest approval creation in `apps/control-plane/src/application/supervision/tool-policy.ts`
- [x] T041 [US2] Implement supervisor approval decisions, expiry handling, and the specified versioned pause/resume/stop/cancel transitions, including no-new-evaluation PAUSING interlock, bounded in-flight evaluation drain-or-stale behavior, successor-execution recovery, safe effect boundaries, approval disposition, and capability/runner revocation in `apps/control-plane/src/application/supervision/commands.ts`
- [x] T042 [US2] Implement approval and control HTTP routes with actor checks, expected versions, and idempotency in `apps/control-plane/src/http/supervision.ts`
- [x] T043 [US2] Implement runner-side approved fixture effect execution and queryable effect ledger in `apps/runner/src/fixture/effects.ts`
- [x] T044 [P] [US2] Implement Supervise approval detail, immutable action preview, capacity/budget display, and control feedback in `apps/web/src/features/supervise/`
- [x] T045 [US2] Emit and project exactly-once attributable policy, approval, control, tool-intent, attempt, and effect-result audit events in `apps/control-plane/src/projections/supervision-events.ts`
- [ ] T046 [US2] Run the independent US2 tests and record approval, effect-ledger, stop-race, and audit evidence in `evidence/001-supervised-autonomous-loop/us2/manifest.json`

**Checkpoint**: US2 is independently accepted; no sensitive fixture effect can precede a valid
supervisor decision or survive revoked authority.

---

## Phase 5: User Story 3 — Verify Claims with Independent Evidence (Priority: P3)

**Goal**: Separate claimed completion from verified completion through revision-bound artifacts,
deterministic evidence, and an independent Quality lineage.

**Independent Test**: Run passing, failing, tampered, wrong-revision, and same-lineage fixtures; only
the passing artifact reviewed outside the author lineage reaches `VERIFIED`.

### Tests for User Story 3

- [ ] T047 [P] [US3] Add verification rule-matrix tests for claim, reviewer lineage, immutable evidence snapshots, revision binding, tampering, blocking reasons, stale-on-policy/revision/membership/hash change, and pause serialization proving no VERIFIED commit after PAUSED with mandatory reevaluation after resume in `packages/verification/src/verification-engine.test.ts`
- [ ] T048 [P] [US3] Add artifact/evidence persistence tests for attribution, integrity address, expected revision, evaluation snapshot compare-and-commit, stale disposition, and fresh reevaluation in `tests/integration/verification.test.ts`
- [ ] T049 [P] [US3] Add API and projection contract tests for results, verification event payloads, exact ExecutionState parity, descriptor ID/version provenance, and SUSPENDED/STOPPING/STOPPED rendering in `tests/contract/results-api.test.ts`
- [ ] T050 [P] [US3] Add browser acceptance for passing, failing, unverified, wrong-lineage, and tampered evidence states in `tests/acceptance/verification.spec.ts`

### Implementation for User Story 3

- [ ] T051 [US3] Implement artifact publication and completion-claim commands that stop at `CLAIMED_COMPLETE` in `apps/control-plane/src/application/verification/claims.ts`
- [ ] T052 [US3] Implement independent Quality assignment with author-lineage exclusion and a separate context manifest in `apps/control-plane/src/application/verification/review-routing.ts`
- [ ] T053 [US3] Implement versioned deterministic verification rules, immutable evaluation snapshots, stale-on-change compare-and-commit, Project-state serialization that forbids commit after PAUSED, fresh reevaluation after resume, and sole authority for `VERIFIED` in `packages/verification/src/`
- [ ] T054 [US3] Persist artifacts, evidence, verification policy/rules/evaluations, and revision bindings transactionally in `packages/persistence/src/repositories/verification.ts`
- [ ] T055 [US3] Implement result queries and verification event projections without completion inflation in `apps/control-plane/src/projections/results.ts`
- [ ] T056 [P] [US3] Implement Results artifact and evidence matrix states with explicit reviewer lineage and blocking reasons in `apps/web/src/features/results/`
- [ ] T057 [US3] Run the independent US3 tests and record passing/failing rule matrices, artifact hashes, revision, and Quality lineage in `evidence/001-supervised-autonomous-loop/us3/manifest.json`

**Checkpoint**: US3 is independently accepted; a specialist claim alone is never displayed or stored
as verified completion.

---

## Phase 6: User Story 4 — Recover Without Losing or Duplicating Work (Priority: P4)

**Goal**: Survive restart and runtime loss, reconcile uncertain effects, and continue the same logical
identity on the second fake backend from an owned checkpoint.

**Independent Test**: Interrupt every durable boundary around the fixture effect, restart or replace
the runtime, and prove stable identities, complete state, at-most-once effect, and safe blocking when
ground truth remains unknown.

### Tests for User Story 4

- [ ] T058 [P] [US4] Add checkpoint compatibility, completeness, hash, and backend-neutrality contract tests in `tests/contract/checkpoint.test.ts`
- [ ] T059 [P] [US4] Add crash-matrix integration tests before/during/after effect and outbox boundaries in `tests/recovery/effect-crash-matrix.test.ts`
- [ ] T060 [P] [US4] Add restart, lease-expiry, stale-fencing, missing/corrupt checkpoint, and unknown-outcome tests in `tests/recovery/runtime-recovery.test.ts`
- [ ] T061 [P] [US4] Add cross-backend continuation tests proving stable specialist/task identities and no duplicated normalized work in `tests/recovery/backend-switch.test.ts`
- [ ] T062 [P] [US4] Add browser acceptance for pause/restart/reconnect, recovery progress, switched backend, and actionable blocked state in `tests/acceptance/recovery.spec.ts`

### Implementation for User Story 4

- [ ] T063 [US4] Implement versioned provider-neutral checkpoint creation, validation, and compatibility handling in `apps/control-plane/src/application/recovery/checkpoints.ts`
- [ ] T064 [US4] Implement heartbeat loss detection, monotonic fencing, lease expiry, and stale-runtime rejection in `apps/control-plane/src/scheduler/recovery.ts`
- [ ] T065 [US4] Implement effect ground-truth reconciliation and bounded `UNKNOWN` blocking semantics in `apps/control-plane/src/application/recovery/reconciliation.ts`
- [ ] T066 [US4] Implement startup reconstruction, projection catch-up, durable queue resumption, and safe paused-state restoration in `apps/control-plane/src/bootstrap/recovery.ts`
- [ ] T067 [US4] Implement capability-compatible route selection and continuation on the second fake connection from a compiled checkpoint in `apps/control-plane/src/scheduler/backend-switch.ts`
- [ ] T068 [US4] Run the independent US4 crash/restart/switch tests and record boundary, fencing, reconciliation, identity, and effect-ledger evidence in `evidence/001-supervised-autonomous-loop/us4/manifest.json`

**Checkpoint**: US4 is independently accepted; interruption cannot erase authoritative state or
blindly duplicate an uncertain effect.

---

## Phase 7: User Story 5 — Inspect a Complete Result and Audit Trail (Priority: P5)

**Goal**: Present one coherent result surface for actual task state, provenance, supervision,
execution, recovery, and audit history after live delivery or replay.

**Independent Test**: Open verified and non-verified fixture results after reconnect; every required
record is consistently linked and ordered, and no failed/blocked/cancelled state is presented as done.

### Tests for User Story 5

- [ ] T069 [P] [US5] Add result-projection integration tests for stable links, complete connection/model ID/version provenance, exact ExecutionState parity, replay order, expired-cursor ProjectView presence reload, and suspended/stopping/stopped/unverified/failed/cancelled state truthfulness in `tests/integration/result-projection.test.ts`
- [ ] T070 [P] [US5] Add end-to-end browser acceptance for the complete Results surface after reconnect and projection reload in `tests/acceptance/results-audit.spec.ts`

### Implementation for User Story 5

- [ ] T071 [US5] Implement the complete result read model linking task, artifact, evidence, approvals, executions, checkpoints, effects, organization, and audit records in `apps/control-plane/src/projections/result-detail.ts`
- [ ] T072 [US5] Implement cursor-expiry fallback and client-side event deduplication/projection refresh in `apps/web/src/services/project-events.ts`
- [ ] T073 [US5] Complete the accessible Results audit timeline, execution/checkpoint history, approval history, and real terminal-state summaries in `apps/web/src/features/results/`
- [ ] T074 [US5] Add the CLI project inspection/export command using the same read contract in `apps/cli/src/commands/project-inspect.ts`
- [ ] T075 [US5] Run the independent US5 tests and record linked-record, ordering, reconnect, accessibility, and state-truthfulness evidence in `evidence/001-supervised-autonomous-loop/us5/manifest.json`

**Checkpoint**: All five stories are independently accepted and compose into the reference browser
journey without relying on ephemeral backend or browser state.

---

## Phase 8: Hardening, Capacity, Recovery, and Release Evidence

**Purpose**: Prove the full slice against its constitutional ceilings and publish a reproducible
evaluation bundle. These tasks do not add roadmap scope or real provider support.

- [ ] T076 [P] Add negative security tests for grant escalation, child spawning, self-approval, digest replay, same-lineage review, forged/replayed/revoked/plaintext runner traffic, unauthorized events, raw prompts/transcripts, credential/authorization/private-key/private-reasoning fields, absolute/traversal paths, unknown/nested fields, oversize, tampering, and stale fencing in `tests/security/security-boundaries.test.ts`
- [ ] T077 [P] Add clean/previous-schema migration and consistent backup/restore tests for PostgreSQL, artifacts, configuration references, contract hashes, and projection rebuild in `tests/recovery/backup-restore.test.ts`
- [ ] T078 [P] Add one/three/five cognitive execution capacity scenarios and metric assertions for event visibility, command durability, queue reasons, PostgreSQL, memory, runner lease/resources, outbox lag, restart, backup/restore storage high-water marks, and restore scheduling downtime in `tests/performance/reference-capacity.test.ts`
- [ ] T079 Add process and runner resource/enforcement/discovery instrumentation plus the 16 GB Proxmox VE fixture evaluation profile and fail-closed eligibility rules in `config/observability/` and `deploy/evaluation/`
- [ ] T080 Run unit, contract, PostgreSQL integration, runner-process, browser, crash-matrix, security, migration, restore, and capacity suites and consolidate machine-readable results in `evidence/001-supervised-autonomous-loop/full/test-manifest.json`
- [ ] T081 Validate the complete reference journey and failure exercises from `specs/001-supervised-autonomous-loop/quickstart.md`, recording exact commands and outcomes in `evidence/001-supervised-autonomous-loop/full/quickstart.json`
- [ ] T082 Generate the final evidence bundle with Git revision, migration version, contract hashes, policy/persona versions, artifact hashes, Quality review, runner authentication/resource probes, performance and backup/restore storage/downtime metrics, unresolved findings, and provenance in `evidence/001-supervised-autonomous-loop/full/manifest.json`
- [ ] T083 [P] Document implementation-local setup, architecture conformance, backup/restore, limitations, and fixture-only security posture in `README.md`, `SECURITY.md`, and `docs/operations/`
- [ ] T084 Run `$speckit-converge`, remediate every critical/high gap and any appended task, and update `specs/001-supervised-autonomous-loop/tasks.md` only after the corresponding evidence passes
- [ ] T085 Perform independent read-only regression, contract, security, and scope review of the final diff and record dispositions in `evidence/001-supervised-autonomous-loop/full/review.json`
- [ ] T086 Verify all required checklists, repository-native validation, reproducible clean-checkout setup, and absence of real provider/user credentials, providers, shell, or deployment behavior, recording the gate in `evidence/001-supervised-autonomous-loop/full/final-validation.json` before creating the feature completion commit

**Final checkpoint**: The slice may be called complete only when every required task and checklist is
closed with revision-bound evidence and convergence reports no missing behavior.

---

## Dependencies and Execution Order

### Phase dependencies

- **Setup (T001–T008)** has no predecessor and is the first implementation boundary.
- **Foundation (T009–T024)** depends on Setup and blocks all user stories.
- **US1 (T025–T035)** depends on Foundation and establishes the default end-to-end path.
- **US2 (T036–T046)** depends on Foundation; its independent test may seed a running specialist, but
  the composed reference journey follows US1.
- **US3 (T047–T057)** depends on Foundation; its independent test may seed claimed work, while the
  composed journey follows US1 and US2.
- **US4 (T058–T068)** depends on Foundation and the effect/checkpoint fixtures. The composed journey
  follows US1–US3.
- **US5 (T069–T075)** depends on the read contracts from Foundation; its complete audit projection is
  accepted after US1–US4 produce all record types.
- **Hardening (T076–T086)** depends on all five selected stories.

### Within each phase

1. Create the listed tests and confirm that they fail for the intended missing behavior.
2. Implement domain/policy rules before application orchestration.
3. Implement persistence and service behavior before HTTP, projections, and UI.
4. Run the independent story suite and commit its evidence before crossing the checkpoint.
5. Do not mark a task complete from source inspection alone when the task names executable evidence.

### Parallel opportunities

- In Setup, T002–T005 and T007 can proceed in parallel after T001 fixes workspace names.
- In Foundation, contract, domain, policy, artifact, context, and fake-backend test tasks marked `[P]`
  can proceed independently; their implementations must integrate through owned contracts.
- Within a story, test tasks marked `[P]` own distinct layers and may proceed together.
- US2–US4 may be developed in parallel only after Foundation if each uses deterministic seeded state;
  US5 and the composed journey still integrate their outputs in priority order.
- T076–T078 and T083 can proceed in parallel after the story checkpoints; T080–T086 remain ordered
  integration gates.

## Requirements Traceability

Every normative requirement and measurable outcome has at least one implementation task and one
verification or evidence task. Story acceptance scenarios are covered by the tests and checkpoint
manifest for their corresponding phase.

| Requirement | Primary implementation tasks | Verification/evidence tasks |
|---|---|---|
| FR-001 | `T029`, `T031`, `T033` | `T025`, `T027`, `T028`, `T035` |
| FR-002 | `T029`, `T031`, `T033` | `T025`, `T027`, `T028` |
| FR-003 | `T012`, `T029` | `T026`, `T027`, `T028` |
| FR-004 | `T014`, `T029` | `T013`, `T026`, `T078` |
| FR-005 | `T012`, `T029`, `T034` | `T026`, `T028` |
| FR-006 | `T021`, `T032`, `T034` | `T020`, `T027`, `T028` |
| FR-007 | `T012`, `T014`, `T029` | `T013`, `T026`, `T027` |
| FR-008 | `T014`, `T029`, `T030` | `T013`, `T026`, `T027`, `T076` |
| FR-009 | `T007`, `T023`, `T024` | `T022`, `T076`, `T086` |
| FR-010 | `T004`, `T007`, `T023` | `T022`, `T027` |
| FR-011 | `T010`, `T012`, `T023`, `T030` | `T009`, `T011`, `T022`, `T027` |
| FR-012 | `T032`, `T034` | `T028`, `T035` |
| FR-013 | `T010`, `T017`, `T021`, `T032`, `T034` | `T009`, `T016`, `T020`, `T028`, `T076` |
| FR-014 | `T014`, `T030`, `T034` | `T013`, `T027`, `T078` |
| FR-015 | `T014`, `T040`, `T043` | `T036`, `T038`, `T076` |
| FR-016 | `T040`, `T041` | `T036`, `T037`, `T038`, `T039` |
| FR-017 | `T041`, `T042`, `T043` | `T036`, `T037`, `T038`, `T076` |
| FR-018 | `T017`, `T045` | `T016`, `T038`, `T046` |
| FR-019 | `T012`, `T041`, `T042`, `T044` | `T011`, `T036`, `T037`, `T038`, `T039` |
| FR-020 | `T014`, `T041`, `T052`, `T053` | `T013`, `T036`, `T047`, `T076` |
| FR-021 | `T012`, `T015`, `T017` | `T011`, `T016`, `T059`, `T060` |
| FR-022 | `T051`, `T053` | `T047`, `T050`, `T057` |
| FR-023 | `T017`, `T040`, `T043`, `T065` | `T016`, `T038`, `T059`, `T060` |
| FR-024 | `T017`, `T029`, `T041`, `T045` | `T016`, `T025`, `T037`, `T038`, `T059` |
| FR-025 | `T015`, `T017`, `T019`, `T066` | `T016`, `T060`, `T069`, `T077` |
| FR-026 | `T063`, `T064`, `T065`, `T067` | `T059`, `T060`, `T061`, `T062` |
| FR-027 | `T021`, `T063` | `T020`, `T058`, `T060` |
| FR-028 | `T023`, `T063`, `T067` | `T022`, `T061`, `T068` |
| FR-029 | `T012`, `T063`, `T067` | `T011`, `T058`, `T061` |
| FR-030 | `T019`, `T051`, `T054` | `T018`, `T048`, `T050` |
| FR-031 | `T052`, `T053` | `T047`, `T050`, `T057` |
| FR-032 | `T053`, `T054` | `T047`, `T048`, `T050` |
| FR-033 | `T053`, `T055`, `T056` | `T047`, `T048`, `T050`, `T057` |
| FR-034 | `T055`, `T071`, `T073` | `T049`, `T069`, `T070`, `T075` |
| FR-035 | `T032`, `T072` | `T025`, `T028`, `T069`, `T070` |
| FR-036 | `T017`, `T030`, `T045`, `T055`, `T071` | `T016`, `T027`, `T038`, `T069`, `T080` |
| FR-037 | `T006`, `T008`, `T033`, `T034`, `T044`, `T056`, `T073` | `T080`, `T081`, `T082` |
| FR-038 | `T012`–`T024`, `T029`–`T075` | `T080`, `T081`, `T082` |
| FR-039 | `T023`, `T024` | `T076`, `T083`, `T086` |
| FR-040 | `T014`, `T024`, `T030`, `T079` | `T013`, `T022`, `T078`, `T080` |
| FR-041 | `T021`, `T063` | `T020`, `T027`, `T058`, `T076` |
| FR-042 | `T008`, `T029`–`T075` | `T080`, `T081`, `T082` |
| SC-001 | `T001`–`T075` | `T080`, `T081`, `T082` |
| SC-002 | `T043`, `T064`, `T065` | `T059`, `T060`, `T068`, `T080` |
| SC-003 | `T017`, `T029`, `T041`, `T045` | `T016`, `T025`, `T037`, `T038`, `T059`, `T080` |
| SC-004 | `T051`, `T052`, `T053`, `T054` | `T047`, `T048`, `T050`, `T057` |
| SC-005 | `T063`, `T067` | `T058`, `T061`, `T068` |
| SC-006 | `T030`, `T032`, `T079` | `T078`, `T080`, `T082` |
| SC-007 | `T031`, `T042`, `T045` | `T025`, `T037`, `T038`, `T078` |
| SC-008 | `T066`, `T071` | `T060`, `T069`, `T078` |
| SC-009 | `T010`, `T014`, `T024`, `T041`, `T052` | `T009`, `T013`, `T022`, `T036`, `T047`, `T076` |
| SC-010 | `T017`, `T030`, `T045`, `T055`, `T071` | `T016`, `T038`, `T069`, `T080` |
| SC-011 | `T055`, `T071`, `T073` | `T049`, `T050`, `T069`, `T070` |
| SC-012 | `T006`, `T024`, `T079` | `T022`, `T077`, `T078`, `T080`, `T082` |

## Implementation Strategy

### First bounded `$speckit-implement` phase

Implement **T001–T024 only**. Stop at the Foundation checkpoint and provide:

- pinned clean-checkout toolchain evidence;
- executable contract and domain conformance reports;
- real PostgreSQL migration/persistence evidence;
- policy, artifact, context, strict observation-sanitizer, fake-backend, and authenticated
  fixture-runner boundary evidence;
- a diff proving no real provider, provider/user credential, unrestricted shell, or production
  deployment was introduced; owner-local runner certificates remain confined to generated test state.

Do not begin US1 until that checkpoint is reviewed and accepted.

### Incremental vertical delivery

After the foundation gate, implement one story phase at a time in priority order, run its independent
test, inspect its evidence manifest, and stop at its checkpoint. Hardening proves the composed slice;
it is not a reason to defer story-specific correctness.

## Task Summary

| Phase | Tasks | Parallel-marked | Exit evidence |
|---|---:|---:|---|
| Setup | 8 | 5 | Reproducible local workspace |
| Foundation | 16 | 7 | Boundary and persistence suites |
| US1 | 11 | 6 | Start/observe manifest |
| US2 | 11 | 5 | Supervision/effect manifest |
| US3 | 11 | 5 | Verification manifest |
| US4 | 11 | 5 | Recovery/switch manifest |
| US5 | 7 | 2 | Result/audit manifest |
| Hardening | 11 | 4 | Full revision-bound evidence bundle |
| **Total** | **86** | **39** | **Converged supervised loop** |
